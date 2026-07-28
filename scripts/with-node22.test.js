const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { execFileSync, spawnSync } = require('node:child_process');
const test = require('node:test');

const isWindows = process.platform === 'win32';
const repoRoot = path.resolve(__dirname, '..');
const launcher = path.join(__dirname, 'with-node22.ps1');

function launch(...command) {
  return execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launcher, ...command], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
}

function launchResult(script, ...command) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, ...command], { cwd: repoRoot, encoding: 'utf8' });
}

test('portable launcher pins child node and npm lifecycle execution to Node 22.23.1', { skip: !isWindows }, () => {
  assert.match(launch('node', '--version'), /^v22\.23\.1\s*$/m);
  assert.match(launch('npm', 'run', 'runtime:check'), /Supported runtime: Node\.js v22\.23\.1, npm 10\.9\.8/);
});

test('portable launcher propagates arguments and child exit code', { skip: !isWindows }, () => {
  const probe = path.join(os.tmpdir(), `nexo-launcher-probe-${process.pid}.js`);
  fs.writeFileSync(probe, "if(process.argv[2]==='exit')process.exit(7);console.log(process.argv[2]);");
  try {
    assert.match(launch('node', probe, 'argument with spaces'), /argument with spaces/);
    assert.equal(launchResult(launcher, 'node', probe, 'exit').status, 7);
  } finally { fs.rmSync(probe, { force: true }); }
  assert.notEqual(launchResult(launcher, 'definitely-not-a-command').status, 0);
});

test('portable launcher fails for missing runtime and checksum mismatch', { skip: !isWindows }, (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-node22-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  fs.mkdirSync(path.join(fixture, 'scripts'), { recursive: true });
  const fixtureLauncher = path.join(fixture, 'scripts', 'with-node22.ps1');
  fs.copyFileSync(launcher, fixtureLauncher);
  assert.notEqual(launchResult(fixtureLauncher, 'node', '--version').status, 0);
  const runtime = path.join(fixture, '.runtime', 'node-v22.23.1-win-x64');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'node.exe'), 'not node');
  fs.writeFileSync(path.join(runtime, 'npm.cmd'), '@echo 10.9.8');
  const mismatch = launchResult(fixtureLauncher, 'node', '--version');
  assert.notEqual(mismatch.status, 0);
  assert.match(`${mismatch.stdout}${mismatch.stderr}`, /checksum mismatch/i);
});

test('portable launcher fails closed on npm version mismatch', { skip: !isWindows }, (t) => {
  const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-node22-npm-'));
  t.after(() => fs.rmSync(fixture, { recursive: true, force: true }));
  const scripts = path.join(fixture, 'scripts');
  const runtime = path.join(fixture, '.runtime', 'node-v22.23.1-win-x64');
  fs.mkdirSync(scripts, { recursive: true }); fs.mkdirSync(runtime, { recursive: true });
  const node = path.join(runtime, 'node.exe');
  fs.copyFileSync(path.join(repoRoot, '.runtime', 'node-v22.23.1-win-x64', 'node.exe'), node);
  fs.writeFileSync(path.join(runtime, 'npm.cmd'), '@echo 0.0.0\r\n');
  const hash = require('node:crypto').createHash('sha256').update(fs.readFileSync(node)).digest('hex');
  const source = fs.readFileSync(launcher, 'utf8').replace(/f8d162c0641dcee512132f3bcf8a68169c7ecb852efd8e1a46c9fec5a0f469ed/g, hash);
  const fixtureLauncher = path.join(scripts, 'with-node22.ps1'); fs.writeFileSync(fixtureLauncher, source);
  const result = launchResult(fixtureLauncher, 'node', '--version');
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /npm runtime mismatch/i);
});
