const { spawnSync } = require('node:child_process');
const path = require('node:path');

function runDeploymentCheck({
  platform = process.platform,
  args = process.argv.slice(2),
  spawn = spawnSync,
  cwd = path.resolve(__dirname, '..'),
} = {}) {
  const executable = platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const script = path.join(cwd, 'scripts', 'deployment-preflight.ps1');
  const result = spawn(executable, [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-CheckOnly',
    '-Phase',
    'PreSwitch',
    '-Topology',
    'LocalLoopback',
    '-RepoRoot',
    cwd,
    ...args,
  ], { cwd, stdio: 'inherit' });

  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}

if (require.main === module) {
  try {
    process.exitCode = runDeploymentCheck();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { runDeploymentCheck };
