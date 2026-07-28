const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const helperPath = path.join(__dirname, 'pm2-jlist-projector.js');
const { loadPm2Projection, projectPm2Output } = require('./pm2-jlist-projector');

const secret = 'TOP_SECRET_SENTINEL';
const fixture = `pm2 prefix\n${JSON.stringify([
  { name: 'nexo-backend', pid: 101, pm2_env: { status: 'online', node_version: '22.23.1', HOST: '127.0.0.1', username: secret, USERNAME: secret } },
  { name: 'nexo-frontend', pid: 102, pm2_env: { status: 'online', node_version: '22.23.1', username: secret, USERNAME: secret } },
])}\npm2 suffix`;

test('projects duplicate-case PM2 environments to the exact non-secret allowlist', () => {
  const projected = projectPm2Output(fixture);
  assert.deepEqual(projected, [
    { name: 'nexo-backend', pid: 101, status: 'online', nodeVersion: '22.23.1', host: '127.0.0.1' },
    { name: 'nexo-frontend', pid: 102, status: 'online', nodeVersion: '22.23.1', host: null },
  ]);
  for (const app of projected) assert.deepEqual(Object.keys(app), ['name', 'pid', 'status', 'nodeVersion', 'host']);
  const serialized = JSON.stringify(projected);
  assert.doesNotMatch(serialized, /username|TOP_SECRET_SENTINEL|pm2_env/);
});

test('fails closed with one sanitized error and no partial projection for malformed output or apps', () => {
  const invalid = [
    'no array',
    '{}',
    '[{"name":"nexo-backend"}]',
    JSON.stringify([{ name: 'nexo-backend', pid: 1.5, pm2_env: { status: 'online', node_version: '22.23.1' } }]),
    JSON.stringify([{ name: 'nexo-backend', pid: 1, pm2_env: { status: 7, node_version: '22.23.1' } }]),
    JSON.stringify([{ name: 'nexo-backend', pid: 1, pm2_env: { status: 'online', node_version: '22.23.1', HOST: {} } }]),
  ];
  for (const raw of invalid) assert.throws(() => projectPm2Output(raw), /^Error: PM2 projection failed\.$/);
});

test('propagates PM2 child failure without exposing child output or errors', () => {
  const projected = () => loadPm2Projection('fixture-pm2', () => ({ status: 9, stdout: fixture, stderr: secret, error: new Error(secret) }));
  assert.throws(projected, (error) => error.message === 'PM2 projection failed.' && !String(error).includes(secret));
});

test('CLI fixture injection emits only projection and sanitizes failures', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-pm2-projector-'));
  const goodPath = path.join(directory, 'good.txt');
  const badPath = path.join(directory, 'bad.txt');
  fs.writeFileSync(goodPath, fixture);
  fs.writeFileSync(badPath, `${secret} malformed`);
  const env = { ...process.env, NEXO_PM2_PROJECTOR_TEST_FIXTURES: '1' };
  try {
    const good = spawnSync(process.execPath, [helperPath, '--fixture', goodPath], { encoding: 'utf8', env });
    assert.equal(good.status, 0, good.stderr);
    assert.deepEqual(JSON.parse(good.stdout), projectPm2Output(fixture));
    assert.equal(good.stderr, '');
    const bad = spawnSync(process.execPath, [helperPath, '--fixture', badPath], { encoding: 'utf8', env });
    assert.notEqual(bad.status, 0);
    assert.equal(bad.stdout, '');
    assert.equal(bad.stderr.trim(), 'PM2 projection failed.');
    assert.doesNotMatch(`${bad.stdout}${bad.stderr}`, new RegExp(secret));
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('projected duplicate-case fixture parses under Windows PowerShell 5.1', { skip: process.platform !== 'win32' }, () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-pm2-powershell-'));
  const fixturePath = path.join(directory, 'fixture.txt');
  fs.writeFileSync(fixturePath, fixture);
  try {
    const command = `$env:NEXO_PM2_PROJECTOR_TEST_FIXTURES='1'; $json = & '${process.execPath.replaceAll("'", "''")}' '${helperPath.replaceAll("'", "''")}' --fixture '${fixturePath.replaceAll("'", "''")}'; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }; $parsed = $json | ConvertFrom-Json; $apps = @($parsed | ForEach-Object { $_ }); [pscustomobject]@{ count=$apps.Count; backendHost=$apps[0].host; frontendHost=$apps[1].host; keys=@($apps[0].psobject.Properties.Name) } | ConvertTo-Json -Compress`;
    const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(JSON.parse(result.stdout), { count: 2, backendHost: '127.0.0.1', frontendHost: null, keys: ['name', 'pid', 'status', 'nodeVersion', 'host'] });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('validators consume the shared projection and never parse raw jlist in PowerShell', () => {
  const validator = fs.readFileSync(path.join(root, 'scripts', 'validate-running-release.ps1'), 'utf8');
  const preflight = fs.readFileSync(path.join(root, 'scripts', 'deployment-preflight.ps1'), 'utf8');
  for (const source of [validator, preflight]) assert.match(source, /pm2-jlist-projector\.js/);
  assert.doesNotMatch(validator, /\$raw\s*=.*jlist|pm2_env\.(?:status|node_version|HOST)/s);
  assert.match(validator, /if \(\$LASTEXITCODE -ne 0\).*PM2 projection failed/s);
  assert.match(validator, /\.status|\.nodeVersion|\.pid|\.host/);
});

test('Windows PowerShell listener bridge preserves an exact three-slot contract with two listeners', { skip: process.platform !== 'win32' }, () => {
  const contractPath = path.join(__dirname, 'deployment-contract.js');
  const nodeScript = "const c=require(process.argv[1]);const a=JSON.parse(Buffer.from(process.argv[2],'base64').toString('utf8'));if(a.length!==3||a[0].length!==2||Array.isArray(a[0][0]))throw new Error('bridge shape invalid');c.assertListenerOwnership(...a);";
  const command = [
    "$listeners = @([pscustomobject]@{address='127.0.0.1';port=3001;pid=42;process='node.exe';command='C:\\pm2\\lib\\Daemon.js'}, [pscustomobject]@{address='::';port=5173;pid=42;process='node.exe';command='C:\\pm2\\lib\\Daemon.js'})",
    "$expected = @{'3001'=@{pid=101;commandFragment='backend'};'5173'=@{pid=102;commandFragment='serve-frontend.js'}}",
    "$options = @{pm2DaemonPid=42;pm2DaemonCommandFragment='Daemon.js'}",
    '[object[]]$contractArguments = New-Object object[] 3',
    '$contractArguments[0] = [object[]]$listeners',
    '$contractArguments[1] = $expected',
    '$contractArguments[2] = $options',
    '$json = ConvertTo-Json -InputObject $contractArguments -Depth 8 -Compress',
    '$payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))',
    `& '${process.execPath.replaceAll("'", "''")}' -e '${nodeScript.replaceAll("'", "''")}' '${contractPath.replaceAll("'", "''")}' $payload`,
    'exit $LASTEXITCODE',
  ].join('; ');
  const result = spawnSync('powershell.exe', ['-NoProfile', '-Command', command], { encoding: 'utf8' });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);

  const validator = fs.readFileSync(path.join(root, 'scripts', 'validate-running-release.ps1'), 'utf8');
  assert.match(validator, /\[object\[\]\]\$listenerArguments\s*=\s*New-Object object\[\] 3/);
  assert.match(validator, /\$listenerArguments\[0\]\s*=\s*\[object\[\]\]\$listeners/);
  assert.doesNotMatch(validator, /@\(,\(\[object\[\]\]\$listeners\)/);
});
