import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  Building2,
  Check,
  CircleDot,
  Clock,
  FileText,
  History,
  LogOut,
  Paperclip,
  RefreshCw,
  Save,
  ShieldCheck,
  TrendingUp,
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

const EMPTY_FLOW_FORM = {
  id: null,
  version_id: 1,
  area_id: '',
  step_key: '',
  message: '',
  sort_order: 0,
  active: true,
};

const AUDIT_PAGE_SIZE = 10;

const EMPTY_AUDIT_FILTERS = {
  action: '',
  actor_role: '',
  target_id: '',
};

const AUDIT_ACTION_LABELS = Object.freeze({
  'area.created': 'Área creada',
  'area.updated': 'Área actualizada',
  'analyst.created': 'Analista creado',
  'analyst.updated': 'Analista actualizado',
  'ticket.assigned': 'Ticket asignado',
  'ticket.unassigned': 'Ticket sin asignación',
  'ticket.transferred': 'Ticket transferido',
  'ticket.closed': 'Ticket cerrado',
  'flow.created': 'Flujo creado',
  'flow.updated': 'Flujo actualizado',
  'flow.toggled': 'Flujo activado/desactivado',
  'flow.cache_invalidated': 'Caché de flujos invalidada',
});

const AUDIT_ACTION_OPTIONS = Object.entries(AUDIT_ACTION_LABELS);

const SUPPORTED_BOT_FLOW_STEPS = Object.freeze([
  { key: 'out_of_office', label: 'Fuera de horario' },
  { key: 'initial_filter', label: 'Filtro inicial de soporte' },
  { key: 'ask_name', label: 'Solicitar nombre completo' },
  { key: 'filter_no_menu', label: 'Menú para solicitudes no relacionadas' },
  { key: 'filter_no_analyst', label: 'Respuesta para analistas' },
  { key: 'filter_no_candidate', label: 'Respuesta para candidatos' },
  { key: 'filter_no_invalid', label: 'Respuesta inválida del filtro' },
  { key: 'ask_company', label: 'Solicitar empresa o cliente' },
  { key: 'ask_email', label: 'Solicitar correo corporativo' },
  { key: 'ask_issue', label: 'Solicitar descripción de la incidencia' },
  { key: 'processing', label: 'Procesando solicitud' },
  { key: 'confirmation', label: 'Confirmación de ticket creado' },
  { key: 'ticket_error', label: 'Error al crear ticket' },
]);

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

function normalizeFlowPayload(form) {
  return {
    version_id: Number(form.version_id) || 1,
    area_id: normalizeId(form.area_id),
    step_key: form.step_key.trim(),
    message: form.message.trim(),
    sort_order: Number(form.sort_order) || 0,
    active: !!form.active,
  };
}

function formatNumber(value) {
  return new Intl.NumberFormat('es-CO').format(Number(value) || 0);
}

function formatMinutes(value) {
  if (value === null || value === undefined) return 'Sin datos';
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return 'Sin datos';
  if (minutes < 60) return `${Math.round(minutes)} min`;
  return `${Math.round(minutes / 60)} h`;
}

function auditActionLabel(action) {
  return AUDIT_ACTION_LABELS[action] || action || 'Acción sin nombre';
}

function auditMetadataPreview(metadata) {
  if (!metadata || typeof metadata !== 'object') return 'Sin detalle adicional';
  const entries = Object.entries(metadata).filter(([, value]) => value !== null && value !== undefined && value !== '');
  if (entries.length === 0) return 'Sin detalle adicional';
  return entries.slice(0, 3).map(([key, value]) => `${key}: ${String(value)}`).join(' · ');
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
  const [flowForm, setFlowForm] = useState(EMPTY_FLOW_FORM);
  const [loading, setLoading] = useState(true);
  const [savingArea, setSavingArea] = useState(false);
  const [savingAnalyst, setSavingAnalyst] = useState(false);
  const [savingFlow, setSavingFlow] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [queueTickets, setQueueTickets] = useState([]);
  const [botFlows, setBotFlows] = useState([]);
  const [flowCache, setFlowCache] = useState([]);
  const [assigningTicketId, setAssigningTicketId] = useState(null);
  const [reportSummary, setReportSummary] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditFilters, setAuditFilters] = useState(EMPTY_AUDIT_FILTERS);
  const [auditPage, setAuditPage] = useState(0);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState(null);

  const loadAdminData = useCallback(async ({ backgroundRefresh = false } = {}) => {
    if (!backgroundRefresh) setLoading(true);
    setError(null);

    try {
      const [nextAreas, nextAnalysts, nextQueue, nextFlows, nextSummary] = await Promise.all([
        apiRequest('/api/admin/areas'),
        apiRequest('/api/admin/analysts'),
        apiRequest('/api/admin/queue'),
        apiRequest('/api/admin/bot-flows?active=all'),
        apiRequest('/api/admin/reports/summary'),
      ]);

      setAreas(Array.isArray(nextAreas) ? nextAreas : []);
      setAnalysts(Array.isArray(nextAnalysts) ? nextAnalysts : []);
      setQueueTickets(Array.isArray(nextQueue?.tickets) ? nextQueue.tickets : []);
      setBotFlows(Array.isArray(nextFlows?.flows) ? nextFlows.flows : []);
      setFlowCache(Array.isArray(nextFlows?.cache) ? nextFlows.cache : []);
      setReportSummary(nextSummary && typeof nextSummary === 'object' ? nextSummary : null);
      setForbidden(false);
      setLastRefresh(new Date());
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      setError(err.message || 'No se pudo cargar la información administrativa.');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadAuditData = useCallback(async ({ page = auditPage, filters = auditFilters } = {}) => {
    setAuditLoading(true);
    setAuditError(null);

    try {
      const params = new URLSearchParams({
        limit: String(AUDIT_PAGE_SIZE),
        offset: String(page * AUDIT_PAGE_SIZE),
      });
      if (filters.action) params.set('action', filters.action);
      if (filters.actor_role) params.set('actor_role', filters.actor_role);
      if (filters.target_id.trim()) params.set('target_id', filters.target_id.trim());

      const nextLogs = await apiRequest(`/api/admin/audit?${params.toString()}`);
      setAuditLogs(Array.isArray(nextLogs) ? nextLogs : []);
    } catch (err) {
      setAuditError(err.message || 'No se pudo cargar el historial de auditoría.');
      setAuditLogs([]);
    } finally {
      setAuditLoading(false);
    }
  }, [auditFilters, auditPage]);

  useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  useEffect(() => {
    loadAuditData();
  }, [loadAuditData]);

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
  const slaRiskTickets = useMemo(() => activeQueueTickets.filter(ticket => ['warning', 'breached'].includes(ticket.sla?.state)), [activeQueueTickets]);
  const areaNameById = useMemo(() => new Map(areas.map(area => [String(area.id), area.name])), [areas]);
  const reportByArea = Array.isArray(reportSummary?.by_area) ? reportSummary.by_area : [];
  const hasAuditNextPage = auditLogs.length === AUDIT_PAGE_SIZE;

  const resetAreaForm = () => setAreaForm(EMPTY_AREA_FORM);
  const resetAnalystForm = () => setAnalystForm(EMPTY_ANALYST_FORM);
  const resetFlowForm = () => setFlowForm(EMPTY_FLOW_FORM);

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

  const editFlow = (flow) => {
    setFlowForm({
      id: flow.id,
      version_id: flow.version_id || 1,
      area_id: flow.area_id || '',
      step_key: flow.step_key || '',
      message: flow.message || '',
      sort_order: flow.sort_order || 0,
      active: flow.active !== false,
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

  const submitFlow = async (event) => {
    event.preventDefault();
    if (!flowForm.step_key.trim() || !flowForm.message.trim() || !flowForm.version_id) return;

    setSavingFlow(true);
    setError(null);
    setNotice(null);

    try {
      const payload = normalizeFlowPayload(flowForm);
      if (flowForm.id) {
        await apiRequest(`/api/admin/bot-flows/${flowForm.id}`, {
          method: 'PATCH',
          body: jsonBody(payload),
        });
        setNotice('Paso del bot actualizado. La caché fue invalidada.');
      } else {
        await apiRequest('/api/admin/bot-flows', {
          method: 'POST',
          body: jsonBody(payload),
        });
        setNotice('Paso del bot creado. La caché fue invalidada.');
      }

      resetFlowForm();
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'No se pudo guardar el paso del bot.');
    } finally {
      setSavingFlow(false);
    }
  };

  const toggleFlowActive = async (flow) => {
    setError(null);
    setNotice(null);

    try {
      await apiRequest(`/api/admin/bot-flows/${flow.id}/toggle`, {
        method: 'POST',
        body: jsonBody({ active: !flow.active }),
      });
      setNotice(`Paso ${flow.step_key} ${flow.active ? 'desactivado' : 'activado'}. La caché fue invalidada.`);
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'No se pudo cambiar el estado del paso.');
    }
  };

  const invalidateFlowCache = async () => {
    setError(null);
    setNotice(null);

    try {
      const result = await apiRequest('/api/admin/bot-flows/cache/invalidate', { method: 'POST', body: jsonBody({}) });
      setFlowCache(Array.isArray(result?.cache) ? result.cache : []);
      setNotice('Caché de flujos del bot invalidada.');
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'No se pudo invalidar la caché de flujos.');
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

  const updateAuditFilter = (field, value) => {
    setAuditFilters(prev => ({ ...prev, [field]: value }));
    setAuditPage(0);
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
            <AdminStat icon={Bot} label="Pasos del bot" value={botFlows.length} tone="amber" />
          </div>
        </section>

        {error && <AdminAlert type="error">{error}</AdminAlert>}
        {notice && <AdminAlert type="success">{notice}</AdminAlert>}
        <AdminAlert>
          La presencia se actualiza cada {ADMIN_REFRESH_INTERVAL_MS / 1000} segundos y cuando el socket se reconecta. Los cambios de asignación refrescan la cola en tiempo real.
        </AdminAlert>

        <section className="admin-card admin-card--wide admin-reports-card">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">Reportes de Fase 5</p>
              <h3>Resumen operativo y Salesforce</h3>
            </div>
            {loading && <div className="qr-loading__spinner admin-mini-spinner" />}
          </div>

          <div className="admin-report-grid">
            <AdminStat icon={FileText} label="Tickets totales" value={formatNumber(reportSummary?.total_tickets)} />
            <AdminStat icon={Activity} label="Tickets abiertos" value={formatNumber(reportSummary?.open_tickets)} tone="amber" />
            <AdminStat icon={Check} label="Tickets cerrados" value={formatNumber(reportSummary?.closed_tickets)} tone="green" />
            <AdminStat icon={Paperclip} label="Adjuntos en Salesforce" value={formatNumber(reportSummary?.sf_attachments)} tone="purple" />
            <AdminStat icon={TrendingUp} label="Promedio de cierre" value={formatMinutes(reportSummary?.avg_close_minutes)} tone="green" />
          </div>

          <div className="admin-table-wrap admin-report-table-wrap">
            <table className="admin-table admin-table--compact">
              <thead>
                <tr>
                  <th>Área</th>
                  <th>Total</th>
                  <th>Abiertos</th>
                  <th>Cerrados</th>
                </tr>
              </thead>
              <tbody>
                {reportByArea.length === 0 && !loading ? (
                  <tr><td colSpan="4" className="admin-empty">Aún no hay datos suficientes para el resumen por área.</td></tr>
                ) : reportByArea.map(area => (
                  <tr key={area.area || 'Sin área'}>
                    <td><strong>{area.area || 'Sin área'}</strong></td>
                    <td>{formatNumber(area.total)}</td>
                    <td>{formatNumber(area.open)}</td>
                    <td>{formatNumber(area.closed)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="admin-card admin-card--wide admin-audit-card">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">Historial de auditoría</p>
              <h3>Eventos administrativos recientes</h3>
            </div>
            {auditLoading && <div className="qr-loading__spinner admin-mini-spinner" />}
          </div>

          <div className="admin-audit-controls">
            <label>
              <span>Acción</span>
              <select value={auditFilters.action} onChange={event => updateAuditFilter('action', event.target.value)}>
                <option value="">Todas las acciones</option>
                {AUDIT_ACTION_OPTIONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </label>
            <label>
              <span>Rol</span>
              <select value={auditFilters.actor_role} onChange={event => updateAuditFilter('actor_role', event.target.value)}>
                <option value="">Todos los roles</option>
                <option value="admin">Administrador</option>
                <option value="agent">Analista</option>
              </select>
            </label>
            <label>
              <span>ID objetivo</span>
              <input value={auditFilters.target_id} onChange={event => updateAuditFilter('target_id', event.target.value)} placeholder="Ticket, área o flujo" />
            </label>
            <button className="admin-soft-btn" onClick={() => loadAuditData()} disabled={auditLoading}>
              <History size={14} /> Aplicar filtros
            </button>
          </div>

          {auditError && <AdminAlert type="error">{auditError}</AdminAlert>}

          <div className="admin-table-wrap">
            <table className="admin-table admin-table--audit">
              <thead>
                <tr>
                  <th>Fecha</th>
                  <th>Acción</th>
                  <th>Actor</th>
                  <th>Objetivo</th>
                  <th>Detalle</th>
                </tr>
              </thead>
              <tbody>
                {auditLogs.length === 0 && !auditLoading ? (
                  <tr><td colSpan="5" className="admin-empty">No hay eventos de auditoría para los filtros seleccionados.</td></tr>
                ) : auditLogs.map(log => (
                  <tr key={log.id || `${log.action}-${log.created_at}-${log.target_id}`}>
                    <td>{formatDate(log.created_at)}</td>
                    <td><span className="admin-pill admin-pill--muted">{auditActionLabel(log.action)}</span></td>
                    <td>
                      <strong>{log.actor_name || 'Sistema'}</strong>
                      <span className="admin-table-subtext">{log.actor_role || 'Sin rol'}</span>
                    </td>
                    <td>{log.target_id || 'Sin objetivo'}</td>
                    <td>{auditMetadataPreview(log.metadata)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="admin-pagination-row">
            <span>Página {auditPage + 1}</span>
            <div className="admin-row-actions">
              <button className="admin-soft-btn" disabled={auditPage === 0 || auditLoading} onClick={() => setAuditPage(prev => Math.max(prev - 1, 0))}>Anterior</button>
              <button className="admin-soft-btn" disabled={!hasAuditNextPage || auditLoading} onClick={() => setAuditPage(prev => prev + 1)}>Siguiente</button>
            </div>
          </div>
        </section>

        <section className="admin-card admin-card--wide admin-flow-manager">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">Gestor de flujos del bot</p>
              <h3>Plantillas de mensajes de WhatsApp</h3>
            </div>
            <div className="admin-row-actions">
              <span className="admin-pill admin-pill--muted">{flowCache.length} entradas en caché</span>
              <button className="admin-soft-btn" onClick={invalidateFlowCache}><RefreshCw size={14} /> Invalidar caché</button>
            </div>
          </div>

              <p className="admin-help-text">
            Estos pasos son plantillas para momentos específicos que el bot de WhatsApp ya reconoce. Podés crear versiones globales o personalizadas por área; no es un editor visual de flujos todavía.
          </p>

          <div className="admin-flow-layout">
            <form className="admin-form admin-flow-form" onSubmit={submitFlow}>
              <div className="admin-form__row admin-form__row--thirds">
                <label>
                  <span>Versión</span>
                  <input type="number" min="1" value={flowForm.version_id} onChange={e => setFlowForm(prev => ({ ...prev, version_id: e.target.value }))} />
                </label>
                <label>
                  <span>Área</span>
                  <select value={flowForm.area_id} onChange={e => setFlowForm(prev => ({ ...prev, area_id: e.target.value }))}>
                    <option value="">Global</option>
                    {areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
                  </select>
                </label>
                <label>
                  <span>Orden</span>
                  <input type="number" value={flowForm.sort_order} onChange={e => setFlowForm(prev => ({ ...prev, sort_order: e.target.value }))} />
                </label>
              </div>
              <label>
                <span>Clave del paso</span>
                <select value={flowForm.step_key} onChange={e => setFlowForm(prev => ({ ...prev, step_key: e.target.value }))}>
                  <option value="">Seleccioná un momento del bot</option>
                  {SUPPORTED_BOT_FLOW_STEPS.map(step => <option key={step.key} value={step.key}>{step.label} · {step.key}</option>)}
                </select>
              </label>
              <label>
                <span>Mensaje</span>
                <textarea value={flowForm.message} onChange={e => setFlowForm(prev => ({ ...prev, message: e.target.value }))} rows={5} placeholder="Texto que enviará el bot. Podés usar variables como {{nombre}}." />
              </label>
              <label className="admin-check-row">
                <input type="checkbox" checked={flowForm.active} onChange={e => setFlowForm(prev => ({ ...prev, active: e.target.checked }))} />
                <span>Activo para el bot</span>
              </label>
              <div className="admin-row-actions">
                <button className="admin-primary-btn" disabled={savingFlow || !flowForm.step_key.trim() || !flowForm.message.trim()}>
                  <Save size={16} /> {savingFlow ? 'Guardando...' : flowForm.id ? 'Actualizar paso' : 'Crear paso'}
                </button>
                {flowForm.id && <button type="button" className="admin-soft-btn" onClick={resetFlowForm}>Nuevo paso</button>}
              </div>
            </form>

            <div className="admin-table-wrap admin-flow-table-wrap">
              <table className="admin-table admin-table--flows">
                <thead>
                  <tr>
                    <th>Paso</th>
                    <th>Versión</th>
                    <th>Área</th>
                    <th>Estado</th>
                    <th>Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {botFlows.length === 0 && !loading ? (
                    <tr><td colSpan="5" className="admin-empty">Aún no hay plantillas configuradas. El bot usará los mensajes estáticos de respaldo.</td></tr>
                  ) : botFlows.map(flow => (
                    <tr key={flow.id}>
                      <td>
                        <strong>{flow.step_key}</strong>
                        <span className="admin-table-subtext admin-flow-message-preview">{flow.message}</span>
                      </td>
                      <td>v{flow.version_id}</td>
                      <td>{flow.area?.name || (flow.area_id ? areaNameById.get(String(flow.area_id)) || `Área #${flow.area_id}` : 'Global')}</td>
                      <td>
                        <span className={`admin-pill ${flow.active === false ? 'admin-pill--muted' : 'admin-pill--green'}`}>
                          {flow.active === false ? 'Inactivo' : 'Activo'}
                        </span>
                      </td>
                      <td>
                        <div className="admin-row-actions">
                          <button className="admin-soft-btn" onClick={() => editFlow(flow)}>Editar</button>
                          <button className="admin-soft-btn" onClick={() => toggleFlowActive(flow)}>{flow.active === false ? 'Activar' : 'Desactivar'}</button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </section>

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
