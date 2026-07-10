import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Building2,
  Check,
  CircleDot,
  Clock,
  LogOut,
  RefreshCw,
  Save,
  ShieldCheck,
  UserCog,
  Users,
} from 'lucide-react';
import { apiRequest, jsonBody } from '../lib/apiClient';

const DEFAULT_SLA_MINUTES = 30;
const ADMIN_REFRESH_INTERVAL_MS = 30000;

const EMPTY_AREA_FORM = {
  id: null,
  name: '',
  description: '',
  welcome_msg: '',
  sla_minutes: DEFAULT_SLA_MINUTES,
  active: true,
};

const EMPTY_ANALYST_FORM = {
  id: null,
  display_name: '',
  token_id: '',
  area_id: '',
  available: false,
};

function formatDate(value) {
  if (!value) return 'Nunca';
  return new Date(value).toLocaleString('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeId(value) {
  if (value === '' || value === null || value === undefined) return null;
  return Number(value);
}

function normalizeAreaPayload(form) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    welcome_msg: form.welcome_msg.trim() || null,
    sla_minutes: Number(form.sla_minutes) || DEFAULT_SLA_MINUTES,
    active: !!form.active,
  };
}

function normalizeAnalystPayload(form) {
  return {
    display_name: form.display_name.trim(),
    token_id: normalizeId(form.token_id),
    area_id: normalizeId(form.area_id),
    available: !!form.available,
  };
}

function slaLabel(sla) {
  if (!sla) return 'Sin SLA';
  if (sla.state === 'breached') return 'Vencido';
  if (sla.state === 'warning') return 'Por vencer';
  return 'En tiempo';
}

function analystLabel(ticket) {
  const analyst = ticket.assignment?.analyst;
  if (analyst?.display_name) return analyst.display_name;
  if (ticket.assignment?.analyst_id) return `Analista #${ticket.assignment.analyst_id}`;
  return 'Sin asignar';
}

function AdminStat({ icon, label, value, tone = 'cyan' }) {
  const StatIcon = icon;
  return (
    <div className={`admin-stat admin-stat--${tone}`}>
      <div className="admin-stat__icon"><StatIcon size={18} /></div>
      <div>
        <p className="admin-stat__value">{value}</p>
        <p className="admin-stat__label">{label}</p>
      </div>
    </div>
  );
}

function AdminAlert({ type = 'info', children }) {
  return (
    <div className={`admin-alert admin-alert--${type}`}>
      <AlertTriangle size={16} />
      <span>{children}</span>
    </div>
  );
}

export default function AdminPanel({ socket, onLogout }) {
  const [areas, setAreas] = useState([]);
  const [analysts, setAnalysts] = useState([]);
  const [areaForm, setAreaForm] = useState(EMPTY_AREA_FORM);
  const [analystForm, setAnalystForm] = useState(EMPTY_ANALYST_FORM);
  const [loading, setLoading] = useState(true);
  const [savingArea, setSavingArea] = useState(false);
  const [savingAnalyst, setSavingAnalyst] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [queueTickets, setQueueTickets] = useState([]);
  const [assigningTicketId, setAssigningTicketId] = useState(null);

  const loadAdminData = useCallback(async ({ backgroundRefresh = false } = {}) => {
    if (!backgroundRefresh) setLoading(true);
    setError(null);

    try {
      const [nextAreas, nextAnalysts, nextQueue] = await Promise.all([
        apiRequest('/api/admin/areas'),
        apiRequest('/api/admin/analysts'),
        apiRequest('/api/admin/queue'),
      ]);

      setAreas(Array.isArray(nextAreas) ? nextAreas : []);
      setAnalysts(Array.isArray(nextAnalysts) ? nextAnalysts : []);
      setQueueTickets(Array.isArray(nextQueue?.tickets) ? nextQueue.tickets : []);
      setForbidden(false);
      setLastRefresh(new Date());
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      setError(err.message || 'No se pudo cargar la información administrativa.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  useEffect(() => {
    const interval = window.setInterval(() => loadAdminData({ backgroundRefresh: true }), ADMIN_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadAdminData]);

  useEffect(() => {
    if (!socket) return undefined;

    const refreshPresence = () => loadAdminData({ backgroundRefresh: true });
    socket.on('connect', refreshPresence);
    socket.on('disconnect', refreshPresence);
    socket.on('analyst-presence', refreshPresence);
    socket.on('analyst-updated', refreshPresence);
    socket.on('ticket-assigned', refreshPresence);
    socket.on('queue-updated', refreshPresence);
    socket.on('sla-alert', refreshPresence);

    return () => {
      socket.off('connect', refreshPresence);
      socket.off('disconnect', refreshPresence);
      socket.off('analyst-presence', refreshPresence);
      socket.off('analyst-updated', refreshPresence);
      socket.off('ticket-assigned', refreshPresence);
      socket.off('queue-updated', refreshPresence);
      socket.off('sla-alert', refreshPresence);
    };
  }, [loadAdminData, socket]);

  const activeAreas = useMemo(() => areas.filter(area => area.active !== false), [areas]);
  const availableAnalysts = useMemo(() => analysts.filter(analyst => analyst.available), [analysts]);
  const activeQueueTickets = useMemo(() => queueTickets.filter(ticket => ticket.status !== 'closed'), [queueTickets]);
  const unassignedQueueTickets = useMemo(() => activeQueueTickets.filter(ticket => !ticket.assignment?.analyst_id), [activeQueueTickets]);
  const slaRiskTickets = useMemo(() => activeQueueTickets.filter(ticket => ['warning', 'breached'].includes(ticket.sla?.state)), [activeQueueTickets]);

  const resetAreaForm = () => setAreaForm(EMPTY_AREA_FORM);
  const resetAnalystForm = () => setAnalystForm(EMPTY_ANALYST_FORM);

  const editArea = (area) => {
    setAreaForm({
      id: area.id,
      name: area.name || '',
      description: area.description || '',
      welcome_msg: area.welcome_msg || '',
      sla_minutes: area.sla_minutes || DEFAULT_SLA_MINUTES,
      active: area.active !== false,
    });
  };

  const editAnalyst = (analyst) => {
    setAnalystForm({
      id: analyst.id,
      display_name: analyst.display_name || '',
      token_id: analyst.token_id || '',
      area_id: analyst.area_id || '',
      available: !!analyst.available,
    });
  };

  const submitArea = async (event) => {
    event.preventDefault();
    if (!areaForm.name.trim()) return;

    setSavingArea(true);
    setError(null);
    setNotice(null);

    try {
      const payload = normalizeAreaPayload(areaForm);
      if (areaForm.id) {
        await apiRequest(`/api/admin/areas/${areaForm.id}`, {
          method: 'PATCH',
          body: jsonBody(payload),
        });
        setNotice('Área actualizada.');
      } else {
        await apiRequest('/api/admin/areas', {
          method: 'POST',
          body: jsonBody(payload),
        });
        setNotice('Área creada.');
      }

      resetAreaForm();
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'No se pudo guardar el área.');
    } finally {
      setSavingArea(false);
    }
  };

  const submitAnalyst = async (event) => {
    event.preventDefault();
    if (!analystForm.display_name.trim()) return;

    setSavingAnalyst(true);
    setError(null);
    setNotice(null);

    try {
      const payload = normalizeAnalystPayload(analystForm);
      if (analystForm.id) {
        await apiRequest(`/api/admin/analysts/${analystForm.id}`, {
          method: 'PATCH',
          body: jsonBody(payload),
        });
        setNotice('Analista actualizado.');
      } else {
        await apiRequest('/api/admin/analysts', {
          method: 'POST',
          body: jsonBody(payload),
        });
        setNotice('Analista creado.');
      }

      resetAnalystForm();
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'No se pudo guardar el analista.');
    } finally {
      setSavingAnalyst(false);
    }
  };

  const toggleAnalystAvailability = async (analyst) => {
    setError(null);
    setNotice(null);

    try {
      await apiRequest(`/api/admin/analysts/${analyst.id}`, {
        method: 'PATCH',
        body: jsonBody({ available: !analyst.available }),
      });
      setNotice(`${analyst.display_name} marcado como ${analyst.available ? 'no disponible' : 'disponible'}.`);
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'No se pudo cambiar la disponibilidad.');
    }
  };

  const assignTicket = async (ticket, analystId) => {
    setAssigningTicketId(ticket.id);
    setError(null);
    setNotice(null);

    try {
      if (!analystId) {
        await apiRequest(`/api/admin/tickets/${ticket.id}/unassign`, { method: 'POST', body: jsonBody({}) });
        setNotice(`Ticket #${ticket.id} quedó sin asignación.`);
      } else {
        await apiRequest(`/api/admin/tickets/${ticket.id}/assign`, {
          method: 'POST',
          body: jsonBody({ analyst_id: Number(analystId) }),
        });
        setNotice(`Ticket #${ticket.id} asignado correctamente.`);
      }
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'No se pudo actualizar la asignación del ticket.');
    } finally {
      setAssigningTicketId(null);
    }
  };

  if (forbidden) {
    return (
      <div className="admin-shell admin-shell--centered">
        <section className="admin-denied-card">
          <div className="admin-denied-card__icon"><ShieldCheck size={34} /></div>
          <p className="admin-kicker">Ruta restringida</p>
          <h1>Se requiere acceso administrativo</h1>
          <p>Este token es válido para el panel de analistas, pero no tiene permisos para ingresar al panel de administración.</p>
          <div className="admin-denied-card__actions">
            <a className="admin-link-btn" href="/">Volver al panel</a>
            <button className="admin-link-btn admin-link-btn--danger" onClick={onLogout}>Cerrar sesión</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="admin-topbar__brand">
          <div className="topbar__logo">N</div>
          <div>
            <p className="admin-kicker">Capa de control de NEXO</p>
            <h1>Panel de administración</h1>
          </div>
        </div>
        <div className="admin-topbar__actions">
          <span className="admin-refresh-stamp">
            <Clock size={14} /> {lastRefresh ? `Actualizado ${formatDate(lastRefresh)}` : 'Esperando datos'}
          </span>
          <button className="action-btn action-btn--glass" onClick={() => loadAdminData()} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'admin-spin' : ''} /> Actualizar
          </button>
          <a className="action-btn action-btn--glass" href="/">Panel operativo</a>
          <button className="action-btn action-btn--secondary" onClick={onLogout}>
            <LogOut size={16} /> Cerrar sesión
          </button>
        </div>
      </header>

      <main className="admin-workspace">
        <section className="admin-hero-card">
          <div>
            <p className="admin-kicker">Administración de Fase 4</p>
            <h2>Cola híbrida con asignación manual, automática y seguimiento SLA.</h2>
            <p>
              La asignación automática solo aplica a tickets con área definida y analista disponible. Los tickets sin área quedan pendientes hasta que un administrador los asigne o defina su área.
            </p>
          </div>
          <div className="admin-stat-grid">
            <AdminStat icon={Building2} label="Áreas activas" value={activeAreas.length} />
            <AdminStat icon={Users} label="Analistas" value={analysts.length} tone="purple" />
            <AdminStat icon={Activity} label="Disponibles" value={availableAnalysts.length} tone="green" />
            <AdminStat icon={AlertTriangle} label="Tickets sin asignar" value={unassignedQueueTickets.length} tone="amber" />
          </div>
        </section>

        {error && <AdminAlert type="error">{error}</AdminAlert>}
        {notice && <AdminAlert type="success">{notice}</AdminAlert>}
        <AdminAlert>
          La presencia se actualiza cada {ADMIN_REFRESH_INTERVAL_MS / 1000} segundos y cuando el socket se reconecta. Los cambios de asignación refrescan la cola en tiempo real.
        </AdminAlert>

        <section className="admin-card admin-card--wide">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">Enrutamiento y cola</p>
              <h3>Tickets actuales</h3>
            </div>
            <div className="admin-meta-row">
              <span>{activeQueueTickets.length} activos</span>
              <span>{slaRiskTickets.length} con SLA crítico</span>
            </div>
          </div>

          <div className="admin-table-wrap">
            <table className="admin-table admin-table--queue">
              <thead>
                <tr>
                  <th>Ticket</th>
                  <th>Área</th>
                  <th>Asignación</th>
                  <th>SLA</th>
                  <th>Asignar a</th>
                </tr>
              </thead>
              <tbody>
                {activeQueueTickets.length === 0 && !loading ? (
                  <tr><td colSpan="5" className="admin-empty">No hay tickets activos en la cola.</td></tr>
                ) : activeQueueTickets.map(ticket => {
                  const analystsForTicket = analysts.filter(analyst => {
                    if (!ticket.area_id) return true;
                    return analyst.area_id && String(analyst.area_id) === String(ticket.area_id);
                  });
                  return (
                    <tr key={ticket.id}>
                      <td>
                        <strong>#{ticket.id}</strong>
                        <span className="admin-table-subtext">{ticket.nombre_empresa || ticket.telefono || 'Sin contacto'}</span>
                      </td>
                      <td>{ticket.area?.name || 'Sin área pendiente'}</td>
                      <td>{analystLabel(ticket)}</td>
                      <td>
                        <span className={`admin-pill admin-pill--sla-${ticket.sla?.state || 'none'}`}>
                          {slaLabel(ticket.sla)} · {ticket.sla?.age_minutes ?? 0}m
                        </span>
                      </td>
                      <td>
                        <select
                          className="admin-inline-select"
                          aria-label={`Asignar ticket #${ticket.id}`}
                          value={ticket.assignment?.analyst_id || ''}
                          disabled={assigningTicketId === ticket.id}
                          onChange={event => assignTicket(ticket, event.target.value)}
                        >
                          <option value="">Sin asignar</option>
                          {analystsForTicket.map(analyst => (
                            <option key={analyst.id} value={analyst.id}>{analyst.display_name}{analyst.available ? ' · disponible' : ''}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <div className="admin-grid">
          <section className="admin-card admin-card--form">
            <div className="admin-section-heading">
              <div>
                <p className="admin-kicker">Áreas de soporte</p>
                <h3>{areaForm.id ? 'Editar área' : 'Crear área'}</h3>
              </div>
              {areaForm.id && <button className="admin-soft-btn" onClick={resetAreaForm}>Nueva área</button>}
            </div>

            <form className="admin-form" onSubmit={submitArea}>
              <label>
                <span>Nombre</span>
                <input value={areaForm.name} onChange={e => setAreaForm(prev => ({ ...prev, name: e.target.value }))} placeholder="Soporte de integraciones" />
              </label>
              <label>
                <span>Descripción</span>
                <input value={areaForm.description} onChange={e => setAreaForm(prev => ({ ...prev, description: e.target.value }))} placeholder="Alcance y responsable" />
              </label>
              <label>
                <span>Mensaje de bienvenida</span>
                <textarea value={areaForm.welcome_msg} onChange={e => setAreaForm(prev => ({ ...prev, welcome_msg: e.target.value }))} rows={4} placeholder="Mensaje usado cuando un área recibe una conversación" />
              </label>
              <div className="admin-form__row">
                <label>
                  <span>SLA en minutos</span>
                  <input type="number" min="1" value={areaForm.sla_minutes} onChange={e => setAreaForm(prev => ({ ...prev, sla_minutes: e.target.value }))} />
                </label>
                <label className="admin-check-row">
                  <input type="checkbox" checked={areaForm.active} onChange={e => setAreaForm(prev => ({ ...prev, active: e.target.checked }))} />
                  <span>Activa</span>
                </label>
              </div>
              <button className="admin-primary-btn" disabled={savingArea || !areaForm.name.trim()}>
                <Save size={16} /> {savingArea ? 'Guardando...' : areaForm.id ? 'Actualizar área' : 'Crear área'}
              </button>
            </form>
          </section>

          <section className="admin-card admin-card--list">
            <div className="admin-section-heading">
              <div>
                <p className="admin-kicker">Mapa de enrutamiento</p>
                <h3>Áreas</h3>
              </div>
              {loading && <div className="qr-loading__spinner admin-mini-spinner" />}
            </div>

            <div className="admin-list">
              {areas.length === 0 && !loading ? <p className="admin-empty">Aún no hay áreas configuradas.</p> : null}
              {areas.map(area => (
                <article key={area.id} className={`admin-list-item ${area.active === false ? 'admin-list-item--muted' : ''}`}>
                  <div>
                    <div className="admin-list-item__title-row">
                      <h4>{area.name}</h4>
                      <span className={`admin-pill ${area.active === false ? 'admin-pill--muted' : 'admin-pill--green'}`}>
                        {area.active === false ? 'Inactiva' : 'Activa'}
                      </span>
                    </div>
                    <p>{area.description || 'Sin descripción por ahora.'}</p>
                    <div className="admin-meta-row">
                      <span><Clock size={13} /> SLA {area.sla_minutes || DEFAULT_SLA_MINUTES}m</span>
                      <span>{analysts.filter(analyst => String(analyst.area_id) === String(area.id)).length} analistas</span>
                    </div>
                  </div>
                  <button className="admin-soft-btn" onClick={() => editArea(area)}>Editar</button>
                </article>
              ))}
            </div>
          </section>

          <section className="admin-card admin-card--form">
            <div className="admin-section-heading">
              <div>
                <p className="admin-kicker">Equipo de analistas</p>
                <h3>{analystForm.id ? 'Editar analista' : 'Crear analista'}</h3>
              </div>
              {analystForm.id && <button className="admin-soft-btn" onClick={resetAnalystForm}>Nuevo analista</button>}
            </div>

            <form className="admin-form" onSubmit={submitAnalyst}>
              <label>
                <span>Nombre visible</span>
                <input value={analystForm.display_name} onChange={e => setAnalystForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="Nombre del analista" />
              </label>
              <div className="admin-form__row">
                <label>
                  <span>ID del token</span>
                  <input type="number" min="1" value={analystForm.token_id} onChange={e => setAnalystForm(prev => ({ ...prev, token_id: e.target.value }))} placeholder="dashboard_tokens.id" />
                </label>
                <label>
                  <span>Área</span>
                  <select value={analystForm.area_id} onChange={e => setAnalystForm(prev => ({ ...prev, area_id: e.target.value }))}>
                    <option value="">Sin asignar</option>
                    {areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
                  </select>
                </label>
              </div>
              <label className="admin-check-row">
                <input type="checkbox" checked={analystForm.available} onChange={e => setAnalystForm(prev => ({ ...prev, available: e.target.checked }))} />
                <span>Disponible para enrutamiento</span>
              </label>
              <button className="admin-primary-btn" disabled={savingAnalyst || !analystForm.display_name.trim()}>
                <UserCog size={16} /> {savingAnalyst ? 'Guardando...' : analystForm.id ? 'Actualizar analista' : 'Crear analista'}
              </button>
            </form>
          </section>

          <section className="admin-card admin-card--list admin-card--wide">
            <div className="admin-section-heading">
              <div>
                <p className="admin-kicker">Vista de presencia</p>
                <h3>Analistas</h3>
              </div>
              {socket?.connected ? <span className="admin-pill admin-pill--green"><CircleDot size={12} /> Conexión activa</span> : <span className="admin-pill admin-pill--muted">Conexión inactiva</span>}
            </div>

            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Analista</th>
                    <th>Área</th>
                    <th>Token</th>
                    <th>Disponibilidad</th>
                    <th>Última actividad</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {analysts.length === 0 && !loading ? (
                    <tr><td colSpan="6" className="admin-empty">Aún no hay analistas configurados.</td></tr>
                  ) : analysts.map(analyst => (
                    <tr key={analyst.id}>
                      <td>
                        <div className="admin-identity-cell">
                          <div className="admin-avatar">{analyst.display_name?.slice(0, 2).toUpperCase() || 'AN'}</div>
                          <div>
                            <strong>{analyst.display_name}</strong>
                            <span>#{analyst.id}</span>
                          </div>
                        </div>
                      </td>
                      <td>{analyst.area?.name || 'Sin asignar'}</td>
                      <td>{analyst.token?.name || (analyst.token_id ? `Token #${analyst.token_id}` : 'Sin token')}</td>
                      <td>
                        <span className={`admin-pill ${analyst.available ? 'admin-pill--green' : 'admin-pill--muted'}`}>
                          {analyst.available ? <Check size={12} /> : null} {analyst.available ? 'Disponible' : 'No disponible'}
                        </span>
                      </td>
                      <td>{formatDate(analyst.last_seen)}</td>
                      <td>
                        <div className="admin-row-actions">
                          <button className="admin-soft-btn" onClick={() => editAnalyst(analyst)}>Editar</button>
                          <button className="admin-soft-btn" onClick={() => toggleAnalystAvailability(analyst)}>
                            {analyst.available ? 'Pausar' : 'Habilitar'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
