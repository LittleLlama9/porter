import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  addUniqueApp,
  discoverManifestApps,
  normalizeApp,
} from './porter.js';


test('discovers project manifests and infers cwd', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'porter-test-'));
  const project = path.join(root, 'Example');
  fs.mkdirSync(project);
  fs.writeFileSync(
    path.join(project, 'porter.app.json'),
    JSON.stringify({
      name: 'example',
      port: 3456,
      cmd: 'node',
      args: ['server.js'],
    }),
  );

  const apps = discoverManifestApps([root], 10);

  assert.equal(apps.length, 1);
  assert.equal(apps[0].name, 'example');
  assert.equal(apps[0].cwd, project);
  assert.equal(apps[0].upstreamPort, 13456);
  fs.rmSync(root, { recursive: true, force: true });
});


test('manual registrations win name and port conflicts', () => {
  const apps = [
    normalizeApp(
      {
        name: 'manual',
        port: 4000,
        upstreamPort: 14000,
        cmd: 'node',
        cwd: 'C:\\manual',
      },
      10,
    ),
  ];
  const duplicate = normalizeApp(
    {
      name: 'manual',
      port: 4001,
      upstreamPort: 14001,
      cmd: 'node',
      cwd: 'C:\\duplicate',
    },
    10,
  );
  const portConflict = normalizeApp(
    {
      name: 'other',
      port: 4000,
      upstreamPort: 14002,
      cmd: 'node',
      cwd: 'C:\\other',
    },
    10,
  );
  const crossRoleConflict = normalizeApp(
    {
      name: 'cross-role',
      port: 14000,
      upstreamPort: 15000,
      cmd: 'node',
      cwd: 'C:\\cross-role',
    },
    10,
  );

  assert.equal(addUniqueApp(apps, duplicate), false);
  assert.equal(addUniqueApp(apps, portConflict), false);
  assert.equal(addUniqueApp(apps, crossRoleConflict), false);
  assert.equal(apps.length, 1);
});


test('rejects invalid manifest settings', () => {
  assert.throws(
    () => normalizeApp(
      { name: 'Bad Name', port: 3000, cmd: 'node', cwd: 'C:\\bad' },
      10,
    ),
    /invalid app name/,
  );
  assert.throws(
    () => normalizeApp(
      { name: 'bad-port', port: 70000, cmd: 'node', cwd: 'C:\\bad' },
      10,
    ),
    /port must be an integer/,
  );
});
