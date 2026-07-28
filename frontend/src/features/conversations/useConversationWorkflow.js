import { useCallback, useEffect, useRef, useState } from 'react';
import { getWorkflow, requestDevelopment, transitionWorkflow, updateDevelopment } from './conversationApi';
import { safeBoardTicket, workflowErrorCopy } from './conversationContracts';

export function mergeRealtimeWorkflow(current, incoming) {
  if (!incoming?.id) return current;
  const key = String(incoming.id);
  const existing = current[key];
  if (existing && Number(incoming.workflow_revision) <= Number(existing.workflow_revision)) return current;
  if (incoming.queue_card) return { ...current, [key]: { ...safeBoardTicket(incoming), contactKey: key } };
  return { ...current, [key]: { ...existing, ...incoming, contactKey: key } };
}

export function newerWorkflow(current, incoming) {
  if (!incoming?.id) return current;
  if (!current?.id || String(current.id) !== String(incoming.id)) return incoming;
  return current && Number(incoming.workflow_revision) <= Number(current.workflow_revision) ? current : incoming;
}

export function useConversationWorkflow({ ticket, setContacts, socket, canReadFull }) {
  const [workflow, setWorkflow] = useState(null);
  const [state, setState] = useState({ loading: false, pending: '', error: '', notice: '' });
  const abortRef = useRef(null);
  const selectedTicketIdRef = useRef(ticket?.id == null ? null : String(ticket.id));
  selectedTicketIdRef.current = ticket?.id == null ? null : String(ticket.id);

  const refresh = useCallback(async () => {
    if (!ticket?.id || !canReadFull) { setWorkflow(null); return null; }
    const requestedTicketId = String(ticket.id);
    abortRef.current?.abort();
    const controller = new AbortController(); abortRef.current = controller;
    setState(previous => ({ ...previous, loading: true, error: '' }));
    try {
      const fresh = await getWorkflow(ticket.id, { signal: controller.signal });
      if (controller.signal.aborted || selectedTicketIdRef.current !== requestedTicketId || String(fresh?.id) !== requestedTicketId) return null;
      setWorkflow(current => newerWorkflow(current, fresh)); setContacts(previous => mergeRealtimeWorkflow(previous, fresh));
      setState(previous => ({ ...previous, loading: false })); return fresh;
    } catch (error) {
      if (error.name === 'AbortError') return null;
      setState(previous => ({ ...previous, loading: false, error: workflowErrorCopy(error) })); return null;
    }
  }, [canReadFull, setContacts, ticket?.id]);

  useEffect(() => { refresh(); return () => abortRef.current?.abort(); }, [refresh]);
  useEffect(() => {
    const update = payload => {
      const incoming = payload?.ticket || payload;
      if (!incoming?.id) return;
      setContacts(previous => mergeRealtimeWorkflow(previous, incoming));
      if (String(incoming.id) === selectedTicketIdRef.current && !incoming.queue_card) setWorkflow(current => newerWorkflow(current, incoming));
    };
    socket.on('conversation-state-changed', update); socket.on('development-escalation-changed', update);
    return () => { socket.off('conversation-state-changed', update); socket.off('development-escalation-changed', update); };
  }, [setContacts, socket, ticket?.id]);

  const mutate = useCallback(async (name, operation) => {
    setState({ loading: false, pending: name, error: '', notice: '' });
    try {
      const result = await operation();
      if (String(result?.id) === selectedTicketIdRef.current) setWorkflow(current => newerWorkflow(current, result));
      setContacts(previous => mergeRealtimeWorkflow(previous, result));
      setState({ loading: false, pending: '', error: '', notice: 'Caso actualizado.' }); return result;
    } catch (error) {
      if (error.status === 409) await refresh();
      setState({ loading: false, pending: '', error: workflowErrorCopy(error), notice: '' }); return null;
    }
  }, [refresh, setContacts]);

  return {
    workflow: workflow && String(workflow.id) === String(ticket?.id) ? workflow : ticket, state, refresh,
    transition: (target, reason) => mutate(`transition:${target}`, () => transitionWorkflow(workflow || ticket, target, reason)),
    escalate: note => mutate('development:requested', () => requestDevelopment(workflow || ticket, note)),
    updateEscalation: (status, note) => mutate(`development:${status}`, () => updateDevelopment(workflow || ticket, status, note)),
  };
}
