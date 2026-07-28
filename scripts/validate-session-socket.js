const { createRequire } = require('node:module');
const path = require('node:path');

const token = process.env.NEXO_RELEASE_VALIDATION_TOKEN;
const baseUrl = process.env.NEXO_RELEASE_BASE_URL;
const origin = process.env.NEXO_RELEASE_ORIGIN;
if (!token || !baseUrl || !origin) throw new Error('Release session/socket validation requires token, base URL, and origin');

async function main() {
  const login = await fetch(`${baseUrl}/api/session`, {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  if (!login.ok) throw new Error(`Session creation failed: HTTP ${login.status}`);
  const cookie = login.headers.getSetCookie?.()[0] || login.headers.get('set-cookie');
  if (!cookie) throw new Error('Session creation did not return a cookie');
  const cookiePair = cookie.split(';', 1)[0];

  const restore = await fetch(`${baseUrl}/api/session`, { headers: { Origin: origin, Cookie: cookiePair } });
  if (!restore.ok) throw new Error(`Session restore failed: HTTP ${restore.status}`);

  const frontendRequire = createRequire(path.join(process.cwd(), 'frontend', 'package.json'));
  const { io } = frontendRequire('socket.io-client');
  await new Promise((resolve, reject) => {
    const socket = io(baseUrl, { transports: ['websocket'], extraHeaders: { Origin: origin, Cookie: cookiePair }, reconnection: false, timeout: 5000 });
    const timer = setTimeout(() => { socket.close(); reject(new Error('Socket validation timed out')); }, 6000);
    socket.on('connect', () => { clearTimeout(timer); socket.close(); resolve(); });
    socket.on('connect_error', (error) => { clearTimeout(timer); socket.close(); reject(error); });
  });

  const logout = await fetch(`${baseUrl}/api/session`, { method: 'DELETE', headers: { Origin: origin, Cookie: cookiePair } });
  if (!logout.ok) throw new Error(`Session cleanup failed: HTTP ${logout.status}`);
  console.log('Release session and socket validation passed.');
}

main().catch((error) => { console.error(error.message); process.exitCode = 1; });
