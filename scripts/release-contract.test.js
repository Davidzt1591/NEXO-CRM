const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { assertCommandResult, assertEnvironment, assertHealthBody, assertListenerOwnership, assertPm2Available, assertPm2Node22, assertPreSwitchPm2, parsePm2DaemonNodeVersion } = require('./deployment-contract');

const root = path.resolve(__dirname, '..');
const powershell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
const preflight = path.join(root, 'scripts', 'deployment-preflight.ps1');

function runPreflight(args, options = {}) {
  return spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', preflight, ...args], {
    cwd: options.cwd || root,
    env: { ...process.env, ...options.env },
    encoding: 'utf8',
    timeout: 120000,
  });
}

function output(result) { return `${result.stdout || ''}\n${result.stderr || ''}`; }

test('root start targets only the static frontend', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  assert.equal(manifest.scripts.start, 'node serve-frontend.js');
  assert.doesNotMatch(manifest.scripts.start, /server\.js/);
});

for (const entrypoint of ['server.js', 'index.js']) test(`${entrypoint} refuses production before initialization`, () => {
  const result = spawnSync(process.execPath, [entrypoint], { cwd: root, env: { ...process.env, NODE_ENV: 'production' }, encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 78);
  assert.match(result.stderr, /^LEGACY_ENTRYPOINT_DISABLED\s*$/);
  assert.equal(result.stdout, '');
});

test('listener contract rejects duplicate and foreign listeners with actionable attribution', () => {
  assert.throws(() => assertListenerOwnership([
    { address: '::', port: 3001, pid: 10, process: 'node', command: 'pm2 nexo-backend' },
    { address: '0.0.0.0', port: 3001, pid: 11, process: 'node', command: 'foreign' },
  ], { 3001: { pid: 10, commandFragment: 'nexo-backend' } }), /0\.0\.0\.0:3001 PID 11 node foreign/);
});

test('listener contract rejects missing expected PID and PM2 runtime mismatch', () => {
  assert.throws(() => assertListenerOwnership([], { 5173: { pid: 20, commandFragment: 'serve-frontend.js' } }), /Expected listener missing/);
  assert.throws(() => assertPm2Node22({ daemonNodeVersion: '25.6.1' }, []), /PM2 daemon/);
  assert.throws(() => assertPm2Node22({ daemonNodeVersion: '22.23.1' }, [{ name: 'nexo-backend', nodeVersion: '25.6.1', status: 'online' }]), /nexo-backend/);
});

test('release health contract accepts only the exact ready response', () => {
  assert.doesNotThrow(() => assertHealthBody({ status: 'ready', ready: true }));
  for (const body of [
    { status: 'ok', ready: true },
    { status: 'ready', ready: false },
    { status: 'degraded', ready: true },
    { status: 'ready', ready: true, detail: 'extra' },
    null,
  ]) assert.throws(() => assertHealthBody(body), /Health response must be exactly/);
});

test('listener contract accepts the app PID or verified Windows PM2 cluster daemon only', () => {
  const expected = { 3001: { pid: 10, commandFragment: 'nexo-backend' } };
  const daemon = { pm2DaemonPid: 42, pm2DaemonCommandFragment: 'pm2\\lib\\Daemon.js' };
  assert.doesNotThrow(() => assertListenerOwnership([
    { address: '127.0.0.1', port: 3001, pid: 10, process: 'node.exe', command: 'pm2 nexo-backend' },
  ], expected, daemon));
  assert.doesNotThrow(() => assertListenerOwnership([
    { address: '127.0.0.1', port: 3001, pid: 42, process: 'node.exe', command: 'C:\\pm2\\lib\\Daemon.js' },
  ], expected, daemon));
  assert.throws(() => assertListenerOwnership([
    { address: '127.0.0.1', port: 3001, pid: 99, process: 'node.exe', command: 'foreign' },
  ], expected, daemon), /Unexpected listener/);
  assert.throws(() => assertListenerOwnership([
    { address: '127.0.0.1', port: 3001, pid: 42, process: 'node.exe', command: 'foreign' },
  ], expected, daemon), /Unexpected listener/);
});

test('running-release validator and runbook use the source-defined ready contract', () => {
  const validator = fs.readFileSync(path.join(root, 'scripts', 'validate-running-release.ps1'), 'utf8');
  const runbook = fs.readFileSync(path.join(root, 'docs', 'production-runbook.md'), 'utf8');
  assert.match(validator, /assertHealthBody/);
  assert.match(validator, /assertListenerOwnership/);
  assert.doesNotMatch(validator, /status\s*-ne\s*'ok'/);
  assert.match(runbook, /\{"status":"ready","ready":true\}/);
  assert.match(runbook, /PID verificado del PM2 cluster daemon/);
});

test('PM2 daemon report parser accepts only one bounded daemon version with colon or pipe delimiter', () => {
  const colon = `--- Daemon ----------------\nnode version : 22.23.1\nnode path : C:\\runtime\\node.exe\n--- CLI -------------------\nnode version : 25.0.0`;
  const pipe = `--- Daemon -----\nnode version | 22.23.1\n--- App ----------------\nnode version : 25.0.0`;
  assert.equal(parsePm2DaemonNodeVersion(colon), '22.23.1');
  assert.equal(parsePm2DaemonNodeVersion(pipe), '22.23.1');
  assert.equal(parsePm2DaemonNodeVersion(colon.replace('22.23.1', '25.6.1')), '25.6.1');
});

test('PM2 daemon report parser fails closed without leaking malformed reports or secrets', () => {
  const secret = 'REPORT_SECRET_SENTINEL';
  const invalid = [
    `--- App -----\nnode version : 22.23.1\n${secret}`,
    `--- Daemon -----\nstatus : online\n${secret}`,
    `--- Daemon -----\nnode version : 22.23.1\nnode version | 25.6.1\n${secret}`,
    `--- Daemon node version : 22.23.1\n${secret}`,
    '',
  ];
  for (const report of invalid) assert.throws(
    () => parsePm2DaemonNodeVersion(report),
    (error) => error.message === 'PM2 daemon report invalid.' && !String(error).includes(secret),
  );
});

test('running validator and preflight delegate daemon report parsing to the shared contract', () => {
  const validator = fs.readFileSync(path.join(root, 'scripts', 'validate-running-release.ps1'), 'utf8');
  const deploymentPreflight = fs.readFileSync(preflight, 'utf8');
  for (const source of [validator, deploymentPreflight]) {
    assert.match(source, /parsePm2DaemonNodeVersion/);
    assert.match(source, /PM2 daemon report invalid/);
    assert.doesNotMatch(source, /Daemon\s*\\?s.*node version\s*\\?s.*(?:\\\||:)/s);
  }
});

test('install, audit, PM2 command, missing PM2, and child failures propagate', () => {
  for (const name of ['npm ci', 'npm audit', 'pm2 startOrRestart', 'child process']) {
    assert.throws(() => assertCommandResult(name, { status: 9, stderr: 'fixture failure' }), new RegExp(`${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} failed with exit 9`));
  }
  assert.throws(() => assertPm2Available(path.join(root, 'missing-pm2')), /PM2 CLI missing/);
});

test('invalid production environment fails closed', () => {
  assert.throws(() => assertEnvironment({}, 'LocalLoopback'), /SUPABASE_URL/);
  const local = { SUPABASE_URL: 'x', SALESFORCE_CLIENT_ID: 'x', FRONTEND_URL: 'http://localhost:5173', HOST: '127.0.0.1', ALLOWED_ORIGINS: 'http://localhost:5173', ALLOW_INSECURE_LOCAL_COOKIE: 'true', SESSION_COOKIE_SECURE: 'false', TRUST_PROXY_CIDRS: '' };
  assert.doesNotThrow(() => assertEnvironment(local, 'LocalLoopback'));
  assert.throws(() => assertEnvironment({ ...local, HOST: '0.0.0.0' }, 'LocalLoopback'), /HOST/);
  assert.throws(() => assertEnvironment(local, 'ReverseProxyHttps', {}), /explicit allowed origins/);
  assert.doesNotThrow(() => assertEnvironment(local, 'ReverseProxyHttps', { allowedOrigins: 'https://nexo.example', sessionCookieSecure: 'true', trustedProxyCidrs: '10.0.0.0/24' }));
});

test('phase runtime sequencing accepts Node25 only before an explicitly accepted switch', () => {
  const predecessor = [{ name: 'nexo-backend', nodeVersion: '25.6.1', status: 'online' }];
  assert.throws(() => assertPreSwitchPm2({ daemonNodeVersion: '25.6.1' }, predecessor, ''), /acceptance evidence/);
  assert.doesNotThrow(() => assertPreSwitchPm2({ daemonNodeVersion: '25.6.1' }, predecessor, 'approved by operator'));
  assert.throws(() => assertPm2Node22({ daemonNodeVersion: '25.6.1' }, predecessor), /Node 22\.23\.1/);
});

test('public npm deployment CheckOnly succeeds against the current repository', () => {
  const result = spawnSync(powershell, ['-NoProfile', '-Command', 'npm run deployment:check'], { cwd: root, encoding: 'utf8', timeout: 120000 });
  assert.equal(result.status, 0, output(result));
  assert.match(output(result), /CheckOnly performed no PM2 or live predecessor checks/);
});

test('PowerShell preflight rejects missing and bad topology values', () => {
  const missing = runPreflight(['-CheckOnly', '-Phase', 'PreSwitch', '-RepoRoot', root]);
  assert.notEqual(missing.status, 0);
  assert.match(output(missing), /Topology/);
  const bad = runPreflight(['-CheckOnly', '-Phase', 'PreSwitch', '-Topology', 'PublicInternet', '-RepoRoot', root]);
  assert.notEqual(bad.status, 0);
  assert.match(output(bad), /ValidateSet|Topology/);
});

test('live PreSwitch requires explicit acceptance evidence', () => {
  const result = runPreflight(['-Phase', 'PreSwitch', '-Topology', 'LocalLoopback', '-RepoRoot', root]);
  assert.notEqual(result.status, 0);
  assert.match(output(result), /NoRollbackAcceptanceEvidence/);
});

test('PostSwitch rejects a Node 25 runtime inspection fixture', () => {
  const fixturePath = path.join(require('node:os').tmpdir(), `nexo-preflight-runtime-${process.pid}.json`);
  fs.writeFileSync(fixturePath, JSON.stringify({
    pm2DaemonNodeVersion: '25.6.1', pm2DaemonPid: 42,
    pm2Apps: [
      { name: 'nexo-backend', pid: 101, status: 'online', nodeVersion: '25.6.1' },
      { name: 'nexo-frontend', pid: 102, status: 'online', nodeVersion: '25.6.1' },
    ],
    listeners: [
      { address: '127.0.0.1', port: 3001, pid: 101, process: 'node.exe', command: 'fixture backend' },
      { address: '127.0.0.1', port: 5173, pid: 102, process: 'node.exe', command: 'fixture frontend' },
    ],
  }));
  try {
    const result = runPreflight(['-Phase', 'PostSwitch', '-Topology', 'LocalLoopback', '-RepoRoot', root, '-ReleaseValidationToken', 'fixture-token', '-RuntimeInspectionFixturePath', fixturePath], { env: { NEXO_PREFLIGHT_TEST_FIXTURES: '1' } });
    assert.notEqual(result.status, 0);
    assert.match(output(result), /PostSwitch daemon must be Node 22\.23\.1; actual: 25\.6\.1/);
  } finally { fs.rmSync(fixturePath, { force: true }); }
});

test('PowerShell preflight propagates ecosystem reader child failure', () => {
  const fixtureRoot = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'nexo-preflight-repo-'));
  try {
    const files = ['backend/package-lock.json', 'frontend/package-lock.json', 'frontend/dist/index.html', 'scripts/dependency-topology.js', 'scripts/verify-production-dependencies.js', 'scripts/with-node22.ps1', 'scripts/deployment-contract.js', 'scripts/release-contract.test.js', 'backend/server.js', 'serve-frontend.js'];
    for (const relative of files) { const target = path.join(fixtureRoot, relative); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, 'fixture'); }
    const manifest = { scripts: { start: 'node serve-frontend.js', 'install:production': 'npm ci --omit=dev --omit=optional', 'verify:production-deps': 'node fixture.js' } };
    fs.writeFileSync(path.join(fixtureRoot, 'package.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(fixtureRoot, 'package-lock.json'), '{}');
    fs.mkdirSync(path.join(fixtureRoot, 'backend'), { recursive: true });
    fs.writeFileSync(path.join(fixtureRoot, 'backend/package.json'), JSON.stringify({ scripts: manifest.scripts }));
    fs.writeFileSync(path.join(fixtureRoot, 'ecosystem.config.js'), 'process.exit(23)');
    const result = runPreflight(['-CheckOnly', '-Phase', 'PreSwitch', '-Topology', 'LocalLoopback', '-RepoRoot', fixtureRoot]);
    assert.notEqual(result.status, 0);
    assert.match(output(result), /reader failed with exit 23/);
  } finally { fs.rmSync(fixtureRoot, { recursive: true, force: true }); }
});
