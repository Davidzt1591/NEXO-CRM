const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const FAILURE = 'PM2 projection failed.';

function fail() {
  throw new Error(FAILURE);
}

function projectPm2Output(rawOutput) {
  try {
    const raw = String(rawOutput);
    const start = raw.indexOf('[');
    const end = raw.lastIndexOf(']');
    if (start < 0 || end < start) fail();
    const apps = JSON.parse(raw.slice(start, end + 1));
    if (!Array.isArray(apps)) fail();
    return apps.map((app) => {
      if (!app || typeof app !== 'object' || Array.isArray(app)) fail();
      const env = app.pm2_env;
      const host = env && Object.prototype.hasOwnProperty.call(env, 'HOST') ? env.HOST : null;
      if (typeof app.name !== 'string' || !app.name || !Number.isInteger(app.pid) || app.pid < 0
        || !env || typeof env !== 'object' || Array.isArray(env)
        || typeof env.status !== 'string' || !env.status
        || typeof env.node_version !== 'string' || !env.node_version
        || (host !== null && typeof host !== 'string')) fail();
      return { name: app.name, pid: app.pid, status: env.status, nodeVersion: env.node_version, host };
    });
  } catch {
    fail();
  }
}

function loadPm2Projection(pm2Path, runner = spawnSync) {
  const result = runner(process.execPath, [pm2Path, 'jlist'], { encoding: 'utf8', windowsHide: true });
  if (!result || result.status !== 0 || result.error) fail();
  return projectPm2Output(result.stdout);
}

function runCli(argv = process.argv.slice(2)) {
  try {
    let projected;
    if (argv[0] === '--fixture') {
      if (process.env.NEXO_PM2_PROJECTOR_TEST_FIXTURES !== '1' || argv.length !== 2) fail();
      projected = projectPm2Output(fs.readFileSync(argv[1], 'utf8'));
    } else {
      if (argv.length !== 1) fail();
      projected = loadPm2Projection(argv[0]);
    }
    process.stdout.write(JSON.stringify(projected));
  } catch {
    process.stderr.write(`${FAILURE}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) runCli();

module.exports = { FAILURE, loadPm2Projection, projectPm2Output, runCli };
