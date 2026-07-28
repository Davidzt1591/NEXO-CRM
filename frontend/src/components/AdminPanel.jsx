import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
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
  UserRoundX,
  TrendingUp,
  UserCog,
  Users,
} from 'lucide-react';
import { apiRequest, jsonBody } from '../lib/apiClient';
import AdminCommandDock from './AdminCommandDock';
import MagnetoLogo from './design-system/MagnetoLogo';
import AgentTokenManagement from './AgentTokenManagement';

const DEFAULT_SLA_MINUTES = 30;
const ADMIN_REFRESH_INTERVAL_MS = 30000;
const BotFlowStudio = lazy(() => import('./bot-flow-studio/BotFlowStudio'));
const SlaAdministration = lazy(() => import('../features/admin-sla/SlaAdministration'));

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

const ADMIN_SECTIONS = Object.freeze([
  { id: 'admin-resumen', label: 'Resumen', group: 'Mando', icon: Activity, status: context => (context.loading ? 'Cargando' : `${context.activeQueueTicketsCount} tickets activos`), brief: 'Pulso general de operación, cobertura y automatización.' },
  { id: 'admin-cola-sla', label: 'Cola y SLA', group: 'Atención', icon: Clock, status: context => `${context.slaRiskTicketsCount} en riesgo`, brief: 'Tickets vivos, asignación y riesgo de vencimiento.' },
  { id: 'admin-sla-escalamientos', label: 'SLA y Escalamientos', group: 'Gobierno', icon: ShieldCheck, status: () => 'Versionado', brief: 'Políticas, calendarios y relojes de Soporte y Desarrollo.' },
  { id: 'admin-areas', label: 'Áreas', group: 'Enrutamiento', icon: Building2, status: context => `${context.activeAreasCount}/${context.areasCount} activas`, brief: 'Cobertura, SLA y mensajes de bienvenida por dominio.' },
  { id: 'admin-analistas', label: 'Analistas', group: 'Equipo', icon: Users, status: context => `${context.availableAnalystsCount}/${context.analystsCount} disponibles`, brief: 'Presencia operativa y disponibilidad para asignación.' },
  { id: 'admin-candidatos', label: 'Candidatos', group: 'Atención', icon: UserRoundX, status: context => `${context.candidatesCount} clasificados`, brief: 'Contactos retirados del procesamiento de soporte y su mensaje seguro.' },
  { id: 'admin-flujos-bot', label: 'Flujos del bot', group: 'Automatización', icon: Bot, status: context => `${context.botFlowsCount} pasos · ${context.flowCacheCount} caché`, brief: 'Antesala visual del builder de conversaciones.' },
  { id: 'admin-salesforce-outbox', label: 'Salesforce/Outbox', group: 'Integración', icon: RefreshCw, status: () => 'Sin vista de outbox', brief: 'Señales honestas de sincronización, sin controles falsos.' },
  { id: 'admin-reportes', label: 'Reportes', group: 'Lectura', icon: TrendingUp, status: context => `${formatNumber(context.totalTickets)} tickets`, brief: 'Resumen operativo y señales de Salesforce.' },
  { id: 'admin-auditoria', label: 'Auditoría', group: 'Trazabilidad', icon: History, status: context => `Página ${context.auditPage + 1} · ${context.auditLogsCount} eventos`, brief: 'Eventos administrativos y cambios recientes.' },
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
  const [agentTokens, setAgentTokens] = useState([]);
  const [categoryMappings, setCategoryMappings] = useState([]);
  const [mappingPending, setMappingPending] = useState(null);
  const [areaForm, setAreaForm] = useState(EMPTY_AREA_FORM);
  const [analystForm, setAnalystForm] = useState(EMPTY_ANALYST_FORM);
  const [loading, setLoading] = useState(true);
  const [savingArea, setSavingArea] = useState(false);
  const [savingAnalyst, setSavingAnalyst] = useState(false);
  const [savingFlow, setSavingFlow] = useState(false);
  const [studioScope, setStudioScope] = useState({ versionId: 1, areaId: null });
  const [error, setError] = useState(null);
  const [authUnavailable, setAuthUnavailable] = useState(null);
  const [notice, setNotice] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);
  const [queueTickets, setQueueTickets] = useState([]);
  const [botFlows, setBotFlows] = useState([]);
  const [studioDirty, setStudioDirty] = useState(false);
  const [studioDiscardCommand, setStudioDiscardCommand] = useState(null);
  const [studioFocusMode, setStudioFocusMode] = useState(false);
  const [flowCache, setFlowCache] = useState([]);
  const [assigningTicketId, setAssigningTicketId] = useState(null);
  const [candidates, setCandidates] = useState([]);
  const [candidateSettings, setCandidateSettings] = useState({ formUrl: '', message: '' });
  const [savingCandidateSettings, setSavingCandidateSettings] = useState(false);
  const [reportSummary, setReportSummary] = useState(null);
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditFilters, setAuditFilters] = useState(EMPTY_AUDIT_FILTERS);
  const [auditPage, setAuditPage] = useState(0);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState(null);
  const [activeModuleId, setActiveModuleId] = useState(() => {
    if (typeof window === 'undefined') return ADMIN_SECTIONS[0].id;
    const hashId = window.location.hash.replace('#', '');
    return ADMIN_SECTIONS.some(section => section.id === hashId) ? hashId : ADMIN_SECTIONS[0].id;
  });
  const botFlowRequestGenerationRef = useRef(0);
  const operationalRequestGenerationRef = useRef(0);
  const adminRefreshGenerationRef = useRef(0);
  const operationalRefreshRef = useRef(null);
  const botFlowRefreshRef = useRef(null);
  const mountedRef = useRef(true);

  useEffect(() => () => {
    mountedRef.current = false;
    botFlowRequestGenerationRef.current += 1;
    operationalRequestGenerationRef.current += 1;
  }, []);

  const loadOperationalData = useCallback(async () => {
    const requestGeneration = ++operationalRequestGenerationRef.current;
    if (operationalRefreshRef.current) {
      const current = operationalRefreshRef.current;
      if (!current.trailing) current.trailing = current.active.then(() => {
        if (operationalRefreshRef.current === current) operationalRefreshRef.current = null;
        return loadOperationalData();
      }, () => {
        if (operationalRefreshRef.current === current) operationalRefreshRef.current = null;
        return loadOperationalData();
      });
      return current.trailing;
    }
    const request = Promise.all([
      apiRequest('/api/admin/areas'),
      apiRequest('/api/admin/analysts'),
      apiRequest('/api/admin/queue'),
      apiRequest('/api/admin/reports/summary'),
      apiRequest('/api/admin/candidates'),
      apiRequest('/api/admin/candidate-settings'),
      apiRequest('/api/admin/category-area-mappings').catch(() => []),
    ]).then(([nextAreas, nextAnalysts, nextQueue, nextSummary, nextCandidates, nextCandidateSettings, nextMappings]) => {
      if (!mountedRef.current || requestGeneration !== operationalRequestGenerationRef.current) return false;
      setAreas(Array.isArray(nextAreas) ? nextAreas : []);
      setAnalysts(Array.isArray(nextAnalysts) ? nextAnalysts : []);
      setQueueTickets(Array.isArray(nextQueue?.tickets) ? nextQueue.tickets : []);
      setReportSummary(nextSummary && typeof nextSummary === 'object' ? nextSummary : null);
      setCandidates(Array.isArray(nextCandidates?.candidates) ? nextCandidates.candidates : []);
      setCandidateSettings({ formUrl: nextCandidateSettings?.formUrl || '', message: nextCandidateSettings?.message || '' });
      setCategoryMappings(Array.isArray(nextMappings) ? nextMappings : []);
      return true;
    });
    const entry = { active: request, trailing: null };
    operationalRefreshRef.current = entry;
    request.then(() => {
      if (operationalRefreshRef.current === entry && !entry.trailing) operationalRefreshRef.current = null;
    }, () => {
      if (operationalRefreshRef.current === entry && !entry.trailing) operationalRefreshRef.current = null;
    });
    return request;
  }, []);

  const crossOperationalMutationBarrier = useCallback(() => {
    operationalRequestGenerationRef.current += 1;
  }, []);

  const loadBotFlowData = useCallback(async ({ force = false } = {}) => {
    if (botFlowRefreshRef.current && !force) {
      const current = botFlowRefreshRef.current;
      if (!current.trailing) current.trailing = current.active.then(() => {
        if (botFlowRefreshRef.current === current) botFlowRefreshRef.current = null;
        return loadBotFlowData();
      }, () => {
        if (botFlowRefreshRef.current === current) botFlowRefreshRef.current = null;
        return loadBotFlowData();
      });
      return current.trailing;
    }
    const requestGeneration = ++botFlowRequestGenerationRef.current;
    const request = apiRequest('/api/admin/bot-flows?active=all').then(nextFlows => {
      if (!mountedRef.current || requestGeneration !== botFlowRequestGenerationRef.current) return false;
      setBotFlows(Array.isArray(nextFlows?.flows) ? nextFlows.flows : []);
      setFlowCache(Array.isArray(nextFlows?.cache) ? nextFlows.cache : []);
      return true;
    });
    const entry = { active: request, trailing: null };
    botFlowRefreshRef.current = entry;
    request.then(() => {
      if (botFlowRefreshRef.current === entry && !entry.trailing) botFlowRefreshRef.current = null;
    }, () => {
      if (botFlowRefreshRef.current === entry && !entry.trailing) botFlowRefreshRef.current = null;
    });
    return request;
  }, []);

  const loadAdminData = useCallback(async ({ backgroundRefresh = false } = {}) => {
    const generation = ++adminRefreshGenerationRef.current;
    if (!backgroundRefresh) setLoading(true);

    try {
      const [operationalResult, flowResult] = await Promise.allSettled([loadOperationalData(), loadBotFlowData()]);
      if (operationalResult.status === 'rejected') throw operationalResult.reason;
      if (flowResult.status === 'rejected') throw flowResult.reason;
      if (!mountedRef.current || generation !== adminRefreshGenerationRef.current) return;
      setForbidden(false);
      setAuthUnavailable(null);
      setLastRefresh(new Date());
    } catch (err) {
      if (!mountedRef.current || generation !== adminRefreshGenerationRef.current) return;
      if (err.status === 403) setForbidden(true);
      if (err.code === 'AUTH_UNAVAILABLE') setAuthUnavailable({ code: err.code, message: err.message });
      else setError({ code: err.code || null, message: err.message || 'No se pudo cargar la información administrativa.' });
    } finally {
      if (mountedRef.current && generation === adminRefreshGenerationRef.current) setLoading(false);
    }
  }, [loadBotFlowData, loadOperationalData]);

  const refreshOperationalData = useCallback(async () => {
    const generation = ++adminRefreshGenerationRef.current;
    try { await loadOperationalData(); if (!mountedRef.current || generation !== adminRefreshGenerationRef.current) return; setForbidden(false); setAuthUnavailable(null); setLastRefresh(new Date()); }
    catch (err) { if (!mountedRef.current || generation !== adminRefreshGenerationRef.current) return; if (err.status === 403) setForbidden(true); if (err.code === 'AUTH_UNAVAILABLE') setAuthUnavailable({ code: err.code, message: err.message }); else setError({ code: err.code || null, message: err.message || 'No se pudo actualizar la información operativa.' }); }
  }, [loadOperationalData]);

  const refreshBotFlowData = useCallback(async () => {
    const generation = ++adminRefreshGenerationRef.current;
    try { const applied = await loadBotFlowData(); if (!applied || !mountedRef.current || generation !== adminRefreshGenerationRef.current) return; setForbidden(false); setAuthUnavailable(null); setLastRefresh(new Date()); }
    catch (err) { if (!mountedRef.current || generation !== adminRefreshGenerationRef.current) return; if (err.status === 403) setForbidden(true); if (err.code === 'AUTH_UNAVAILABLE') setAuthUnavailable({ code: err.code, message: err.message }); else setError({ code: err.code || null, message: err.message || 'No se pudieron actualizar los flujos del bot.' }); }
  }, [loadBotFlowData]);

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
    const interval = window.setInterval(refreshOperationalData, ADMIN_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [refreshOperationalData]);

  useEffect(() => {
    if (!socket) return undefined;

    const refreshPresence = () => refreshOperationalData();
    const refreshFlows = () => refreshBotFlowData();
    socket.on('connect', refreshPresence);
    socket.on('disconnect', refreshPresence);
    socket.on('analyst-presence', refreshPresence);
    socket.on('analyst-updated', refreshPresence);
    socket.on('ticket-assigned', refreshPresence);
    socket.on('queue-updated', refreshPresence);
    socket.on('sla-alert', refreshPresence);
    socket.on('bot-flow-updated', refreshFlows);
    socket.on('bot-flow-cache-invalidated', refreshFlows);

    return () => {
      socket.off('connect', refreshPresence);
      socket.off('disconnect', refreshPresence);
      socket.off('analyst-presence', refreshPresence);
      socket.off('analyst-updated', refreshPresence);
      socket.off('ticket-assigned', refreshPresence);
      socket.off('queue-updated', refreshPresence);
      socket.off('sla-alert', refreshPresence);
      socket.off('bot-flow-updated', refreshFlows);
      socket.off('bot-flow-cache-invalidated', refreshFlows);
    };
  }, [refreshBotFlowData, refreshOperationalData, socket]);

  useEffect(() => {
    const syncModuleFromHash = () => {
      const hashId = window.location.hash.replace('#', '');
      if (!ADMIN_SECTIONS.some(section => section.id === hashId) || hashId === activeModuleId) return;
      if (activeModuleId === 'admin-flujos-bot' && studioDirty && !window.confirm('Hay cambios sin guardar en el mensaje o el diseño. Si sales del módulo, se descartarán. ¿Quieres continuar?')) {
        window.history.replaceState(null, '', `#${activeModuleId}`);
        return;
      }
      if (activeModuleId === 'admin-flujos-bot') setStudioDirty(false);
      setActiveModuleId(hashId);
      if (hashId !== 'admin-flujos-bot') setStudioFocusMode(false);
    };
    window.addEventListener('hashchange', syncModuleFromHash);
    return () => window.removeEventListener('hashchange', syncModuleFromHash);
  }, [activeModuleId, studioDirty]);

  useEffect(() => {
    if (!studioDirty) return undefined;
    const warnBeforeUnload = event => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [studioDirty]);

  const activeAreas = useMemo(() => areas.filter(area => area.active !== false), [areas]);
  const flowVersions = useMemo(() => [...new Set(botFlows.map(flow => Number(flow.version_id) || 1))].sort((a, b) => b - a), [botFlows]);
  useEffect(() => { if (flowVersions.length && !flowVersions.includes(studioScope.versionId)) setStudioScope(previous => ({ ...previous, versionId: flowVersions[0] })); }, [flowVersions, studioScope.versionId]);
  const availableAnalysts = useMemo(() => analysts.filter(analyst => analyst.available), [analysts]);
  const activeAgentTokens = useMemo(() => agentTokens.filter(token => token.active && token.role === 'agent'), [agentTokens]);
  const activeQueueTickets = useMemo(() => queueTickets.filter(ticket => ticket.status !== 'closed'), [queueTickets]);
  const slaRiskTickets = useMemo(() => activeQueueTickets.filter(ticket => ['warning', 'breached'].includes(ticket.sla?.state)), [activeQueueTickets]);
  const reportByArea = Array.isArray(reportSummary?.by_area) ? reportSummary.by_area : [];
  const hasAuditNextPage = auditLogs.length === AUDIT_PAGE_SIZE;
  const activeModule = useMemo(
    () => ADMIN_SECTIONS.find(section => section.id === activeModuleId) || ADMIN_SECTIONS[0],
    [activeModuleId],
  );
  const adminSectionContext = useMemo(() => ({
    activeAreasCount: activeAreas.length,
    activeQueueTicketsCount: activeQueueTickets.length,
    analystsCount: analysts.length,
    areasCount: areas.length,
    auditLogsCount: auditLogs.length,
    auditPage,
    availableAnalystsCount: availableAnalysts.length,
    botFlowsCount: botFlows.length,
    candidatesCount: candidates.length,
    flowCacheCount: flowCache.length,
    loading,
    slaRiskTicketsCount: slaRiskTickets.length,
    totalTickets: reportSummary?.total_tickets,
  }), [
    activeAreas.length,
    activeQueueTickets.length,
    analysts.length,
    areas.length,
    auditLogs.length,
    auditPage,
    availableAnalysts.length,
    botFlows.length,
    candidates.length,
    flowCache.length,
    loading,
    reportSummary?.total_tickets,
    slaRiskTickets.length,
  ]);

  const resetAreaForm = () => setAreaForm(EMPTY_AREA_FORM);
  const resetAnalystForm = () => setAnalystForm(EMPTY_ANALYST_FORM);

  const changeStudioScope = useCallback((patch) => {
    if (studioDirty && !window.confirm('Hay cambios sin guardar en el mensaje o el diseño. Si cambias de alcance, se descartarán. ¿Quieres continuar?')) return;
    if (studioDirty) {
      setStudioDiscardCommand({
        id: Date.now(),
        scopeKey: `${studioScope.versionId || 1}:${studioScope.areaId ?? 'global'}`,
      });
      setStudioDirty(false);
    }
    setStudioScope(previous => ({ ...previous, ...patch }));
  }, [studioDirty, studioScope.areaId, studioScope.versionId]);

  const selectModule = (moduleId) => {
    if (moduleId === activeModuleId) return;
    if (activeModuleId === 'admin-flujos-bot' && studioDirty && !window.confirm('Hay cambios sin guardar en el mensaje o el diseño. Si sales del módulo, se descartarán. ¿Quieres continuar?')) return;
    if (activeModuleId === 'admin-flujos-bot') setStudioDirty(false);
    setActiveModuleId(moduleId);
    if (moduleId !== 'admin-flujos-bot') setStudioFocusMode(false);
    if (typeof window !== 'undefined') window.history.replaceState(null, '', `#${moduleId}`);
  };

  const confirmStudioExit = () => !studioDirty || window.confirm('Hay cambios sin guardar en el mensaje o el diseño. Si sales del panel, se descartarán. ¿Quieres continuar?');
  const leaveAdmin = event => {
    if (!confirmStudioExit()) {
      event.preventDefault();
      return;
    }
    setStudioDirty(false);
  };
  const logout = () => {
    if (!confirmStudioExit()) return;
    setStudioDirty(false);
    onLogout();
  };

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

      crossOperationalMutationBarrier();
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
        const current = analysts.find(analyst => String(analyst.id) === String(analystForm.id));
        if (String(current?.area_id || '') !== String(payload.area_id || '') && !window.confirm('Cambiar el área reemplaza el espacio de trabajo actual del analista. El acceso anterior se revoca y el nuevo acceso se aplica inmediatamente. Este cambio quedará auditado. ¿Continuar?')) return;
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

      crossOperationalMutationBarrier();
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
      crossOperationalMutationBarrier();
      setNotice(`${analyst.display_name} marcado como ${analyst.available ? 'no disponible' : 'disponible'}.`);
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'No se pudo cambiar la disponibilidad.');
    }
  };

  const saveStudioFlow = async (flowDraft) => {
    botFlowRequestGenerationRef.current += 1;
    setSavingFlow(true);
    setError(null);
    setNotice(null);

    try {
      const payload = normalizeFlowPayload(flowDraft);
      if (flowDraft.id) {
        const saved = await apiRequest(`/api/admin/bot-flows/${flowDraft.id}`, {
          method: 'PATCH',
          body: jsonBody(payload),
        });
        botFlowRequestGenerationRef.current += 1;
        if (!mountedRef.current) return saved;
        setBotFlows(previous => previous.map(flow => String(flow.id) === String(saved.id) ? saved : flow));
        setNotice('Paso del bot actualizado. La caché fue invalidada.');
        void loadBotFlowData({ force: true });
        return saved;
      } else {
        const saved = await apiRequest('/api/admin/bot-flows', {
          method: 'POST',
          body: jsonBody(payload),
        });
        botFlowRequestGenerationRef.current += 1;
        if (!mountedRef.current) return saved;
        setBotFlows(previous => [...previous, saved]);
        setNotice('Paso del bot creado. La caché fue invalidada.');
        void loadBotFlowData({ force: true });
        return saved;
      }
    } catch (err) {
      if (mountedRef.current) setError(err.message || 'No se pudo guardar el paso del bot.');
      throw err;
    } finally {
      if (mountedRef.current) setSavingFlow(false);
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
      crossOperationalMutationBarrier();
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

  const saveCandidateSettings = async event => {
    event.preventDefault();
    setSavingCandidateSettings(true);
    setError(null);
    setNotice(null);
    try {
      const saved = await apiRequest('/api/admin/candidate-settings', {
        method: 'PUT', body: jsonBody(candidateSettings),
      });
      crossOperationalMutationBarrier();
      setCandidateSettings({ formUrl: saved.formUrl || '', message: saved.message || '' });
      setNotice('Configuración para candidatos actualizada.');
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'No se pudo guardar la configuración para candidatos.');
    } finally {
      setSavingCandidateSettings(false);
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
            <button className="admin-link-btn admin-link-btn--danger" onClick={logout}>Cerrar sesión</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className={`admin-shell ${studioFocusMode ? 'admin-shell--studio-focus' : ''}`}>
      <header className="admin-topbar">
        <div className="admin-topbar__brand">
          <MagnetoLogo variant="dark" className="admin-topbar__logo" />
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
          <a className="action-btn action-btn--glass" href="/" onClick={leaveAdmin}>Panel operativo</a>
          <button className="action-btn action-btn--secondary" onClick={logout}>
            <LogOut size={16} /> Cerrar sesión
          </button>
        </div>
      </header>

      <div className="admin-body">
        <AdminCommandDock sections={ADMIN_SECTIONS} activeModule={activeModule} context={adminSectionContext} onSelect={selectModule} />

        <main className="admin-workspace">
        <div className="admin-module-header">
          <div>
            <p className="admin-kicker">Módulo activo</p>
            <h2>{activeModule.label}</h2>
            <span>{activeModule.brief}</span>
          </div>
          <span className="admin-module-header__status">{activeModule.status?.(adminSectionContext) || 'Disponible'}</span>
        </div>

        {authUnavailable && <AdminAlert type="error">La autenticación administrativa no está disponible en este momento. NEXO volverá a comprobarla al actualizar o reconectar.</AdminAlert>}
        {error && <AdminAlert type="error">{typeof error === 'string' ? error : error.message}</AdminAlert>}
        {notice && <AdminAlert type="success">{notice}</AdminAlert>}

        {activeModuleId === 'admin-resumen' && <>
        <section id="admin-resumen" className="admin-hero-card admin-section-anchor" aria-labelledby="admin-resumen-title">
          <div>
            <p className="admin-kicker">Administración de Fase 4</p>
            <h2 id="admin-resumen-title">Cola híbrida con asignación manual, automática y seguimiento SLA.</h2>
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

        <AdminAlert>
            La presencia se actualiza cada {ADMIN_REFRESH_INTERVAL_MS / 1000} segundos y cuando el socket se reconecta. Los cambios de asignación refrescan la cola en tiempo real.
          </AdminAlert>
        </>}

        {activeModuleId === 'admin-cola-sla' && (
        <section id="admin-cola-sla" className="admin-card admin-card--wide admin-section-anchor">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">Cola y SLA</p>
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
        )}

        {activeModuleId === 'admin-sla-escalamientos' && (
          <Suspense fallback={<AdminAlert>Cargando configuración SLA…</AdminAlert>}>
            <SlaAdministration areas={areas} />
          </Suspense>
        )}

        {activeModuleId === 'admin-areas' && (
        <section id="admin-areas" className="admin-section-group admin-section-anchor" aria-labelledby="admin-areas-title">
          <div className="admin-section-group__header">
            <p className="admin-kicker">Áreas</p>
            <h3 id="admin-areas-title">Mapa de cobertura y SLA</h3>
          </div>

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
          </div>
          <section className="admin-card admin-card--list">
            <div className="admin-section-heading"><div><p className="admin-kicker">Categorías estables</p><h3>Destino operativo</h3></div></div>
            <p className="admin-empty">Plataforma, Resultados de pruebas y Solicitudes deben llegar a Magneto Support; Integraciones debe llegar a Integrations. <strong>Otro</strong> es una salida exclusiva por correo: no crea tickets ni se puede enrutar.</p>
            <p role="status" aria-live="polite" className="admin-empty">{notice || error || ''}</p>
            <div className="admin-list">
              {categoryMappings.map(mapping => (
                <article key={mapping.category_key} className="admin-list-item">
                   <div><h4>{{ platform: 'Novedades de plataforma', tests: 'Resultados de pruebas', requests: 'Solicitudes', integrations: 'Integraciones' }[mapping.category_key] || mapping.category_key}</h4><p>{mapping.active && mapping.area?.active ? `Activo · ${mapping.area.name}` : 'Enrutamiento inactivo'}</p></div>
                   <select disabled={mappingPending === mapping.category_key} aria-label={`Área para ${{ platform: 'Novedades de plataforma', tests: 'Resultados de pruebas', requests: 'Solicitudes', integrations: 'Integraciones' }[mapping.category_key] || mapping.category_key}`} value={mapping.area_id} onChange={async event => {
                     const areaId = Number(event.target.value);
                     const area = areas.find(item => Number(item.id) === areaId);
                     if (!window.confirm(`¿Confirmas enviar esta categoría a ${area?.name || 'el área seleccionada'}?`)) return;
                     setMappingPending(mapping.category_key); setError(null); setNotice(null);
                     try {
                       await apiRequest(`/api/admin/category-area-mappings/${mapping.category_key}`, { method: 'PUT', body: JSON.stringify({ area_id: areaId, active: true }) });
                       setCategoryMappings(previous => previous.map(item => item.category_key === mapping.category_key ? { ...item, area_id: areaId, active: true, area } : item));
                       setNotice('Destino operativo actualizado correctamente.');
                     } catch (mappingError) { setError(mappingError.message || 'No se pudo actualizar el destino operativo.'); }
                     finally { setMappingPending(null); }
                   }}>
                    {activeAreas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
                  </select>
                </article>
              ))}
            </div>
          </section>
        </section>
        )}

        {activeModuleId === 'admin-analistas' && (
        <section id="admin-analistas" className="admin-section-group admin-section-anchor" aria-labelledby="admin-analistas-title">
          <div className="admin-section-group__header">
            <p className="admin-kicker">Analistas</p>
            <h3 id="admin-analistas-title">Presencia y disponibilidad</h3>
          </div>

          <div className="admin-grid">
          <AgentTokenManagement onInventoryChange={setAgentTokens} />
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
                  <span>Token activo del agente</span>
                  <select aria-label="Token activo del agente" value={activeAgentTokens.some(token => String(token.id) === String(analystForm.token_id)) ? analystForm.token_id : ''} onChange={e => setAnalystForm(prev => ({ ...prev, token_id: e.target.value }))} disabled={activeAgentTokens.length === 0}>
                    <option value="">Selecciona un token activo</option>
                    {activeAgentTokens.map(token => <option key={token.id} value={token.id}>{token.name} · Activo</option>)}
                  </select>
                  {activeAgentTokens.length === 0 ? <small>Crea un token activo antes de vincular un analista.</small> : null}
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
              <button className="admin-primary-btn" disabled={savingAnalyst || !analystForm.display_name.trim() || !analystForm.token_id}>
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
        </section>
        )}

        {activeModuleId === 'admin-candidatos' && (
        <section id="admin-candidatos" className="admin-section-group admin-section-anchor" aria-labelledby="admin-candidatos-title">
          <div className="admin-section-group__header">
            <p className="admin-kicker">Protección del canal</p>
            <h3 id="admin-candidatos-title">Candidatos fuera de la cola de soporte</h3>
          </div>
           <AdminAlert>Marcar un contacto detiene el procesamiento de soporte y la creación de tickets futuros. WhatsApp continúa recibiendo sus mensajes.</AdminAlert>
           <AdminAlert>La elección de audiencia en el flujo de prueba se edita en Studio &gt; Salida de candidato. Es un mensaje distinto de esta orientación para contactos ya clasificados.</AdminAlert>
          <div className="admin-grid">
            <section className="admin-card admin-card--form">
              <div className="admin-section-heading"><div><p className="admin-kicker">Orientación segura</p><h3>Formulario y mensaje</h3></div></div>
              <form className="admin-form" onSubmit={saveCandidateSettings}>
                <label><span>Enlace del formulario para candidatos (opcional)</span><input type="url" value={candidateSettings.formUrl} onChange={event => setCandidateSettings(previous => ({ ...previous, formUrl: event.target.value }))} placeholder="https://..." /></label>
                <label><span>Mensaje de orientación (máximo 1000 caracteres)</span><textarea maxLength="1000" rows="6" value={candidateSettings.message} onChange={event => setCandidateSettings(previous => ({ ...previous, message: event.target.value }))} placeholder="Indica el canal correcto sin solicitar datos personales." /></label>
                <p className="admin-helper-text">El mensaje y el enlace se envían de inmediato cuando el contacto es marcado o identificado como candidato. También se envían cuando vuelva a escribir, siempre que haya terminado el tiempo de espera entre avisos.</p>
                <p className="admin-helper-text">Si dejás el enlace vacío, se envía solo el mensaje. Si el mensaje también está vacío, NEXO usa la orientación segura predeterminada. No solicites documentos ni datos sensibles.</p>
                <button className="admin-primary-btn" disabled={savingCandidateSettings}><Save size={16} /> {savingCandidateSettings ? 'Guardando…' : 'Guardar orientación'}</button>
              </form>
            </section>
            <section className="admin-card admin-card--list">
              <div className="admin-section-heading"><div><p className="admin-kicker">Clasificación manual o automática</p><h3>{candidates.length} candidatos</h3></div></div>
              <div className="admin-list">
                {candidates.length === 0 ? <p className="admin-empty">No hay contactos clasificados como candidatos.</p> : candidates.map(candidate => (
                  <article key={candidate.chat_id} className="admin-list-item">
                    <div><h4>{candidate.chat_id}</h4><p>Marcado {formatDate(candidate.marked_at)} · {candidate.source === 'manual' ? 'manual' : 'automático'}</p></div>
                    <span className="admin-pill admin-pill--muted">Soporte detenido</span>
                  </article>
                ))}
              </div>
            </section>
          </div>
        </section>
        )}

        {activeModuleId === 'admin-flujos-bot' && (
        <section id="admin-flujos-bot" className="admin-flow-manager admin-section-anchor">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">Diseño y validación conversacional</p>
              <h3>Mapa de la conversación de soporte</h3>
            </div>
            <div className="admin-row-actions">
              <span className="admin-pill admin-pill--muted">{flowCache.length} entradas en caché</span>
              <button className="admin-soft-btn" onClick={invalidateFlowCache}><RefreshCw size={14} /> Actualizar mensajes activos</button>
            </div>
          </div>
          <p className="admin-helper-text">Actualiza únicamente las plantillas de mensajes ya activas en WhatsApp; no publica ni aplica el borrador visual.</p>
          <div className="studio-scope-controls" aria-label="Alcance del flujo">
              <label><span>Versión</span><select aria-label="Versión del flujo" value={studioScope.versionId} onChange={event => changeStudioScope({ versionId: Number(event.target.value) })}>{(flowVersions.length ? flowVersions : [1]).map(version => <option key={version} value={version}>Versión {version}</option>)}</select></label>
              <label><span>Área</span><select aria-label="Área del flujo" value={studioScope.areaId ?? ''} onChange={event => changeStudioScope({ areaId: normalizeId(event.target.value) })}><option value="">Todas las áreas</option>{areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label>
          </div>
          <Suspense fallback={<div className="studio-state"><div className="qr-loading__spinner" /><strong>Cargando Bot Flow Studio…</strong></div>}>
            <BotFlowStudio flows={botFlows} areas={areas} onSaveFlow={saveStudioFlow} saving={savingFlow} messageScope={studioScope} discardScopeCommand={studioDiscardCommand} onDirtyChange={setStudioDirty} focusMode={studioFocusMode} onFocusModeChange={setStudioFocusMode} onNavigateCandidateSettings={() => selectModule('admin-candidatos')} />
          </Suspense>
        </section>
        )}

        {activeModuleId === 'admin-salesforce-outbox' && (
        <section id="admin-salesforce-outbox" className="admin-card admin-card--wide admin-outbox-card admin-section-anchor">
          <div className="admin-section-heading">
            <div>
              <p className="admin-kicker">Salesforce/Outbox</p>
              <h3>Sin panel de reintentos en esta iteración</h3>
            </div>
            <span className="admin-pill admin-pill--muted">Integración supervisada por backend</span>
          </div>
          <p className="admin-help-text">
            El backoffice ya muestra señales de Salesforce en reportes y auditoría, pero esta pantalla todavía no consume una vista administrativa del outbox. Para evitar controles falsos, esta sección queda como punto de monitoreo honesto hasta implementar la UI de reintentos.
          </p>
          <div className="admin-outbox-grid">
            <AdminStat icon={Paperclip} label="Adjuntos sincronizados" value={formatNumber(reportSummary?.sf_attachments)} tone="purple" />
            <AdminStat icon={Check} label="Tickets cerrados" value={formatNumber(reportSummary?.closed_tickets)} tone="green" />
          </div>
        </section>
        )}

        {activeModuleId === 'admin-reportes' && (
        <section id="admin-reportes" className="admin-card admin-card--wide admin-reports-card admin-section-anchor">
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
        )}

        {activeModuleId === 'admin-auditoria' && (
        <section id="admin-auditoria" className="admin-card admin-card--wide admin-audit-card admin-section-anchor">
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
        )}
        </main>
      </div>
    </div>
  );
}
