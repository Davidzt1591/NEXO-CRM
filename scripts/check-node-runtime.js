const { execFileSync } = require('node:child_process');

const RELEASE_NODE = '22.23.1';

function detectNpmVersion() {
  const userAgentMatch = process.env.npm_config_user_agent?.match(/npm\/(\d+\.\d+\.\d+)/);
  if (userAgentMatch) return userAgentMatch[1];
  if (!process.env.npm_execpath) return null;
  try {
    return execFileSync(process.execPath, [process.env.npm_execpath, '--version'], { encoding: 'utf8' }).trim();
  } catch {
    return null;
  }
}

const npmVersion = detectNpmVersion();
const npmMajor = npmVersion ? Number(npmVersion.split('.')[0]) : NaN;
const [nodeMajor, nodeMinor] = process.versions.node.split('.').map(Number);
// CI and local verification accept any Node 22.x (matching package.json engines: >=22.12 <23).
// The strict exact-version check (RELEASE_NODE) is enforced only at production deployment time
// by deployment-preflight.ps1 and deployment-contract.js.
const supported = nodeMajor === 22
  && nodeMinor >= 12
  && npmMajor >= 10
  && npmMajor < 12;
const unsafe = process.argv.includes('--unsafe');

if (!supported) {
  const message = `[runtime] Unsupported runtime: Node.js ${process.version}, npm ${npmVersion || 'unknown'}. NEXO release verification requires Node.js >=22.12 <23 and npm >=10 <12.`;
  if (unsafe) {
    console.warn(`${message} Continuing ONLY because --unsafe was explicitly requested for local diagnosis.`);
  } else {
    console.error(message);
    process.exitCode = 1;
  }
} else {
  console.log(`[runtime] Supported runtime: Node.js ${process.version}, npm ${npmVersion}.`);
}
