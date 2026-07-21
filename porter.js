// porter.js — doorman for localhost apps. Zero dependencies.
//
// For every app in porter.config.json, porter listens on the app's public
// port. First incoming connection spawns the real server (hidden) on its
// upstream port and pipes bytes between them (raw TCP, so HTTP, websockets,
// SSE all just work). When every connection has been closed for idleMinutes,
// the server is killed. Closing the browser tab ends its sockets/polling, so
// the app dies a few minutes later; visiting the URL again resurrects it.
//
// Reaping is by idle connections, not by an open tab: a tab that isn't holding
// a socket (backgrounded, or only polling when visible) doesn't count. An app
// doing background work with no browser attached can stay alive by pinging
// GET /_porter/keepalive on its own public port every so often — porter answers
// that itself (204, no proxy) and resets the idle countdown.
//
// Apps must honor PORT from the environment (porter sets PORT=upstreamPort).
// Porter also sets PUBLIC_PORT (the public door) and PORTER_APP (the name) so
// an app can reach its own door — e.g. to send the keepalive above.
//
// run: node porter.js          (install-startup.ps1 registers it at login)
import net from 'node:net';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'porter.config.json');
const LOG_PATH = path.join(__dirname, 'porter.log');
const LOG_MAX_BYTES = 512 * 1024;

const SPAWN_TIMEOUT_MS = 20_000;   // max wait for an app to start accepting
const CONNECT_RETRY_MS = 250;
const MANIFEST_NAME = 'porter.app.json';

// diagnostics — cheap, bounded, zero-dependency (see sysSnapshot / startLagSensor)
const SLOW_SPAWN_MS = 3_000;          // spawns at/over this get a context snapshot
const LAG_SAMPLE_MS = 1_000;          // event-loop-lag sensor tick
const LAG_LOG_MS = 500;               // report machine stalls at least this long
const STALL_LOG_THROTTLE_MS = 10_000; // at most one stall line per this window

// A GET to this path on any door is answered by porter itself (204, no proxy)
// and resets the idle countdown. It lets a backgrounded app with no browser
// attached keep itself alive. See routeAppConnection / answerKeepalive.
const KEEPALIVE_PATH = '/_porter/keepalive';
// How long to peek the first chunk for a keepalive request line before giving
// up and piping raw. Real web clients (HTTP, ws, SSE) speak first, so this
// fires in about a millisecond; the timeout only matters for the rare app that
// expects the server to greet first, which we then pipe unchanged.
const PEEK_MS = 250;

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  process.stdout.write(line);
  try {
    if (fs.existsSync(LOG_PATH) && fs.statSync(LOG_PATH).size > LOG_MAX_BYTES) {
      fs.renameSync(LOG_PATH, LOG_PATH + '.old');
    }
    fs.appendFileSync(LOG_PATH, line);
  } catch { /* logging must never kill the porter */ }
}

// --- diagnostics ---------------------------------------------------------
// Everything here reuses the bounded log() above (512KB + one .old, ~1MB cap —
// no new growth path) and writes only on discrete events (a spawn, an odd exit,
// a machine stall), never per request. The aim is a forensic trail for failure
// modes we can't foresee, without a heavy or ever-growing debug log.

// Worst event-loop lag seen since the last read. Porter is single-threaded, so
// when the whole machine is starved of CPU (a game launching, a backup kicking
// off, anything) porter's own loop fires late — a zero-cost proxy for
// machine-wide contention. Read-and-reset so a snapshot reflects the recent
// window.
let peakLagMs = 0;
function sysSnapshot() {
  const freePct = Math.round((os.freemem() / os.totalmem()) * 100);
  const lag = Math.round(peakLagMs);
  peakLagMs = 0;
  return `mem ${freePct}% free, peak loop-lag ${lag}ms`;
}

// One timer, a subtraction per tick. Logs only when a stall crosses the
// threshold, throttled so sustained lag can't spam the log. A hard freeze shows
// up as a single big-lag sample (queued ticks coalesce), so its full duration
// lands in one line.
function startLagSensor() {
  let expected = Date.now() + LAG_SAMPLE_MS;
  let lastLog = 0;
  const timer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    expected = now + LAG_SAMPLE_MS;
    if (lag > peakLagMs) peakLagMs = lag;
    if (lag >= LAG_LOG_MS && now - lastLog >= STALL_LOG_THROTTLE_MS) {
      lastLog = now;
      const freePct = Math.round((os.freemem() / os.totalmem()) * 100);
      log(`[watchdog] machine stall — event loop lagged ${Math.round(lag)}ms (mem ${freePct}% free)`);
    }
  }, LAG_SAMPLE_MS);
  timer.unref?.();
}

function normalizeApp(raw, idleMinutes, manifestPath = null) {
  const name = String(raw.name || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
    throw new Error(`invalid app name "${raw.name || ''}"`);
  }
  const port = Number(raw.port);
  const upstreamPort = Number(raw.upstreamPort ?? port + 10000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${name}: port must be an integer from 1 to 65535`);
  }
  if (!Number.isInteger(upstreamPort) || upstreamPort < 1 || upstreamPort > 65535) {
    throw new Error(`${name}: upstreamPort must be an integer from 1 to 65535`);
  }
  if (port === upstreamPort) {
    throw new Error(`${name}: port and upstreamPort must differ`);
  }
  if (typeof raw.cmd !== 'string' || !raw.cmd.trim()) {
    throw new Error(`${name}: cmd is required`);
  }
  if (raw.args !== undefined && (!Array.isArray(raw.args) || raw.args.some(arg => typeof arg !== 'string'))) {
    throw new Error(`${name}: args must be an array of strings`);
  }
  const cwd = manifestPath
    ? path.dirname(manifestPath)
    : String(raw.cwd || '').trim();
  if (!cwd) throw new Error(`${name}: cwd is required`);
  const env = raw.env ?? {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error(`${name}: env must be an object`);
  }
  const appIdleMinutes = Number(raw.idleMinutes ?? idleMinutes);
  if (!Number.isFinite(appIdleMinutes) || appIdleMinutes < 0) {
    throw new Error(`${name}: idleMinutes must be zero or greater`);
  }
  return {
    name,
    port,
    upstreamPort,
    cmd: raw.cmd,
    args: raw.args || [],
    cwd,
    env: Object.fromEntries(
      Object.entries(env).map(([key, value]) => [key, String(value)]),
    ),
    idleMs: appIdleMinutes * 60_000,
    manifestPath,
    // runtime state
    child: null,
    starting: null,
    sockets: new Set(),
    idleTimer: null,
    door: null,
  };
}

function manifestFiles(root) {
  const files = [];
  const rootManifest = path.join(root, MANIFEST_NAME);
  if (fs.existsSync(rootManifest)) files.push(rootManifest);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (err) {
    log(`[manifest] cannot scan ${root}: ${err.message}`);
    return files;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifest = path.join(root, entry.name, MANIFEST_NAME);
    if (fs.existsSync(manifest)) files.push(manifest);
  }
  return files;
}

function discoverManifestApps(roots, idleMinutes) {
  const apps = [];
  for (const root of roots) {
    for (const manifestPath of manifestFiles(root)) {
      try {
        const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (raw.enabled === false) continue;
        apps.push(normalizeApp(raw, idleMinutes, manifestPath));
      } catch (err) {
        log(`[manifest] skipped ${manifestPath}: ${err.message}`);
      }
    }
  }
  return apps;
}

function addUniqueApp(apps, app) {
  const conflict = apps.find(existing =>
    existing.name === app.name
    || [existing.port, existing.upstreamPort].includes(app.port)
    || [existing.port, existing.upstreamPort].includes(app.upstreamPort)
  );
  if (!conflict) {
    apps.push(app);
    return true;
  }
  const source = app.manifestPath || 'porter.config.json';
  log(
    `[${app.name}] skipped ${source}: conflicts with ${conflict.name} `
    + `(${conflict.port}->${conflict.upstreamPort})`,
  );
  return false;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    const example = path.join(__dirname, 'porter.config.example.json');
    if (fs.existsSync(example)) fs.copyFileSync(example, CONFIG_PATH);
  }
  const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const idleMinutes = raw.idleMinutes ?? 10;
  // namePort: the shared door that routes http://<name>.localhost/ by Host
  // header. Set to false in the config to disable.
  const namePort = raw.namePort === false ? null : (raw.namePort ?? 80);
  const manifestRoots = (raw.manifestRoots || []).map(root =>
    path.resolve(__dirname, root)
  );
  const manifestScanSeconds = Number(raw.manifestScanSeconds ?? 10);
  if (!Number.isFinite(manifestScanSeconds) || manifestScanSeconds < 1) {
    throw new Error('manifestScanSeconds must be at least 1');
  }
  const apps = [];
  for (const rawApp of raw.apps || []) {
    addUniqueApp(apps, normalizeApp(rawApp, idleMinutes));
  }
  for (const app of discoverManifestApps(manifestRoots, idleMinutes)) {
    addUniqueApp(apps, app);
  }
  return {
    apps,
    namePort,
    idleMinutes,
    manifestRoots,
    manifestScanMs: manifestScanSeconds * 1000,
  };
}

function childAlive(app) {
  return app.child !== null && app.child.exitCode === null && !app.child.killed;
}

function tryConnect(port) {
  return new Promise((resolve, reject) => {
    const s = net.connect({ port, host: '127.0.0.1' });
    s.once('connect', () => resolve(s));
    s.once('error', err => reject(err));
  });
}

async function waitForUpstream(app) {
  const deadline = Date.now() + SPAWN_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      return await tryConnect(app.upstreamPort);
    } catch {
      if (!childAlive(app)) throw new Error(`${app.name}: process exited during startup`);
      await new Promise(r => setTimeout(r, CONNECT_RETRY_MS));
    }
  }
  throw new Error(`${app.name}: not accepting on :${app.upstreamPort} after ${SPAWN_TIMEOUT_MS / 1000}s [${sysSnapshot()}]`);
}

function startChild(app) {
  if (app.starting) return app.starting;
  if (childAlive(app)) return Promise.resolve();
  const starting = (async () => {
    log(`[${app.name}] spawning: ${app.cmd} ${app.args.join(' ')} (PORT=${app.upstreamPort})`);
    // child stdout/stderr go to logs/<name>.log — 'ignore' made every child
    // failure invisible (every child crash vanished without this)
    let childStdio = 'ignore';
    try {
      const logDir = path.join(__dirname, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const childLog = path.join(logDir, `${app.name}.log`);
      if (fs.existsSync(childLog) && fs.statSync(childLog).size > LOG_MAX_BYTES) {
        fs.renameSync(childLog, childLog + '.old');
      }
      const fd = fs.openSync(childLog, 'a');
      childStdio = ['ignore', fd, fd];
    } catch { /* fall back to ignore — logging must never block a spawn */ }
    const t0 = Date.now();
    let tSpawned = 0;   // when the OS actually created the process ('spawn' event)
    app.child = spawn(app.cmd, app.args, {
      cwd: app.cwd,
      env: { ...process.env, ...app.env, PORT: String(app.upstreamPort), PUBLIC_PORT: String(app.port), PORTER_APP: app.name },
      windowsHide: true,
      stdio: childStdio,
      detached: false,
    });
    const child = app.child;
    child.once('spawn', () => { tSpawned = Date.now(); child.__spawnedAt = tSpawned; });
    if (Array.isArray(childStdio)) {
      child.on('exit', () => { try { fs.closeSync(childStdio[1]); } catch { } });
    }
    child.on('exit', code => {
      const upFrom = child.__spawnedAt || t0;
      const uptime = ((Date.now() - upFrom) / 1000).toFixed(1);
      // clean = normal exit or a stop we asked for; anything else is the app
      // dying on its own, which earns a context snapshot.
      const clean = code === 0 || child.__deliberate;
      let line = `[${app.name}] exited (code ${code}) after ${uptime}s up`;
      if (!clean) line += ` [UNEXPECTED — ${sysSnapshot()}]`;
      log(line);
      if (app.child === child) app.child = null;
    });
    child.on('error', err => {
      log(`[${app.name}] spawn error: ${err.message}`);
      if (app.child === child) app.child = null;
    });
    // wait until it accepts, then discard the probe socket
    const probe = await waitForUpstream(app);
    probe.destroy();
    // Two-phase timing: spawn() -> process exists ('spawn' event) is pure OS
    // process-creation time (nothing the app does affects it); process exists ->
    // port accepting is the app's own boot. Splitting them pins a slow start on
    // the machine vs the app.
    const createMs = tSpawned ? tSpawned - t0 : 0;
    const bootMs = tSpawned ? Date.now() - tSpawned : Date.now() - t0;
    const totalMs = Date.now() - t0;
    let upLine = `[${app.name}] up on :${app.upstreamPort} in ${(totalMs / 1000).toFixed(1)}s `
      + `(${(createMs / 1000).toFixed(1)}s spawn + ${(bootMs / 1000).toFixed(1)}s boot)`;
    if (totalMs >= SLOW_SPAWN_MS) upLine += ` [SLOW — ${sysSnapshot()}]`;
    log(upLine);
  })();
  app.starting = starting.finally(() => { app.starting = null; });
  return app.starting;
}

function stopChild(app, reason) {
  if (!childAlive(app)) return;
  log(`[${app.name}] stopping (${reason})`);
  app.child.__deliberate = true;   // mark so the exit handler knows this was us
  const pid = app.child.pid;
  if (process.platform === 'win32') {
    // /T takes the whole tree in case the app spawned helpers
    spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  } else {
    app.child.kill('SIGTERM');
  }
  app.child = null;
}

function scheduleIdleCheck(app) {
  clearTimeout(app.idleTimer);
  if (app.sockets.size > 0) return;
  app.idleTimer = setTimeout(() => {
    if (app.sockets.size === 0) stopChild(app, `idle ${app.idleMs / 60000}min`);
  }, app.idleMs);
}

function isKeepaliveRequest(chunk) {
  const head = chunk.toString('latin1', 0, Math.min(chunk.length, 256));
  const m = head.match(/^[A-Z]+[ \t]+(\/[^ \t\r\n?#]*)/);
  return m ? m[1] === KEEPALIVE_PATH : false;
}

function answerKeepalive(app, client) {
  // Reset the idle countdown without spawning or proxying. This is how an app
  // doing background work (a radio loop, a cron tick, a long job) tells porter
  // it's still alive when no browser socket is holding it open. If the app is
  // down we don't wake it — hitting a real URL does that.
  clearTimeout(app.idleTimer);
  scheduleIdleCheck(app);
  client.end('HTTP/1.1 204 No Content\r\nConnection: close\r\n\r\n');
}

function handleConnection(app, client, initialChunk) {
  clearTimeout(app.idleTimer);
  app.sockets.add(client);
  client.on('close', () => {
    app.sockets.delete(client);
    scheduleIdleCheck(app);
  });
  client.on('error', () => client.destroy());

  startChild(app)
    .then(() => tryConnect(app.upstreamPort))
    .then(upstream => {
      upstream.on('error', () => client.destroy());
      if (initialChunk) upstream.write(initialChunk);
      client.pipe(upstream);
      upstream.pipe(client);
    })
    .catch(err => {
      log(`[${app.name}] connection failed: ${err.message}`);
      client.destroy();
    });
}

// Each app connection is peeked for a keepalive request line before it's piped
// to the upstream. A real client speaks first, so this resolves in about a
// millisecond; if nothing arrives by PEEK_MS the app may expect the server to
// greet first, so we pipe it raw (unchanged from before) rather than deadlock.
function routeAppConnection(app, client) {
  client.on('error', () => client.destroy());
  let settled = false;
  const onData = chunk => {
    if (settled) return;
    settled = true;
    clearTimeout(peekTimer);
    client.pause(); // hold further data until the pipe to upstream is up
    if (isKeepaliveRequest(chunk)) answerKeepalive(app, client);
    else handleConnection(app, client, chunk);
  };
  const peekTimer = setTimeout(() => {
    if (settled) return;
    settled = true;
    client.removeListener('data', onData);
    handleConnection(app, client, null);
  }, PEEK_MS);
  client.on('data', onData);
}

function startAppDoor(app, apps) {
  const server = net.createServer(client => routeAppConnection(app, client));
  app.door = server;
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') {
      log(`[${app.name}] :${app.port} already in use — is the app (or another porter) running? skipping`);
    } else {
      log(`[${app.name}] listen error: ${err.message}`);
    }
    app.door = null;
    const index = apps.indexOf(app);
    if (index >= 0) apps.splice(index, 1);
  });
  server.listen(app.port, '127.0.0.1', () => {
    log(`[${app.name}] door open on :${app.port} → :${app.upstreamPort} (idle ${app.idleMs / 60000}min)`);
  });
}

// The name door: one listener (default :80) that reads the Host header off the
// first chunk and routes http://<name>.localhost/ (or a bare hosts-file alias
// http://<name>/) to the matching app. The chunk is replayed to the upstream,
// then the socket is piped raw like any other connection.
function startNameDoor(apps, namePort) {
  // Bind both loopback stacks: on this machine Windows' IP Helper service
  // squats on 127.0.0.1:80, but ::1:80 is free — and browsers resolve
  // *.localhost to both, preferring IPv6, so one working stack is enough.
  for (const bindHost of ['127.0.0.1', '::1']) {
    const server = net.createServer(client => {
      client.on('error', () => client.destroy());
      client.once('data', chunk => {
        client.pause(); // hold further data until the pipe to upstream is up
        const head = chunk.toString('latin1');
        const m = head.match(/^Host:[ \t]*([^\r\n]+)/im);
        const host = (m ? m[1].trim().toLowerCase() : '').replace(/:\d+$/, '');
        const name = host.endsWith('.localhost') ? host.slice(0, -'.localhost'.length) : host;
        const app = apps.find(a => a.name === name);
        if (!app) {
          const known = apps.map(a => `  http://${a.name}.localhost/`).join('\n');
          client.end(`HTTP/1.1 404 Not Found\r\nContent-Type: text/plain\r\nConnection: close\r\n\r\nporter: no app named "${name}"\nknown apps:\n${known}\n`);
          return;
        }
        if (isKeepaliveRequest(chunk)) {
          answerKeepalive(app, client);
          return;
        }
        handleConnection(app, client, chunk);
      });
    });
    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        log(`[name-door] ${bindHost}:${namePort} already in use — skipping that stack`);
      } else {
        log(`[name-door] ${bindHost}:${namePort} listen error: ${err.message}`);
      }
    });
    server.listen(namePort, bindHost, () => {
      log(`[name-door] open on ${bindHost}:${namePort} — ${apps.map(a => `${a.name}.localhost`).join(', ')}`);
    });
  }
}

function main() {
  const {
    apps,
    namePort,
    idleMinutes,
    manifestRoots,
    manifestScanMs,
  } = loadConfig();
  if (apps.length === 0) {
    log('no apps configured yet — waiting for manifests');
  }
  startLagSensor();
  for (const app of apps) {
    startAppDoor(app, apps);
  }
  if (namePort) startNameDoor(apps, namePort);
  if (manifestRoots.length > 0) {
    const scan = () => {
      for (const app of discoverManifestApps(manifestRoots, idleMinutes)) {
        if (apps.some(existing => existing.manifestPath === app.manifestPath)) {
          continue;
        }
        if (addUniqueApp(apps, app)) {
          startAppDoor(app, apps);
          log(`[${app.name}] discovered from ${app.manifestPath}`);
        }
      }
    };
    setInterval(scan, manifestScanMs);
    log(
      `[manifest] scanning ${manifestRoots.join(', ')} every `
      + `${manifestScanMs / 1000}s`,
    );
  }

  const shutdown = () => {
    log('porter shutting down — stopping children');
    for (const app of apps) stopChild(app, 'porter exit');
    setTimeout(() => process.exit(0), 300);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

// Never die silently. Without these, an uncaught throw vanishes with no trace
// (a clean log that just stops) and the watchdog has to guess. Log the stack,
// then exit non-zero so the watchdog sees us as down and relaunches.
process.on('uncaughtException', err => {
  log(`FATAL uncaughtException: ${err && err.stack ? err.stack : err}`);
  process.exit(1);
});
process.on('unhandledRejection', reason => {
  log(`FATAL unhandledRejection: ${reason && reason.stack ? reason.stack : reason}`);
  process.exit(1);
});

const isMain = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();

export {
  addUniqueApp,
  discoverManifestApps,
  isKeepaliveRequest,
  normalizeApp,
};
