/* eslint-disable react-hooks/exhaustive-deps */
import { useCallback, useEffect, useState } from 'react';
import '../../App.css';
import AdminPanel from '../../components/AdminPanel';
import { apiRequest } from '../../lib/apiClient';
import { socket } from '../../lib/nexoSocket';
import AgentWorkspaceShell from '../agent-workspace/AgentWorkspaceShell';
import WorkspaceDialogs from '../agent-workspace/WorkspaceDialogs';
import useAgentWorkspaceState from '../agent-workspace/useAgentWorkspaceState';
import useChatActions from '../agent-workspace/useChatActions';
import useOperationalSocketEvents from '../agent-workspace/useOperationalSocketEvents';
import { AuthMethodTabs } from '../connection/ConnectionDialog';
import { ContactCard } from '../agent-workspace/WorkspacePrimitives';
import { useConversationWorkflow } from '../conversations/useConversationWorkflow';
import SessionGate from '../session/SessionGate';
import { useSessionLifecycle } from '../session/useSessionLifecycle';

export { AuthMethodTabs, ContactCard };

export function RateLimitBanner({ state, onExpired }) {
  const [remaining, setRemaining] = useState(() => state ? Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000)) : 0);
  useEffect(() => {
    if (!state) return undefined;
    const timer = window.setInterval(() => {
      const next = Math.max(0, Math.ceil((state.retryAt - Date.now()) / 1000));
      setRemaining(next);
      if (next === 0) onExpired?.(state.generation);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [onExpired, state]);
  if (!state) return null;
  return <div className="rate-limit-banner" role="status">NEXO recibió demasiadas solicitudes para esta operación. {remaining > 0 ? `Puedes reintentar en ${remaining} segundos.` : 'Ya puedes reintentar.'} No cierres sesión.</div>;
}

export default function AppCoordinator() {
  // Board layout ownership is rendered by AgentWorkspaceShell (`workspace--board`).
  const workspace = useAgentWorkspaceState();
  const clearSessionView = useCallback(() => workspace.setSystemInfo(null), [workspace.setSystemInfo]);
  const session = useSessionLifecycle({ clearSensitiveState: workspace.clearSensitiveState, socket, onPrincipal: workspace.setPrincipal, onLogout: clearSessionView });
  const actions = useChatActions({ socket, workspace });
  const canReadFull = workspace.principal?.user?.role === 'admin' || (!!workspace.selectedContact?.assignment?.analyst_id && String(workspace.selectedContact.assignment.analyst_id) === String(workspace.principal?.analyst?.id));
  const workflowController = useConversationWorkflow({ ticket: workspace.selectedContact, setContacts: workspace.setContacts, socket, canReadFull });
  useOperationalSocketEvents({ authenticated: session.authenticated, socket, workspace, setAuthError: session.setError, setAuthenticated: session.setAuthenticated });

  useEffect(() => {
    workspace.messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [workspace.selectedMessages.length, workspace.messagesEndRef]);
  useEffect(() => {
    if (!workspace.selectedContact?.id || !workspace.selectedChatId) return undefined;
    let active = true;
    workspace.setCandidateAction(previous => ({ ...previous, error: '', notice: '' }));
    apiRequest(`/api/candidates/${encodeURIComponent(workspace.selectedChatId)}/status?ticket_id=${workspace.selectedContact.id}`)
      .then(status => { if (active) workspace.setContacts(previous => ({ ...previous, [workspace.selectedId]: { ...previous[workspace.selectedId], candidate: !!status?.candidate } })); })
      .catch(error => { if (active) workspace.setCandidateAction(previous => ({ ...previous, error: error.message || 'No se pudo consultar el estado de candidato.' })); });
    return () => { active = false; };
  }, [workspace.selectedContact?.id, workspace.selectedChatId, workspace.selectedId, workspace.setCandidateAction, workspace.setContacts]);
  useEffect(() => {
    if (workspace.principal?.user?.role !== 'admin') return;
    apiRequest('/api/admin/candidates').then(result => {
      const ids = new Set((result?.candidates || []).map(candidate => candidate.chat_id));
      workspace.setContacts(previous => Object.fromEntries(Object.entries(previous).map(([key, contact]) => [key, { ...contact, candidate: ids.has(contact.chatId || contact.telefono) }])));
    }).catch(() => {});
  }, [workspace.principal?.user?.role, workspace.setContacts]);

  const loadLogs = useCallback(async () => {
    workspace.setLogsLoading(true);
    workspace.setCurrentView('logs');
    try { const data = await apiRequest('/api/logs'); workspace.setLogs(data.reverse()); }
    catch (error) { workspace.setLogs([{ ts: new Date().toISOString(), type: 'ERROR', msg: `No se pudo conectar al API de logs: ${error.message}` }]); }
    finally { workspace.setLogsLoading(false); }
  }, [workspace.setCurrentView, workspace.setLogs, workspace.setLogsLoading]);
  const clearExpiredRateLimit = useCallback(generation => workspace.setRateLimitState(current => current?.generation === generation ? null : current), [workspace.setRateLimitState]);

  if (!session.authenticated) return <SessionGate session={session}><div /></SessionGate>;
  if (window.location.pathname === '/admin') return <><RateLimitBanner key={workspace.rateLimitState?.generation} state={workspace.rateLimitState} onExpired={clearExpiredRateLimit} /><AdminPanel socket={socket} onLogout={session.logout} /></>;
  return <div className="layout"><RateLimitBanner key={workspace.rateLimitState?.generation} state={workspace.rateLimitState} onExpired={clearExpiredRateLimit} /><AgentWorkspaceShell socket={socket} workspace={workspace} actions={actions} workflowController={workflowController} onLogout={session.logout} onLoadLogs={loadLogs} /><WorkspaceDialogs socket={socket} workspace={workspace} /></div>;
}
