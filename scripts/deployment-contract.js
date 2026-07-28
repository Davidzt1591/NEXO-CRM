const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');

const EXPECTED_NODE = '22.23.1';
const ACCEPTED_PREDECESSOR_NODE = '25.6.1';

function assertCommandResult(name, result) {
  if (!result || result.error || result.status !== 0) throw new Error(`${name} failed with exit ${result?.status ?? 'unavailable'}: ${result?.error?.message || result?.stderr || ''}`);
}

function assertEnvironment(env, topology, external = {}) {
  for (const name of ['SUPABASE_URL', 'SALESFORCE_CLIENT_ID']) if (!String(env[name] || '').trim()) throw new Error(`Missing environment variable: ${name}`);
  if (topology === 'LocalLoopback') {
    const expected = { HOST: '127.0.0.1', ALLOWED_ORIGINS: 'http://localhost:5173', ALLOW_INSECURE_LOCAL_COOKIE: 'true', SESSION_COOKIE_SECURE: 'false', TRUST_PROXY_CIDRS: '' };
    for (const [name, value] of Object.entries(expected)) if (String(env[name] ?? '') !== value) throw new Error(`LocalLoopback ${name} must equal ${JSON.stringify(value)}`);
    return;
  }
  if (topology === 'ReverseProxyHttps') {
    if (!String(external.allowedOrigins || '').trim()) throw new Error('ReverseProxyHttps requires explicit allowed origins');
    if (external.sessionCookieSecure !== 'true') throw new Error('ReverseProxyHttps requires secure cookies');
    if (!String(external.trustedProxyCidrs || '').trim()) throw new Error('ReverseProxyHttps requires explicit trusted proxy CIDRs');
    return;
  }
  throw new Error(`Unsupported topology: ${topology || '<unset>'}`);
}

function assertPm2Available(pm2Path) {
  if (!pm2Path || !fs.existsSync(pm2Path)) throw new Error(`PM2 CLI missing: ${pm2Path || '<unset>'}`);
}

function normalizeListeners(rows) {
  return rows.map((row) => ({
    address: String(row.address || row.LocalAddress),
    port: Number(row.port || row.LocalPort),
    pid: Number(row.pid || row.OwningProcess),
    process: String(row.process || row.Name || ''),
    command: String(row.command || row.CommandLine || ''),
  })).sort((a, b) => a.port - b.port || a.address.localeCompare(b.address) || a.pid - b.pid);
}

function assertHealthBody(body) {
  const keys = body && typeof body === 'object' && !Array.isArray(body) ? Object.keys(body).sort() : [];
  if (keys.join(',') !== 'ready,status' || body.status !== 'ready' || body.ready !== true) {
    throw new Error('Health response must be exactly {"status":"ready","ready":true}');
  }
}

function assertListenerOwnership(listeners, expectedByPort, options = {}) {
  const daemonPid = Number(options.pm2DaemonPid || 0);
  const daemonCommandFragment = String(options.pm2DaemonCommandFragment || '');
  const errors = [];
  const normalized = normalizeListeners(listeners);
  for (const listener of normalized) {
    const expected = expectedByPort[listener.port];
    const appOwned = expected && listener.pid === Number(expected.pid) && listener.command.includes(expected.commandFragment);
    const daemonOwned = expected && daemonPid > 0 && listener.pid === daemonPid && daemonCommandFragment && listener.command.includes(daemonCommandFragment);
    if (!appOwned && !daemonOwned) {
      errors.push(`Unexpected listener ${listener.address}:${listener.port} PID ${listener.pid} ${listener.process} ${listener.command}`);
    }
  }
  for (const [port, expected] of Object.entries(expectedByPort)) {
    if (!normalized.some((item) => Number(item.port) === Number(port) && (Number(item.pid) === Number(expected.pid) || (daemonPid > 0 && Number(item.pid) === daemonPid)))) {
      errors.push(`Expected listener missing on port ${port} for PID ${expected.pid}`);
    }
  }
  if (errors.length) throw new Error(errors.join('\n'));
}

function assertPm2Node22(report, apps) {
  if (!report || report.daemonNodeVersion !== EXPECTED_NODE) throw new Error(`PM2 daemon must use Node ${EXPECTED_NODE}`);
  const invalid = apps.filter((app) => app.nodeVersion !== EXPECTED_NODE || app.status !== 'online');
  if (invalid.length) throw new Error(`PM2 apps must be online on Node ${EXPECTED_NODE}: ${invalid.map((x) => x.name).join(', ')}`);
}

function assertPreSwitchPm2(report, apps, acceptanceEvidence) {
  if (!String(acceptanceEvidence || '').trim()) throw new Error('PreSwitch requires explicit no-rollback acceptance evidence');
  if (!report || report.daemonNodeVersion !== ACCEPTED_PREDECESSOR_NODE) throw new Error(`PreSwitch predecessor daemon must use Node ${ACCEPTED_PREDECESSOR_NODE}`);
  const invalid = apps.filter((app) => app.nodeVersion !== ACCEPTED_PREDECESSOR_NODE || app.status !== 'online');
  if (invalid.length) throw new Error(`PreSwitch predecessor apps must be online on Node ${ACCEPTED_PREDECESSOR_NODE}: ${invalid.map((x) => x.name).join(', ')}`);
}

function parsePm2DaemonNodeVersion(report) {
  try {
    const text = String(report || '');
    const header = /^---\s+Daemon\s+-+\s*$/m.exec(text);
    if (!header) throw new Error();
    const tail = text.slice(header.index + header[0].length);
    const nextSection = /^---\s+.+?\s+-+\s*$/m.exec(tail);
    const daemonSection = nextSection ? tail.slice(0, nextSection.index) : tail;
    const versions = [...daemonSection.matchAll(/^\s*node version\s*(?:\||:)\s*([0-9]+\.[0-9]+\.[0-9]+)\s*$/gmi)];
    if (versions.length !== 1) throw new Error();
    return versions[0][1];
  } catch {
    throw new Error('PM2 daemon report invalid.');
  }
}

function hashDirectory(root) {
  const hash = crypto.createHash('sha256');
  const visit = (dir) => fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).forEach((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) visit(full);
    else { hash.update(path.relative(root, full).replaceAll('\\', '/')); hash.update(fs.readFileSync(full)); }
  });
  visit(root);
  return hash.digest('hex');
}

function assertFrontendHash(dist, expectedHash) {
  const actual = hashDirectory(dist);
  if (actual !== expectedHash) throw new Error(`Frontend dist hash mismatch. Expected ${expectedHash}, got ${actual}`);
  return actual;
}

function pollHealth({ host, port, expectedPid, listenerProvider, attempts = 20, delayMs = 250 }) {
  return new Promise((resolve, reject) => {
    let remaining = attempts;
    const attempt = () => {
      const req = http.get({ host, port, path: '/health', timeout: 1000 }, (res) => {
        let body = '';
        res.setEncoding('utf8'); res.on('data', (chunk) => { body += chunk; });
        res.on('end', async () => {
          try {
            const parsed = JSON.parse(body);
            if (res.statusCode !== 200 || parsed.status !== 'ok' || parsed.ready !== true || Object.keys(parsed).sort().join(',') !== 'ready,status') throw new Error('wrong health body');
            const listeners = await listenerProvider();
            if (!listeners.some((x) => Number(x.port) === Number(port) && Number(x.pid) === Number(expectedPid))) throw new Error('health PID attribution mismatch');
            resolve(parsed);
          } catch (error) { retry(error); }
        });
      });
      req.on('error', retry); req.on('timeout', () => req.destroy(new Error('health timeout')));
    };
    const retry = (error) => { if (--remaining <= 0) reject(error); else setTimeout(attempt, delayMs); };
    attempt();
  });
}

module.exports = { ACCEPTED_PREDECESSOR_NODE, EXPECTED_NODE, assertCommandResult, assertEnvironment, assertFrontendHash, assertHealthBody, assertListenerOwnership, assertPm2Available, assertPm2Node22, assertPreSwitchPm2, hashDirectory, normalizeListeners, parsePm2DaemonNodeVersion, pollHealth };
