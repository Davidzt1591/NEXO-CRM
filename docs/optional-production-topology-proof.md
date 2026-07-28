# Optional-free production topology proof

Captured locally on 2026-07-24 with the repository-pinned Node.js `v22.23.1`. This evidence describes a temporary production install created from the checked-in lockfiles; no deployment, PM2 mutation, remote mutation, or commit occurred.

## Production tree (before development restore)

| Runtime | Exact install | Installed/audited | Audit | Exclusion proof |
|---|---|---:|---:|---|
| Root | `npm ci --omit=dev --omit=optional` | 198 packages | 0 vulnerabilities | Passed |
| Backend | `npm ci --omit=dev --omit=optional` | 222 packages | 0 vulnerabilities | Passed |

The shared verifier inspected both complete recursive `npm ls --all --json --omit=dev --omit=optional` production trees, cross-checked only each manifest's required `dependencies`, and attempted `require.resolve` from both actual runtime directories. Intentionally omitted `devDependencies` and `optionalDependencies` are not treated as missing. Five excluded names were absent: `archiver`, `archiver-utils`, `brace-expansion`, `readdir-glob`, and `zip-stream`.

## Runtime proof on the production tree

- Backend full Node test suite: 379/379 passed, including startup hydration, session, socket, and authentication coverage.
- Real `whatsapp-web.js` `Client` constructed with a real `LocalAuth` and a sentinel temp `dataPath`; strategy and normalized path assertions passed. `initialize` was not called.
- Root Node diagnostic/topology tests: 12/12 passed.
- Static frontend server smoke: HTTP 200 from the existing built `frontend/dist`.
- Chromium smoke: launched headless and loaded `about:blank` successfully; no WhatsApp connection was attempted.

## Current tree after evidence capture

Root and backend currently retain the production installs described above. Development and optional dependencies, including `nodemon` and the RemoteAuth `archiver` chain, are intentionally omitted. Do not reinstall the development topology before the deployment retry.

After restore, the full Node 22 verification passed: root diagnostics 12/12, backend 379/379, frontend 230/230; frontend lint and production build also passed. A production-mode static-server launch against the restored development tree exited before `listen` with safe code `UNSAFE_DEPENDENCY_TOPOLOGY`, proving direct startup cannot bypass the in-process gate.

PowerShell 7 (`pwsh`) was unavailable on this Windows host, so `-CheckOnly` could not be executed locally. CI executes the same non-mutating check under `pwsh` on Ubuntu.
