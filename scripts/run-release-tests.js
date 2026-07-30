#!/usr/bin/env node
'use strict';

const cp = require('node:child_process');
const path = require('node:path');

const testFile = path.resolve(__dirname, 'release-contract.test.js');

console.log('=== RUNNING RELEASE CONTRACT TESTS ===');
console.log('Test file:', testFile);

try {
  const result = cp.spawnSync(
    process.execPath,
    ['--test', '--test-timeout=180000', '--test-concurrency=1', testFile],
    {
      cwd: path.resolve(__dirname, '..'),
      stdio: ['inherit', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 200000,
      shell: false,
    }
  );

  console.log('=== STDOUT ===');
  console.log(result.stdout || '(empty)');
  console.log('=== STDERR ===');
  console.log(result.stderr || '(empty)');
  console.log(`=== EXIT CODE: ${result.status} ===`);
  console.log(`=== SIGNAL: ${result.signal} ===`);
  console.log(`=== ERROR: ${result.error || '(none)'} ===`);

  process.exit(result.status ?? 1);
} catch (err) {
  console.error('FATAL:', err.message);
  process.exit(1);
}
