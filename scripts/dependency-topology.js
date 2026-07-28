const path = require('node:path');
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');

const EXCLUDED_PACKAGES = Object.freeze([
  'archiver',
  'archiver-utils',
  'brace-expansion',
  'readdir-glob',
  'zip-stream',
]);

function dependencyNames(tree, names = new Set()) {
  if (!tree || typeof tree !== 'object') return names;
  const dependencies = tree.dependencies;
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) return names;
  for (const [name, dependency] of Object.entries(dependencies)) {
    const childCount = dependency?.dependencies && typeof dependency.dependencies === 'object'
      ? Object.keys(dependency.dependencies).length
      : 0;
    if (dependency && typeof dependency === 'object' && (
      dependency.version || dependency.resolved || dependency.path || dependency.extraneous || dependency.link || childCount > 0
    )) names.add(name);
    dependencyNames(dependency, names);
  }
  return names;
}

function isInstalledDependency(dependency) {
  if (!dependency || typeof dependency !== 'object' || Array.isArray(dependency)) return false;
  return Boolean(dependency.version || dependency.resolved || dependency.path || dependency.link);
}

function assertValidProductionTree(tree, requiredDependencies, runtimeName) {
  const dependencies = tree.dependencies;
  const topLevel = dependencies && typeof dependencies === 'object' && !Array.isArray(dependencies)
    ? dependencies
    : {};

  for (const packageName of requiredDependencies) {
    if (!isInstalledDependency(topLevel[packageName]) || topLevel[packageName].missing) {
      throw new Error(`required production dependency ${packageName} is missing from ${runtimeName} runtime`);
    }
  }

  const visit = (node, packageName = runtimeName) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return;
    if (node.invalid) throw new Error(`invalid production dependency ${packageName} appears in ${runtimeName} runtime`);
    if (node.extraneous) throw new Error(`extraneous production dependency ${packageName} appears in ${runtimeName} runtime`);
    const children = node.dependencies;
    if (!children || typeof children !== 'object' || Array.isArray(children)) return;
    for (const [childName, child] of Object.entries(children)) visit(child, childName);
  };
  visit(tree);
}

function readRequiredProductionDependencies(runtimeDirectory) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(runtimeDirectory, 'package.json'), 'utf8'));
  } catch {
    throw new Error(`package.json could not be read for ${path.basename(runtimeDirectory) || 'root'} runtime`);
  }
  const dependencies = manifest?.dependencies;
  if (dependencies === undefined) return [];
  if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) {
    throw new Error(`package.json dependencies are invalid for ${path.basename(runtimeDirectory) || 'root'} runtime`);
  }
  return Object.keys(dependencies);
}

function parseNpmTree(output) {
  if (typeof output !== 'string' || !output.trim()) throw new Error('npm ls returned empty output');
  let tree;
  try {
    tree = JSON.parse(output);
  } catch {
    throw new Error('npm ls returned malformed JSON');
  }
  if (!tree || typeof tree !== 'object' || Array.isArray(tree)) throw new Error('npm ls returned an invalid tree');
  return tree;
}

function defaultResolve(packageName, runtimeDirectory) {
  return require.resolve(packageName, { paths: [runtimeDirectory] });
}

function assertPackagesDoNotResolve(runtimeDirectories, options = {}) {
  const resolvePackage = options.resolvePackage || defaultResolve;
  const excludedPackages = options.excludedPackages || EXCLUDED_PACKAGES;
  for (const runtimeDirectory of runtimeDirectories) {
    for (const packageName of excludedPackages) {
      try {
        const resolved = resolvePackage(packageName, runtimeDirectory);
        throw new Error(`excluded package ${packageName} resolves in ${path.basename(runtimeDirectory) || 'root'} runtime (${path.basename(resolved)})`);
      } catch (error) {
        if (error?.code === 'MODULE_NOT_FOUND') continue;
        throw error;
      }
    }
  }
}

function findNpmCli(options = {}) {
  if (options.npmCli) return options.npmCli;
  const executableDirectory = path.dirname(process.execPath);
  const candidates = [
    path.join(executableDirectory, 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.resolve(executableDirectory, '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    process.env.npm_execpath,
  ].filter(Boolean);
  const npmCli = candidates.find(candidate => path.extname(candidate).toLowerCase() === '.js' && fs.existsSync(candidate));
  if (!npmCli) throw new Error('npm CLI matching the active Node runtime was not found');
  return npmCli;
}

function readNpmTree(runtimeDirectory, options = {}) {
  const npmCli = findNpmCli(options);
  const npmCommand = options.npmCommand || process.execPath;
  const execute = options.execute || execFileSync;
  let output;
  try {
    output = execute(npmCommand, [npmCli, 'ls', '--all', '--json', '--omit=dev', '--omit=optional'], {
      cwd: runtimeDirectory,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 20 * 1024 * 1024,
    });
  } catch (error) {
    const code = Number.isInteger(error?.status) ? error.status : 'unknown';
    throw new Error(`npm ls failed for ${path.basename(runtimeDirectory) || 'root'} runtime (exit ${code})`);
  }
  return parseNpmTree(output);
}

function assertProductionDependencyTopology(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot || path.join(__dirname, '..'));
  const runtimeDirectories = options.runtimeDirectories || [repositoryRoot, path.join(repositoryRoot, 'backend')];
  const excludedPackages = options.excludedPackages || EXCLUDED_PACKAGES;
  assertPackagesDoNotResolve(runtimeDirectories, { ...options, excludedPackages });
  if (options.inspectNpmTree !== false) {
    for (const runtimeDirectory of runtimeDirectories) {
      const tree = readNpmTree(runtimeDirectory, options);
      const runtimeName = path.basename(runtimeDirectory) || 'root';
      const requiredDependencies = options.requiredDependenciesByRuntime?.[runtimeDirectory]
        || readRequiredProductionDependencies(runtimeDirectory);
      assertValidProductionTree(tree, requiredDependencies, runtimeName);
      const found = dependencyNames(tree);
      const violation = excludedPackages.find(packageName => found.has(packageName));
      if (violation) throw new Error(`excluded package ${violation} appears in ${path.basename(runtimeDirectory) || 'root'} production topology`);
    }
  }
  return { checkedRuntimes: runtimeDirectories.length, excludedPackages: [...excludedPackages] };
}

function enforceStartupDependencyTopology(options = {}) {
  const environment = options.environment || process.env.NODE_ENV;
  try {
    return assertProductionDependencyTopology(options);
  } catch (error) {
    const safeError = new Error('Unsafe production dependency topology; startup refused.');
    safeError.code = 'UNSAFE_DEPENDENCY_TOPOLOGY';
    if (environment === 'production') throw safeError;
    (options.logger || console).warn('unsafe_dependency_topology_allowed_outside_production', { causeCode: safeError.code });
    return null;
  }
}

module.exports = {
  EXCLUDED_PACKAGES,
  assertPackagesDoNotResolve,
  assertProductionDependencyTopology,
  assertValidProductionTree,
  dependencyNames,
  enforceStartupDependencyTopology,
  findNpmCli,
  parseNpmTree,
  readNpmTree,
};
