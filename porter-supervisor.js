// porter-supervisor.js — keeps porter.js alive, event-driven (no polling).
// Spawns porter as a child and respawns it whenever it exits. Backoff grows if
// porter is crash-looping, so a genuinely broken porter backs off instead of
// pegging the CPU; a run that stays up resets the backoff. One tiny idle
// process that only does work when porter actually dies. Launched once at
// logon by the "Porter Doorman" task; survives sleep because the process
// persists. Zero dependencies.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORTER = path.join(__dirname, 'porter.js');
const LOG = path.join(__dirname, 'supervisor.log');

const MIN_BACKOFF_MS = 1_000;
const MAX_BACKOFF_MS = 60_000;
const HEALTHY_MS = 30_000; // a run lasting this long is "stable" → reset backoff

function log(msg) {
  const line = `${new Date().toISOString()} ${msg}\n`;
  try { fs.appendFileSync(LOG, line); } catch { /* never die on logging */ }
}

let backoff = MIN_BACKOFF_MS;

function start() {
  const startedAt = Date.now();
  let handled = false; // 'exit' and 'error' can both fire — restart only once
  const restart = reason => {
    if (handled) return;
    handled = true;
    const ranFor = Date.now() - startedAt;
    if (ranFor >= HEALTHY_MS) backoff = MIN_BACKOFF_MS;
    log(`${reason} after ${Math.round(ranFor / 1000)}s — restarting in ${backoff / 1000}s`);
    setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, MAX_BACKOFF_MS);
  };

  log('spawning porter.js');
  const child = spawn(process.execPath, [PORTER], {
    cwd: __dirname,
    stdio: 'ignore', // porter does its own file logging (porter.log)
    windowsHide: true,
  });
  child.on('exit', code => restart(`porter exited (code ${code})`));
  child.on('error', err => restart(`spawn error: ${err.message}`));
}

log('supervisor started');
start();
