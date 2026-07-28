import { useCallback, useEffect, useRef, useState } from 'react';
import { AUTH_INVALIDATED_EVENT, createSession, deleteSession, restoreSessionWithRetry } from '../../lib/authSession';

export function useSessionLifecycle({ clearSensitiveState, socket, onPrincipal, onLogout }) {
  const [authenticated, setAuthenticated] = useState(null); const [unavailable, setUnavailable] = useState(false); const [error, setError] = useState(null); const [pending, setPending] = useState(false);
  const tokenInputRef = useRef(null); const headingRef = useRef(null); const statusRef = useRef(null);
  const restore = useCallback(() => { let active = true; setUnavailable(false); restoreSessionWithRetry().then(session => { if (!active) return; setAuthenticated(Boolean(session.authenticated)); if (session.principal) onPrincipal(session.principal); }).catch(() => { if (!active) return; setUnavailable(true); requestAnimationFrame(() => statusRef.current?.focus()); }); return () => { active = false; }; }, [onPrincipal]);
  useEffect(() => restore(), [restore]);
  useEffect(() => { const invalidated = event => { setError(event.detail?.code === 'AUTH_REVOKED' ? 'Tu acceso fue revocado.' : 'Tu token ya no es válido. Ingresá nuevamente.'); setAuthenticated(false); onLogout(); clearSensitiveState(); socket.disconnect(); requestAnimationFrame(() => { headingRef.current?.focus(); tokenInputRef.current?.focus(); }); }; window.addEventListener(AUTH_INVALIDATED_EVENT, invalidated); return () => window.removeEventListener(AUTH_INVALIDATED_EVENT, invalidated); }, [clearSensitiveState, onLogout, socket]);
  const login = async token => { setPending(true); try { const session = await createSession(token); onPrincipal(session.principal || null); setError(null); setAuthenticated(true); } catch (loginError) { setError(loginError.code === 'AUTH_REVOKED' ? 'Tu acceso fue revocado.' : loginError.message); setAuthenticated(false); requestAnimationFrame(() => tokenInputRef.current?.focus()); } finally { setPending(false); } };
  const logout = useCallback(() => { void deleteSession(); setAuthenticated(false); onLogout(); clearSensitiveState(); socket.disconnect(); }, [clearSensitiveState, onLogout, socket]);
  return { authenticated, setAuthenticated, unavailable, error, setError, pending, restore, login, logout, tokenInputRef, headingRef, statusRef };
}
