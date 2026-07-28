const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const { spawnSync } = require('node:child_process');
const { runDeploymentCheck } = require('./run-deployment-check');

const root = path.resolve(__dirname, '..');

for (const [platform, expected] of [['win32', 'powershell.exe'], ['linux', 'pwsh']]) {
  test(`deployment wrapper selects ${expected} on ${platform} and forwards arguments`, () => {
    let invocation;
    const status = runDeploymentCheck({
      platform,
      cwd: root,
      args: ['-NoRollbackAcceptanceEvidence', 'approved'],
      spawn(executable, args, options) {
        invocation = { executable, args, options };
        return { status: 17 };
      },
    });

    assert.equal(status, 17);
    assert.equal(invocation.executable, expected);
    assert.deepEqual(invocation.args.slice(-2), ['-NoRollbackAcceptanceEvidence', 'approved']);
    assert.equal(invocation.options.stdio, 'inherit');
    assert.equal(invocation.options.cwd, root);
  });
}

test('deployment wrapper converts signal termination into failure', () => {
  assert.equal(runDeploymentCheck({ spawn: () => ({ status: null, signal: 'SIGTERM' }) }), 1);
});

test('deployment wrapper uses the actual Windows PowerShell path locally', { skip: process.platform !== 'win32' }, () => {
  const result = spawnSync(process.execPath, ['scripts/run-deployment-check.js'], {
    cwd: root,
    encoding: 'utf8',
    timeout: 120000,
  });
  assert.equal(result.status, 0, `${result.stdout || ''}\n${result.stderr || ''}`);
});
