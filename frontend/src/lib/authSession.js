import { getBackendOrigin } from './backendOrigin';

export const AUTH_INVALIDATED_EVENT = 'nexo:auth-invalidated';
export const INVALID_AUTH_CODES = new Set(['AUTH_INVALID', 'AUTH_REVOKED']);

const SESSION_URL = `${getBackendOrigin()}/api/session`;

// Purge the legacy bearer before any application request can run.
try { localStorage.removeItem('nexo_token'); } catch { /* storage may be unavailable */ }

export async function createSession(token) {
  const response = await fetch(SESSION_URL, {
    method: 'POST', credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ token }),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error || 'No se pudo iniciar sesión.');
    error.code = data?.code;
    throw error;
  }
  return data;
}

export async function restoreSession() {
  let response;
  try { response = await fetch(SESSION_URL, { credentials: 'include' }); }
  catch (cause) { const error = new Error('No pudimos verificar tu sesión.'); error.code = 'AUTH_UNAVAILABLE'; error.cause = cause; throw error; }
  const data = await response.json().catch(() => null);
  if (response.status === 401) return { authenticated: false, code: data?.code };
  if (!response.ok) { const error = new Error('No pudimos verificar tu sesión.'); error.code = 'AUTH_UNAVAILABLE'; throw error; }
  return data;
}

export async function restoreSessionWithRetry({ attempts = 3, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try { return await restoreSession(); }
    catch (error) {
      lastError = error;
      if (error.code !== 'AUTH_UNAVAILABLE' || attempt === attempts - 1) throw error;
      await sleep(500 * (2 ** attempt));
    }
  }
  throw lastError;
}

export async function deleteSession() {
  try { await fetch(SESSION_URL, { method: 'DELETE', credentials: 'include' }); } catch { /* UI logout is immediate */ }
  try { localStorage.removeItem('nexo_token'); } catch { /* storage may be unavailable */ }
}

export function invalidateCurrentSession({ code } = {}) {
  if (!INVALID_AUTH_CODES.has(code)) return false;
  void deleteSession();
  window.dispatchEvent(new CustomEvent(AUTH_INVALIDATED_EVENT, { detail: { code } }));
  return true;
}
