#!/usr/bin/env node
'use strict';

const cp = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const root = path.resolve(__dirname, '..');
const testFile = path.resolve(__dirname, 'release-contract.test.js');
const nodeVer = process.version;
const platform = process.platform;

// Phase 1: pre-flight checks
console.log(`NODE_VERSION=${nodeVer}`);
console.log(`PLATFORM=${platform}`);
console.log(`TEST_FILE_EXISTS=${fs.existsSync(testFile)}`);

// Check pwsh
try {
  const pwshCheck = cp.spawnSync('pwsh', ['-NoProfile', '-Command', 'echo pwsh_ok'], { timeout: 5000, encoding: 'utf8' });
  console.log(`PWSH_EXIT=${pwshCheck.status}`);
  console.log(`PWSH_STDOUT=${JSON.stringify(pwshCheck.stdout)}`);
  console.log(`PWSH_ERROR=${pwshCheck.error ? pwshCheck.error.message : '(none)'}`);
} catch (e) {
  console.log(`PWSH_EXCEPTION=${e.message}`);
}

// Check frontend dist
const distPath = path.join(root, 'frontend', 'dist', 'index.html');
console.log(`DIST_EXISTS=${fs.existsSync(distPath)}`);

// Phase 2: try to require the test file WITHOUT running — just to see if it loads
try {
  const req = cp.spawnSync(process.execPath, [
    '-e', `
      try {
        const test = require('node:test');
        console.log('TEST_RUNNER_VERSION=' + process.version);
        console.log('FILE_PARSE_OK=1');
      } catch(e) {
        console.log('FILE_PARSE_ERROR=' + e.message);
      }
    `
  ], { timeout: 5000, encoding: 'utf8' });
  console.log(`REQUIRE_TEST=${(req.stdout || '').trim().split('\n').pop()}`);
  console.log(`REQUIRE_EXIT=${req.status}`);
  if (req.stderr) console.log(`REQUIRE_STDERR=${req.stderr.slice(0, 500)}`);
} catch (e) {
  console.log(`REQUIRE_EXCEPTION=${e.message}`);
}

// Phase 3: try loading the actual test file
console.log('\n--- ACTUAL TEST RUN ---');
const result = cp.spawnSync(
  process.execPath,
  ['--test', '--test-timeout=60000', '--test-concurrency=1', testFile],
  {
    cwd: root,
    stdio: ['inherit', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 120000,
    shell: false,
  }
);

const output = [];
output.push('');
output.push('=== TEST EXIT CODE: ' + result.status + ' ===');
output.push('=== TEST SIGNAL: ' + (result.signal || '(none)') + ' ===');
output.push('=== TEST ERROR: ' + (result.error ? result.error.message : '(none)') + ' ===');

if (result.stdout) {
  output.push('=== STDOUT (' + result.stdout.length + ' chars) ===');
  output.push(result.stdout.slice(0, 10000));
} else {
  output.push('=== STDOUT: (empty) ===');
}

if (result.stderr) {
  output.push('=== STDERR (' + result.stderr.length + ' chars) ===');
  output.push(result.stderr.slice(0, 10000));
} else {
  output.push('=== STDERR: (empty) ===');
}

// Write everything
const full = output.join('\n');
console.log(full);

// Dump to file too
const infoPath = path.join(root, '.runtime', 'release-test-diagnostic.txt');
try {
  fs.mkdirSync(path.join(root, '.runtime'), { recursive: true });
  fs.writeFileSync(infoPath, full);
  console.log(`\nDiagnostic saved to ${infoPath}`);
} catch {}

process.exit(typeof result.status === 'number' && result.status >= 0 ? result.status : 1);
