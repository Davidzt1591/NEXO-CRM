#!/usr/bin/env node
'use strict';

const cp = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const testFile = path.resolve(__dirname, 'release-contract.test.js');

// Full diagnostic
console.log('===== DIAGNOSTIC =====');
console.log('NODE:', process.version, 'EXECPATH:', process.execPath);
console.log('PLATFORM:', process.platform);
console.log('CWD:', process.cwd());
console.log('TEST_FILE:', testFile);
console.log('TEST_EXISTS:', fs.existsSync(testFile));
console.log('DIST_EXISTS:', fs.existsSync(path.join(root, 'frontend', 'dist', 'index.html')));

try {
  const pwshCheck = cp.spawnSync('pwsh', ['-NoProfile', '-Command', 'echo pwsh_available'], { timeout: 5000, encoding: 'utf8' });
  console.log('PWSH_STATUS:', pwshCheck.status);
  console.log('PWSH_STDOUT:', JSON.stringify((pwshCheck.stdout || '').trim()));
} catch (e) {
  console.log('PWSH_ERROR:', e.message);
}

console.log('===== RUNNING TEST =====');

const result = cp.spawnSync(
  process.execPath,
  ['--test', '--test-timeout=180000', '--test-concurrency=1', testFile],
  {
    cwd: root,
    stdio: ['inherit', 'pipe', 'pipe'],
    timeout: 300000,
    shell: false,
  }
);

const exitCode = typeof result.status === 'number' && result.status >= 0 ? result.status : 1;
const stdout = result.stdout || '';
const stderr = result.stderr || '';
const error = result.error ? result.error.message : '(none)';

console.log('\n===== RESULT =====');
console.log('EXIT_CODE:', exitCode);
console.log('SIGNAL:', result.signal || '(none)');
console.log('ERROR:', error);
console.log('STDOUT_LEN:', stdout.length);
console.log('STDERR_LEN:', stderr.length);

if (stdout) {
  console.log('\n--- STDOUT START ---');
  process.stdout.write(stdout);
  if (!stdout.endsWith('\n')) console.log();
  console.log('--- STDOUT END ---');
}

if (stderr) {
  console.log('\n--- STDERR START ---');
  process.stderr.write(stderr);
  if (!stderr.endsWith('\n')) console.log();
  console.log('--- STDERR END ---');
}

console.log('\n===== EXIT =====');
process.exit(exitCode);
