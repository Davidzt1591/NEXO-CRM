#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_BASE_URL = 'http://localhost:3001';
const TIMEOUT_MS = Number(process.env.NEXO_DIAG_TIMEOUT_MS || 5000);

const args = new Set(process.argv.slice(2));
const jsonMode = args.has('--json');
const withTests = args.has('--with-tests');
const help = args.has('--help') || args.has('-h');
const baseUrl = readArgValue('--base-url') || process.env.NEXO_DIAG_BASE_URL || DEFAULT_BASE_URL;
const safeBaseUrl = redactUrl(baseUrl);
const requestBaseUrl = normalizeBaseUrl(baseUrl);
const safeRequestBaseUrl = redactUrl(requestBaseUrl);
const token = process.env.NEXO_DIAG_TOKEN;

const results = [];

function readArgValue(name) {
  const argv = process.argv.slice(2);
  const eq = argv.find(arg => arg.startsWith(`${name}=`));
  if (eq) return eq.slice(name.length + 1);
  const index = argv.indexOf(name);
  if (index >= 0 && argv[index + 1] && !argv[index + 1].startsWith('--')) return argv[index + 1];
  return null;
}

function redactUrl(value) {
  try {
    const url = new URL(value);
    if (url.username) url.username = 'REDACTED';
    if (url.password) url.password = 'REDACTED';
    for (const key of url.searchParams.keys()) {
      url.searchParams.set(key, 'REDACTED');
    }
    return url.toString();
  } catch {
    return String(value).replace(/\/\/([^/@\s:]+)(?::([^/@\s]+))?@/g, '//REDACTED:REDACTED@');
  }
}

function redactText(value) {
  return String(value).replaceAll(baseUrl, safeBaseUrl);
}

function normalizeBaseUrl(value) {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return String(value).replace(/\/$/, '');
  }
}

function backendUrl(route) {
  return `${requestBaseUrl}${route}`;
}

function displayBackendUrl(route) {
  return `${safeRequestBaseUrl.replace(/\/$/, '')}${route}`;
}

function add(status, name, detail, metadata = {}) {
  results.push({ status, name, detail, ...metadata });
}

function hasEnvKey(filePath, key) {
  if (!fs.existsSync(filePath)) return false;
  const content = fs.readFileSync(filePath, 'utf8');
  return content.split(/\r?\n/).some(line => {
    const trimmed = line.trim();
    return trimmed && !trimmed.startsWith('#') && trimmed.startsWith(`${key}=`);
  });
}

function envKeyPresent(key, files) {
  if (process.env[key]) return { present: true, source: 'process.env' };
  for (const file of files) {
    if (hasEnvKey(file, key)) return { present: true, source: path.relative(ROOT, file) };
  }
  return { present: false, source: null };
}

function fileExists(relativePath) {
  return fs.existsSync(path.join(ROOT, relativePath));
}

function runCommand(command, commandArgs, options = {}) {
  const processCommand = buildProcessCommand(command, commandArgs, {
    platform: options.platform || process.platform,
    env: options.env || process.env,
  });

  return execFileSync(processCommand.command, processCommand.args, {
    cwd: options.cwd || ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: options.timeout || TIMEOUT_MS,
    windowsHide: true,
  });
}

function buildProcessCommand(command, commandArgs, options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const isWindowsCommandScript = platform === 'win32' && /\.(?:cmd|bat)$/i.test(command);

  if (!isWindowsCommandScript) {
    return { command, args: commandArgs };
  }

  return {
    command: env.ComSpec || 'cmd.exe',
    args: ['/d', '/s', '/c', command, ...commandArgs],
  };
}

function buildNpmCommand(commandArgs, options = {}) {
  const platform = options.platform || process.platform;
  return buildProcessCommand(platform === 'win32' ? 'npm.cmd' : 'npm', commandArgs, options);
}

async function fetchJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: options.method || 'GET',
      headers: options.headers || {},
      signal: controller.signal,
    });
    const contentType = response.headers.get('content-type') || '';
    const text = await response.text();
    let body = null;
    if (contentType.includes('application/json') && text) {
      try { body = JSON.parse(text); } catch { body = null; }
    }
    return { ok: response.ok, status: response.status, contentType, body, text };
  } finally {
    clearTimeout(timeout);
  }
}

function printHelp() {
  console.log(`NEXO read-only diagnostic runner\n\nUsage:\n  node scripts/diagnose-nexo.js [--json] [--with-tests] [--base-url URL]\n\nEnvironment:\n  NEXO_DIAG_BASE_URL   Backend URL. Default: ${DEFAULT_BASE_URL}\n  NEXO_DIAG_TOKEN      Optional dashboard token for protected read-only API checks. Never printed.\n  NEXO_DIAG_TIMEOUT_MS Per-check timeout in milliseconds. Default: ${TIMEOUT_MS}\n\nExit code:\n  0 when checks are OK, WARN, or SKIPPED only.\n  1 when any check FAILS.`);
}

function checkEnvironment() {
  const envFiles = [path.join(ROOT, '.env'), path.join(ROOT, 'backend', '.env')];
  const keys = [
    'SUPABASE_URL',
    'SUPABASE_ANON_KEY',
    'SALESFORCE_CLIENT_ID',
    'SALESFORCE_CLIENT_SECRET',
    'SALESFORCE_PRIVATE_KEY',
    'SALESFORCE_PRIVATE_KEY_PATH',
    'SALESFORCE_USERNAME',
    'FRONTEND_URL',
  ];

  const existingFiles = envFiles.filter(fs.existsSync).map(file => path.relative(ROOT, file));
  if (existingFiles.length) {
    add('OK', 'Environment files', `Found ${existingFiles.join(', ')}. Secret values were not printed.`);
  } else {
    add('WARN', 'Environment files', 'No root or backend .env file found. This may be expected in CI if variables are injected.');
  }

  for (const key of keys) {
    const found = envKeyPresent(key, envFiles);
    const required = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SALESFORCE_CLIENT_ID'].includes(key);
    if (found.present) {
      add('OK', `Config key ${key}`, `Present via ${found.source}. Value hidden.`);
    } else {
      add(required ? 'WARN' : 'SKIPPED', `Config key ${key}`, `${key} is not present in process.env or checked env files.`);
    }
  }

  if (!process.env.NODE_TLS_REJECT_UNAUTHORIZED || process.env.NODE_TLS_REJECT_UNAUTHORIZED !== '0') {
    add('OK', 'TLS safety', 'NODE_TLS_REJECT_UNAUTHORIZED is not disabled for this diagnostic process.');
  } else {
    add('WARN', 'TLS safety', 'NODE_TLS_REJECT_UNAUTHORIZED=0 is active; avoid disabling TLS verification globally.');
  }
}

function checkStaticArtifacts() {
  const expected = [
    'ecosystem.config.js',
    'backend/src/routes/admin.js',
    'backend/src/routes/salesforce.js',
    'backend/supabase/admin_phase_1.sql',
    'backend/supabase/admin_phase_3_bot_flows.sql',
    'backend/supabase/phase4_routing_indexes.sql',
    'backend/supabase/phase5_salesforce_media_reports.sql',
  ];

  for (const artifact of expected) {
    add(fileExists(artifact) ? 'OK' : 'WARN', `Static artifact ${artifact}`, fileExists(artifact) ? 'Found.' : 'Missing.');
  }

  add('SKIPPED', 'Supabase network schema check', 'Skipped by design: this runner does not execute remote SQL or mutate/query Supabase data. Static SQL artifacts and config presence are checked instead.');
  add('SKIPPED', 'Salesforce live API operations', 'Skipped by design: no create/update/close/upload calls are made. Connectivity can be inferred through backend safe endpoints when explicitly exposed.');
}

function checkPm2() {
  const command = process.platform === 'win32' ? 'pm2.cmd' : 'pm2';
  try {
    const output = runCommand(command, ['jlist']);
    const processes = JSON.parse(output);
    const names = processes.map(proc => ({ name: proc.name, status: proc.pm2_env?.status || 'unknown' }));
    const nexo = names.filter(proc => proc.name && proc.name.startsWith('nexo-'));
    if (nexo.length) {
      add('OK', 'PM2 status', `Found ${nexo.map(proc => `${proc.name}:${proc.status}`).join(', ')}.`);
    } else {
      add('WARN', 'PM2 status', 'PM2 is available, but no nexo-* process was found.');
    }
  } catch (error) {
    add('SKIPPED', 'PM2 status', `PM2 jlist was not available or did not respond within ${TIMEOUT_MS}ms. No process-control command was issued.`);
  }
}

async function checkBackend() {
  try {
    const health = await fetchJson(backendUrl('/health'));
    if (health.ok && health.body?.status === 'ok') {
      add('OK', 'Backend health', `GET /health returned ${health.status} with status=ok.`);
    } else {
      add('FAIL', 'Backend health', `GET /health returned HTTP ${health.status}.`);
    }
  } catch (error) {
    add('FAIL', 'Backend health', `Could not reach ${displayBackendUrl('/health')}: ${redactText(error.message)}.`);
  }

  if (!token) {
    add('SKIPPED', 'Protected API smoke checks', 'NEXO_DIAG_TOKEN is not set. Protected read-only checks were skipped, not failed.');
    return;
  }

  const headers = { Authorization: `Bearer ${token}` };
  const checks = [
    ['/api/admin/areas', 'Admin areas'],
    ['/api/admin/analysts', 'Admin analysts'],
    ['/api/admin/reports/summary', 'Admin report summary'],
    ['/api/admin/bot-flows', 'Admin bot flows'],
  ];

  for (const [route, label] of checks) {
    try {
      const response = await fetchJson(backendUrl(route), { headers });
      if (response.ok) {
        add('OK', label, `GET ${route} returned HTTP ${response.status}.`);
      } else if (response.status === 401 || response.status === 403) {
        add('WARN', label, `GET ${route} returned HTTP ${response.status}. Token is present but not authorized for this check.`);
      } else {
        add('FAIL', label, `GET ${route} returned HTTP ${response.status}.`);
      }
    } catch (error) {
      add('FAIL', label, `GET ${route} failed: ${redactText(error.message)}.`);
    }
  }
}

function checkTests() {
  if (!withTests) {
    add('SKIPPED', 'Backend test runner', 'Skipped by default. Run with --with-tests to execute npm test in backend/.');
    return;
  }

  try {
    const npmCommand = buildNpmCommand(['test']);
    runCommand(npmCommand.command, npmCommand.args, {
      cwd: path.join(ROOT, 'backend'),
      timeout: Number(process.env.NEXO_DIAG_TEST_TIMEOUT_MS || 120000),
    });
    add('OK', 'Backend test runner', 'backend npm test completed successfully.');
  } catch (error) {
    add('FAIL', 'Backend test runner', `backend npm test failed or timed out. ${error.message}`);
  }
}

function renderSummary() {
  const counts = results.reduce((acc, result) => {
    acc[result.status] = (acc[result.status] || 0) + 1;
    return acc;
  }, {});
  const failed = counts.FAIL || 0;
  const status = failed ? 'FAIL' : 'OK';
  const report = {
    tool: 'diagnose-nexo',
    status,
    baseUrl: safeBaseUrl,
    generatedAt: new Date().toISOString(),
    counts,
    results,
  };

  if (jsonMode) {
    console.log(JSON.stringify(report, null, 2));
    return failed ? 1 : 0;
  }

  console.log('Diagnóstico NEXO (solo lectura)');
  console.log(`Base URL: ${safeBaseUrl}`);
  console.log(`Resumen: ${status} | OK ${counts.OK || 0} | WARN ${counts.WARN || 0} | SKIPPED ${counts.SKIPPED || 0} | FAIL ${counts.FAIL || 0}`);
  console.log('');

  for (const result of results) {
    console.log(`[${result.status}] ${result.name} — ${result.detail}`);
  }

  if (failed) {
    console.log('\nResultado: se encontraron fallos. Revisá los checks marcados como FAIL.');
  } else {
    console.log('\nResultado: sin fallos. Warnings/skips pueden requerir configuración adicional.');
  }
  return failed ? 1 : 0;
}

async function main() {
  if (help) {
    printHelp();
    return 0;
  }

  checkEnvironment();
  checkStaticArtifacts();
  checkPm2();
  await checkBackend();
  checkTests();
  return renderSummary();
}

if (require.main === module) {
  main()
    .then(code => { process.exitCode = code; })
    .catch(error => {
      if (jsonMode) {
        console.log(JSON.stringify({ tool: 'diagnose-nexo', status: 'FAIL', error: redactText(error.message) }, null, 2));
      } else {
        console.error(`Diagnóstico NEXO falló: ${redactText(error.message)}`);
      }
      process.exitCode = 1;
    });
}

module.exports = {
  buildNpmCommand,
  buildProcessCommand,
};
