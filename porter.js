// porter.js — doorman for localhost apps. Zero dependencies.
//
// For every app in porter.config.json, porter listens on the app's public
// port. First incoming connection spawns the real server (hidden) on its
// upstream port and pipes bytes between them (raw TCP, so HTTP, websockets,
// SSE all just work). When every connection has been closed for idleMinutes,
// the server is killed. Closing the browser tab ends its sockets/polling, so
// the app dies a few minutes later; visiting the URL again resurrects it.
//
// Apps must honor PORT from the environment (porter sets PORT=upstreamPort).
//
// run: node porter.js          (install-startup.ps1 registers it at login)
import net from 'node:net';
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
  const apps = (raw.apps || []).map(a => ({
    name: a.name,
    port: a.port,
    upstreamPort: a.upstreamPort ?? a.port + 10000,
    cmd: a.cmd,
    args: a.args || [],
    cwd: a.cwd,
    env: a.env || {},
    idleMs: (a.idleMinutes ?? idleMinutes) * 60_000,
    // runtime state
    child: null,
    starting: null,     // promise while child is booting
    sockets: new Set(),
    idleTimer: null,
  }));
  return { apps, namePort };
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
  throw new Error(`${app.name}: not accepting on :${app.upstreamPort} after ${SPAWN_TIMEOUT_MS / 1000}s`);
}

function startChild(app) {
  if (app.starting) return app.starting;
  if (childAlive(app)) return Promise.resolve();
  app.starting = (async () => {
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
    app.child = spawn(app.cmd, app.args, {
      cwd: app.cwd,
      env: { ...process.env, PORT: String(app.upstreamPort), ...app.env },
      windowsHide: true,
      stdio: childStdio,
      detached: false,
    });
    if (Array.isArray(childStdio)) {
      app.child.on('exit', () => { try { fs.closeSync(childStdio[1]); } catch { } });
    }
    app.child.on('exit', code => {
      log(`[${app.name}] exited (code ${code})`);
      app.child = null;
    });
    app.child.on('error', err => {
      log(`[${app.name}] spawn error: ${err.message}`);
      app.child = null;
    });
    // wait until it accepts, then discard the probe socket
    const probe = await waitForUpstream(app);
    probe.destroy();
    log(`[${app.name}] up on :${app.upstreamPort}`);
  })();
  app.starting.finally(() => { app.starting = null; });
  return app.starting;
}

function stopChild(app, reason) {
  if (!childAlive(app)) return;
  log(`[${app.name}] stopping (${reason})`);
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
  const { apps, namePort } = loadConfig();
  if (apps.length === 0) {
    log('no apps in porter.config.json — nothing to do');
    process.exit(1);
  }
  for (const app of apps) {
    const server = net.createServer(socket => handleConnection(app, socket));
    server.on('error', err => {
      if (err.code === 'EADDRINUSE') {
        log(`[${app.name}] :${app.port} already in use — is the app (or another porter) running? skipping`);
      } else {
        log(`[${app.name}] listen error: ${err.message}`);
      }
    });
    server.listen(app.port, '127.0.0.1', () => {
      log(`[${app.name}] door open on :${app.port} → :${app.upstreamPort} (idle ${app.idleMs / 60000}min)`);
    });
  }
  if (namePort) startNameDoor(apps, namePort);

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

main();
