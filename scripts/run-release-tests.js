#!/usr/bin/env node
'use strict';

const cp = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');

const summaryFile = process.env.GITHUB_STEP_SUMMARY;
function summary(msg) {
  if (summaryFile) fs.appendFileSync(summaryFile, msg + '\n');
  console.log(msg);
}

const root = path.resolve(__dirname, '..');
const testFile = path.resolve(__dirname, 'release-contract.test.js');

summary('## Release Contract Test Diagnostic');
summary(`- Node: ${process.version}`);
summary(`- Platform: ${process.platform}`);
summary(`- CWD: ${process.cwd()}`);
summary(`- Test file exists: ${fs.existsSync(testFile)}`);
summary(`- Frontend dist exists: ${fs.existsSync(path.join(root, 'frontend', 'dist', 'index.html'))}`);

// Check pwsh
try {
  const pwshCheck = cp.spawnSync('pwsh', ['-NoProfile', '-Command', 'echo pwsh_available'], { timeout: 5000, encoding: 'utf8' });
  summary(`- pwsh available: ${pwshCheck.status === 0} (status=${pwshCheck.status}, stdout=${JSON.stringify((pwshCheck.stdout || '').trim())})`);
} catch (e) {
  summary(`- pwsh ERROR: ${e.message}`);
}

// Verify deployment:check
try {
  const checkResult = cp.spawnSync('pwsh', ['-NoProfile', '-Command', 'npm run deployment:check'], { cwd: root, timeout: 60000, encoding: 'utf8' });
  summary(`- deployment:check status: ${checkResult.status}, stderr len: ${(checkResult.stderr || '').length}`);
  if (checkResult.error) summary(`- deployment:check error: ${checkResult.error.message}`);
} catch (e) {
  summary(`- deployment:check EXCEPTION: ${e.message}`);
}

// Try running the test file directly (not via --test)
summary('\n### Running test file (direct require, no --test)');
try {
  const directResult = cp.spawnSync(
    process.execPath,
    ['-e', `
      const test = require('node:test');
      console.log('node:test loaded OK');
      console.log('test type:', typeof test);
    `],
    { timeout: 5000, encoding: 'utf8' }
  );
      summary(`- node:test load: ${(directResult.stdout || '').trim().split('\n').filter(Boolean).join(', ')}`);
} catch (e) {
  summary(`- load error: ${e.message}`);
}

// NOW try the actual test
summary('\n### Running node --test');
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

const exitCode = typeof result.status === 'number' && result.status >= 0 ? result.status : 1;

if (result.stdout) {
  summary('\n### Test STDOUT');
  summary('```\n' + result.stdout.slice(0, 5000) + '\n```');
}
if (result.stderr) {
  summary('\n### Test STDERR');
  summary('```\n' + result.stderr.slice(0, 5000) + '\n```');
}

summary(`\n### Result: exit=${exitCode}, signal=${result.signal || '(none)'}, error=${result.error ? result.error.message : '(none)'}`);

process.exit(exitCode);
