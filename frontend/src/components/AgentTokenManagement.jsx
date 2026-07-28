import { useCallback, useEffect, useState } from 'react';
import { Check, Clipboard, KeyRound, RefreshCw, ShieldX } from 'lucide-react';
import { apiRequest, jsonBody } from '../lib/apiClient';
import { AUTH_INVALIDATED_EVENT } from '../lib/authSession';

export default function AgentTokenManagement({ onInventoryChange }) {
  const [tokens, setTokens] = useState([]);
  const [name, setName] = useState('');
  const [reveal, setReveal] = useState(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const [status, setStatus] = useState('');

  const applyInventory = useCallback((nextTokens) => {
    const safeTokens = Array.isArray(nextTokens) ? nextTokens : [];
    setTokens(safeTokens);
    onInventoryChange(safeTokens);
  }, [onInventoryChange]);

  const loadInventory = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result = await apiRequest('/api/admin/agent-tokens');
      applyInventory(result?.tokens);
    } catch {
      applyInventory([]);
      setError('No se pudo cargar el inventario de tokens.');
    } finally {
      setLoading(false);
    }
  }, [applyInventory]);

  useEffect(() => {
    const clearReveal = () => setReveal(null);
    window.addEventListener(AUTH_INVALIDATED_EVENT, clearReveal);
    void loadInventory();
    return () => {
      clearReveal();
      window.removeEventListener(AUTH_INVALIDATED_EVENT, clearReveal);
    };
  }, [loadInventory]);

  const createToken = async (event) => {
    event.preventDefault();
    const normalizedName = name.trim();
    if (!normalizedName || pending) return;
    setPending(true); setError(''); setStatus(''); setReveal(null);
    try {
      const result = await apiRequest('/api/admin/agent-tokens', {
        method: 'POST', body: jsonBody({ name: normalizedName }), sensitiveResponse: true,
      });
      setReveal(result.token);
      setName('');
      setStatus('Token creado. Cópialo ahora: no volverá a mostrarse.');
      await loadInventory();
    } catch {
      setError('No se pudo confirmar la creación. Actualizamos el inventario; no se reintentó automáticamente.');
      await loadInventory();
    } finally {
      setPending(false);
    }
  };

  const revokeToken = async (token) => {
    if (!window.confirm(`¿Revocar ${token.name}? Las nuevas solicitudes con esta credencial serán rechazadas.`)) return;
    setPending(true); setError(''); setStatus('');
    try {
      await apiRequest(`/api/admin/agent-tokens/${token.id}/revoke`, { method: 'POST', body: jsonBody({}) });
      setStatus('Token revocado correctamente.');
      await loadInventory();
    } catch {
      setError('No se pudo confirmar la revocación. Actualiza el inventario antes de volver a intentarlo.');
    } finally {
      setPending(false);
    }
  };

  const copyReveal = async () => {
    if (!reveal) return;
    await navigator.clipboard.writeText(reveal);
    setStatus('Token copiado al portapapeles.');
  };

  return (
    <section className="admin-card admin-card--wide" aria-labelledby="agent-token-title">
      <div className="admin-section-heading">
        <div><p className="admin-kicker">Acceso de agentes</p><h3 id="agent-token-title">Credenciales de agentes</h3></div>
        <button type="button" className="admin-soft-btn" onClick={loadInventory} disabled={loading || pending}><RefreshCw size={15} /> Actualizar</button>
      </div>
      <p className="admin-empty">Cada token se entrega una sola vez. El inventario muestra únicamente metadatos seguros.</p>
      <form className="admin-form" onSubmit={createToken}>
        <label><span>Nombre del nuevo token</span><input value={name} onChange={event => setName(event.target.value)} maxLength="160" autoComplete="off" /></label>
        <button className="admin-primary-btn" disabled={!name.trim() || pending}><KeyRound size={16} /> {pending ? 'Procesando...' : 'Crear token de agente'}</button>
      </form>
      {reveal ? (
        <div className="admin-alert admin-alert--info" role="region" aria-label="Token de entrega única">
          <div><strong>Entrega única</strong><p><code>{reveal}</code></p></div>
          <p id="agent-token-clipboard-warning">Después de copiarlo, el sistema operativo o el gestor del portapapeles puede conservar el token. NEXO no puede eliminarlo del portapapeles.</p>
          <button type="button" className="admin-soft-btn" onClick={copyReveal} aria-describedby="agent-token-clipboard-warning"><Clipboard size={15} /> Copiar token</button>
          <button type="button" className="admin-soft-btn" onClick={() => setReveal(null)}>Ocultar token</button>
        </div>
      ) : null}
      <p role="status" aria-live="polite" className="admin-empty">{status}</p>
      {error ? <p role="alert" className="admin-alert admin-alert--error">{error}</p> : null}
      {loading ? <p role="status" className="admin-empty">Cargando tokens de agentes…</p> : null}
      {!loading && tokens.length === 0 ? <p className="admin-empty">Aún no hay tokens de agentes. Crea el primero para vincular analistas.</p> : null}
      <div className="admin-list" aria-label="Inventario de tokens de agentes">
        {tokens.map(token => (
          <article key={token.id} className="admin-list-item">
            <div><h4>{token.name}</h4><p>{token.active ? 'Activo' : 'Revocado'} · Creado {new Date(token.created_at).toLocaleDateString('es-CO')}</p></div>
            {token.active ? <button type="button" className="admin-soft-btn" onClick={() => revokeToken(token)} disabled={pending}><ShieldX size={15} /> Revocar {token.name}</button> : <span className="admin-pill admin-pill--muted"><Check size={12} /> Revocado</span>}
          </article>
        ))}
      </div>
    </section>
  );
}
