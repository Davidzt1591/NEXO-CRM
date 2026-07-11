const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { buildNpmCommand, buildProcessCommand } = require('./diagnose-nexo');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'diagnose-nexo.js');

function runDiagnose(args = [], options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: {
      ...process.env,
      ...options.env,
      PATH: options.pathEnv || process.env.PATH,
      NEXO_DIAG_TIMEOUT_MS: options.env?.NEXO_DIAG_TIMEOUT_MS || '1000',
    },
  });

    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', code => resolve({ code, stdout, stderr }));
  });
}

async function withFakePm2(fn) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-diag-pm2-'));
  const commandName = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';
  const commandPath = path.join(tempDir, commandName);
  const body = process.platform === 'win32' ? '@echo []\r\n' : '#!/bin/sh\nprintf "[]"\n';
  fs.writeFileSync(commandPath, body, process.platform === 'win32' ? undefined : { mode: 0o755 });
  if (process.platform !== 'win32') fs.chmodSync(commandPath, 0o755);

  try {
    return await fn(`${tempDir}${path.delimiter}${process.env.PATH || ''}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function listen(handler) {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, url: req.url, headers: req.headers });
    handler(req, res);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise(done => server.close(done)),
      });
    });
  });
}

test('prints help without running checks', async () => {
  const result = await runDiagnose(['--help'], { env: { NEXO_DIAG_TOKEN: 'help-secret' } });

  assert.equal(result.code, 0);
  assert.match(result.stdout, /NEXO read-only diagnostic runner/);
  assert.match(result.stdout, /--json/);
  assert.match(result.stdout, /--base-url URL/);
  assert.doesNotMatch(result.stdout, /help-secret/);
});

test('prints JSON contract and exits 0 when no check fails', async () => {
  const server = await listen((req, res) => {
    assert.equal(req.method, 'GET');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok' }));
  });

  try {
    const result = await withFakePm2(pathEnv => runDiagnose(['--json', '--base-url', server.baseUrl], { pathEnv }));
    const report = JSON.parse(result.stdout);

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.equal(report.tool, 'diagnose-nexo');
    assert.equal(report.status, 'OK');
    assert.equal(report.baseUrl, `${server.baseUrl}/`);
    assert.equal(typeof report.generatedAt, 'string');
    assert.ok(report.counts.OK >= 1);
    assert.ok(Array.isArray(report.results));
    assert.ok(report.results.every(item => item.status && item.name && item.detail));
  } finally {
    await server.close();
  }
});

test('exits 1 when a check fails', async () => {
  const server = await listen((req, res) => {
    assert.equal(req.method, 'GET');
    res.writeHead(503, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'down' }));
  });

  try {
    const result = await withFakePm2(pathEnv => runDiagnose(['--json', '--base-url', server.baseUrl], { pathEnv }));
    const report = JSON.parse(result.stdout);

    assert.equal(result.code, 1, `${result.stdout}\n${result.stderr}`);
    assert.equal(report.status, 'FAIL');
    assert.equal(report.counts.FAIL, 1);
  } finally {
    await server.close();
  }
});

test('redacts token and URL credentials/query values from JSON output', async () => {
  const token = 'token-secret-value';
  const querySecret = 'query-secret-value';
  const userSecret = 'user-secret-value';
  const passSecret = 'pass-secret-value';
  const server = await listen((req, res) => {
    res.writeHead(req.url === '/health' ? 200 : 204, { 'content-type': 'application/json' });
    res.end(req.url === '/health' ? JSON.stringify({ status: 'ok' }) : '');
  });
  const url = new URL(server.baseUrl);
  url.username = userSecret;
  url.password = passSecret;
  url.searchParams.set('token', querySecret);

  try {
    const result = await withFakePm2(pathEnv => runDiagnose(['--json', '--base-url', url.toString()], {
      pathEnv,
      env: { NEXO_DIAG_TOKEN: token },
    }));

    assert.doesNotMatch(result.stdout, new RegExp(token));
    assert.doesNotMatch(result.stdout, new RegExp(querySecret));
    assert.doesNotMatch(result.stdout, new RegExp(userSecret));
    assert.doesNotMatch(result.stdout, new RegExp(passSecret));
    assert.match(result.stdout, /REDACTED/);
  } finally {
    await server.close();
  }
});

test('performs only read-only operational calls', async () => {
  const server = await listen((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify([]));
  });

  try {
    const result = await withFakePm2(pathEnv => runDiagnose(['--json', '--base-url', server.baseUrl], {
      pathEnv,
      env: { NEXO_DIAG_TOKEN: 'read-only-token' },
    }));
    const report = JSON.parse(result.stdout);

    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`);
    assert.deepEqual(server.requests.map(request => request.method), ['GET', 'GET', 'GET', 'GET', 'GET']);
    assert.deepEqual(server.requests.map(request => request.url), [
      '/health',
      '/api/admin/areas',
      '/api/admin/analysts',
      '/api/admin/reports/summary',
      '/api/admin/bot-flows',
    ]);
    const pm2Result = report.results.find(result => result.name === 'PM2 status');
    assert.ok(pm2Result);
    assert.doesNotMatch(pm2Result.detail, /restart/i);
    assert.ok(report.results.some(result => result.name === 'Supabase network schema check' && /does not execute remote SQL or mutate\/query Supabase data/.test(result.detail)));
    assert.ok(report.results.some(result => result.name === 'Salesforce live API operations' && /no create\/update\/close\/upload calls/.test(result.detail)));
  } finally {
    await server.close();
  }
});

test('builds Windows npm test command through cmd.exe instead of executing npm.cmd directly', () => {
  const command = buildNpmCommand(['test'], {
    platform: 'win32',
    env: { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
  });

  assert.equal(command.command, 'C:\\Windows\\System32\\cmd.exe');
  assert.deepEqual(command.args, ['/d', '/s', '/c', 'npm.cmd', 'test']);
});

test('leaves non-Windows npm command executable directly', () => {
  const command = buildNpmCommand(['test'], { platform: 'linux', env: {} });

  assert.equal(command.command, 'npm');
  assert.deepEqual(command.args, ['test']);
});

test('wraps generic Windows command scripts to avoid spawn EINVAL', () => {
  const command = buildProcessCommand('tool.cmd', ['--version'], {
    platform: 'win32',
    env: {},
  });

  assert.equal(command.command, 'cmd.exe');
  assert.deepEqual(command.args, ['/d', '/s', '/c', 'tool.cmd', '--version']);
});
