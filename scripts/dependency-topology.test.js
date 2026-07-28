const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');
const {
  assertProductionDependencyTopology,
  assertValidProductionTree,
  dependencyNames,
  enforceStartupDependencyTopology,
  parseNpmTree,
} = require('./dependency-topology');

const ROOT = path.resolve(__dirname, '..');

function runEntrypointWithMockedBoundary(relativePath, mode) {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'nexo-startup-order-'));
  const preload = path.join(temporaryDirectory, 'preload.js');
  fs.writeFileSync(preload, `
const Module = require('node:module');
const excluded = new Set(['archiver', 'archiver-utils', 'brace-expansion', 'readdir-glob', 'zip-stream']);
const originalResolveFilename = Module._resolveFilename;
const originalLoad = Module._load;
require('node:child_process').execFileSync = function() {
  if (process.env.NEXO_TEST_TOPOLOGY === 'malformed') return 'not-json';
  if (process.env.NEXO_TEST_TOPOLOGY === 'nested') return JSON.stringify({ dependencies: { safe: { version: '1.0.0', dependencies: { archiver: { version: '7.0.1', dependencies: { 'brace-expansion': { version: '2.0.2' } } } } } } });
  return JSON.stringify({ dependencies: { safe: { version: '1.0.0' } } });
};
Module._resolveFilename = function(request, parent, isMain, options) {
  if (excluded.has(request)) {
    if (process.env.NEXO_TEST_TOPOLOGY === 'unsafe' && request === 'archiver') return __filename;
    const error = new Error('mocked absent package');
    error.code = 'MODULE_NOT_FOUND';
    throw error;
  }
  return originalResolveFilename.call(this, request, parent, isMain, options);
};
Module._load = function(request, parent, isMain) {
  if (request === 'dotenv') {
    process.stdout.write('DOTENV_BOUNDARY_REACHED\\n');
    process.exit(0);
  }
  return originalLoad.call(this, request, parent, isMain);
};
`);

  try {
    return spawnSync(process.execPath, ['--require', preload, path.join(ROOT, relativePath)], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', NEXO_TEST_TOPOLOGY: mode },
      timeout: 10000,
    });
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

test('rejects malformed and empty npm output', () => {
  assert.throws(() => parseNpmTree('npm warning\n{}'), /malformed JSON/);
  assert.throws(() => parseNpmTree(''), /empty output/);
});

test('finds excluded packages at any dependency depth', () => {
  const names = dependencyNames({ dependencies: { safe: { version: '1.0.0', dependencies: { archiver: { version: '7.0.1', dependencies: {} } } } } });
  assert.equal(names.has('archiver'), true);
});

test('fails closed when npm ls exits non-zero', () => {
  const missing = () => { const error = new Error('missing'); error.code = 'MODULE_NOT_FOUND'; throw error; };
  assert.throws(() => assertProductionDependencyTopology({
    runtimeDirectories: ['root'],
    resolvePackage: missing,
    execute: () => { const error = new Error('npm failed'); error.status = 1; throw error; },
  }), /npm ls failed.*exit 1/);
});

test('uses the exact npm production topology flags in npm 10 compatible order', () => {
  const missing = () => { const error = new Error('missing'); error.code = 'MODULE_NOT_FOUND'; throw error; };
  let commandArguments;
  assertProductionDependencyTopology({
    runtimeDirectories: ['root'],
    requiredDependenciesByRuntime: { root: [] },
    resolvePackage: missing,
    npmCli: 'npm-cli.js',
    execute: (_command, args) => { commandArguments = args; return '{}'; },
  });
  assert.deepEqual(commandArguments.slice(1), ['ls', '--all', '--json', '--omit=dev', '--omit=optional']);
});

test('intentionally omitted dev dependency nodemon passes', () => {
  assert.doesNotThrow(() => assertValidProductionTree({
    dependencies: { express: { version: '5.2.1' }, nodemon: {} },
  }, ['express'], 'root'));
});

test('missing required production dependency express fails', () => {
  assert.throws(() => assertValidProductionTree({ dependencies: { express: {} } }, ['express'], 'root'), /express is missing/);
});

test('missing optional archiver passes but nested installed archiver is detectable', () => {
  const omitted = { dependencies: { runtime: { version: '1.0.0' }, archiver: {} } };
  assert.doesNotThrow(() => assertValidProductionTree(omitted, ['runtime'], 'root'));
  assert.equal(dependencyNames(omitted).has('archiver'), false);

  const installed = { dependencies: { runtime: { version: '1.0.0', dependencies: { archiver: { version: '7.0.1' } } } } };
  assert.equal(dependencyNames(installed).has('archiver'), true);
});

test('invalid and extraneous production dependencies fail closed at any depth', () => {
  assert.throws(() => assertValidProductionTree({ dependencies: { express: { version: '5.2.1', invalid: true } } }, ['express'], 'root'), /invalid production dependency express/);
  assert.throws(() => assertValidProductionTree({ dependencies: { express: { version: '5.2.1', dependencies: { surprise: { version: '1.0.0', extraneous: true } } } } }, ['express'], 'root'), /extraneous production dependency surprise/);
});

test('production startup refuses a resolvable excluded package while development warns', () => {
  const resolves = packageName => `/runtime/node_modules/${packageName}/index.js`;
  assert.throws(() => enforceStartupDependencyTopology({ environment: 'production', runtimeDirectories: ['root'], resolvePackage: resolves, npmCli: 'npm-cli.js', execute: () => '{}' }), {
    code: 'UNSAFE_DEPENDENCY_TOPOLOGY',
  });
  const warnings = [];
  assert.equal(enforceStartupDependencyTopology({
    environment: 'development', runtimeDirectories: ['root'], resolvePackage: resolves, npmCli: 'npm-cli.js', execute: () => '{}',
    logger: { warn: (...args) => warnings.push(args) },
  }), null);
  assert.equal(warnings.length, 1);
});

test('root legacy production entrypoint refuses before topology, dotenv, or listen', () => {
  const result = runEntrypointWithMockedBoundary('server.js', 'unsafe');

  assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /DOTENV_BOUNDARY_REACHED/);
  assert.match(result.stderr, /LEGACY_ENTRYPOINT_DISABLED/);
});

test('root legacy production entrypoint remains disabled when topology is clean', () => {
  const result = runEntrypointWithMockedBoundary('server.js', 'clean');

  assert.equal(result.status, 78, `${result.stdout}\n${result.stderr}`);
  assert.doesNotMatch(result.stdout, /DOTENV_BOUNDARY_REACHED/);
  assert.match(result.stderr, /LEGACY_ENTRYPOINT_DISABLED/);
});

test('all supported direct production server entrypoints enforce topology intrinsically', () => {
  const entrypoints = ['backend/server.js', 'serve-frontend.js'];
  for (const relativePath of entrypoints) {
    const source = fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
    const assertion = source.indexOf('enforceStartupDependencyTopology({');
    assert.notEqual(assertion, -1, `${relativePath} lacks an intrinsic topology assertion`);
    for (const boundary of ["require('dotenv').config()", 'express()', 'createServer(', '.initialize()', '.listen(']) {
      const boundaryIndex = source.indexOf(boundary);
      if (boundaryIndex !== -1) assert.ok(assertion < boundaryIndex, `${relativePath} asserts topology after ${boundary}`);
    }
  }
});

test('all production entrypoints reject a nested excluded chain that is not root-resolvable', () => {
  for (const relativePath of ['backend/server.js', 'serve-frontend.js']) {
    const result = runEntrypointWithMockedBoundary(relativePath, 'nested');
    assert.notEqual(result.status, 0, `${relativePath}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Unsafe production dependency topology; startup refused/, relativePath);
    assert.doesNotMatch(result.stdout, /DOTENV_BOUNDARY_REACHED/, relativePath);
  }
});

test('all production entrypoints fail closed when the recursive inspector is malformed', () => {
  for (const relativePath of ['backend/server.js', 'serve-frontend.js']) {
    const result = runEntrypointWithMockedBoundary(relativePath, 'malformed');
    assert.notEqual(result.status, 0, `${relativePath}\n${result.stdout}\n${result.stderr}`);
    assert.match(result.stderr, /Unsafe production dependency topology; startup refused/, relativePath);
  }
});

test('clean recursive topology proceeds and development keeps warning policy', () => {
  const missing = () => { const error = new Error('missing'); error.code = 'MODULE_NOT_FOUND'; throw error; };
  assert.deepEqual(enforceStartupDependencyTopology({
    environment: 'production', runtimeDirectories: ['root', 'backend'], resolvePackage: missing,
    requiredDependenciesByRuntime: { root: ['safe'], backend: ['safe'] },
    npmCli: 'npm-cli.js', execute: () => '{"dependencies":{"safe":{"version":"1.0.0"}}}',
  }), { checkedRuntimes: 2, excludedPackages: ['archiver', 'archiver-utils', 'brace-expansion', 'readdir-glob', 'zip-stream'] });

  const warnings = [];
  assert.equal(enforceStartupDependencyTopology({
    environment: 'development', runtimeDirectories: ['root'], resolvePackage: missing,
    npmCli: 'npm-cli.js', execute: () => 'malformed', logger: { warn: (...args) => warnings.push(args) },
  }), null);
  assert.equal(warnings.length, 1);
});
