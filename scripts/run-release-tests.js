#!/usr/bin/env node
'use strict';

const cp = require('node:child_process');
const path = require('node:path');

const testFile = path.resolve(__dirname, 'release-contract.test.js');
const root = path.resolve(__dirname, '..');

const result = cp.spawnSync(
  process.execPath,
  ['--test', testFile],
  {
    cwd: root,
    stdio: ['inherit', 'pipe', 'pipe'],
    timeout: 300000,
    shell: false,
  }
);

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);

process.exit(typeof result.status === 'number' && result.status >= 0 ? result.status : 1);
