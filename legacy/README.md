# Legacy Entry Points

These files are LEGACY entry points from the original NEXO prototype.
They are NOT used in production.

## Production setup
Production runs via PM2 → `ecosystem.config.js` → `backend/server.js` (main backend) and `serve-frontend.js` (frontend).

- `server.js` — Legacy WhatsApp Cloud API webhook (Meta)
- `index.js` — Legacy WhatsApp bot with conversation flow

Both have a production guard (`NODE_ENV === 'production'` exits with code 78).
