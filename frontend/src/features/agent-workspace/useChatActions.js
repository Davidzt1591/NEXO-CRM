/* eslint-disable react-hooks/exhaustive-deps */
import { useCallback } from 'react';
import { apiRequest } from '../../lib/apiClient';
import { effectiveCandidateState, updateCandidateContact } from '../../lib/candidateUi';
import { makeIdempotencyKey, workflowErrorCopy } from '../conversations/conversationContracts';
import { getWorkflow, transitionWorkflow } from '../conversations/conversationApi';
import { mergeRealtimeWorkflow } from '../conversations/useConversationWorkflow';

export default function useChatActions({ socket, workspace }) {
  const selectContact = useCallback(contactKey => {
    workspace.setSelectedId(contactKey);
    workspace.setUnread(previous => { const next = { ...previous }; delete next[contactKey]; return next; });
    const contact = workspace.contacts[contactKey];
    if (contact?.id && !contact.queue_card) socket.emit('get-messages', contact.id);
    setTimeout(() => workspace.inputRef.current?.focus(), 50);
  }, [socket, workspace.contacts, workspace.inputRef, workspace.setSelectedId, workspace.setUnread]);

  const sendMessage = useCallback(() => {
    if (!workspace.selectedId || !workspace.selectedContact || (!workspace.newMessage.trim() && !workspace.pendingMedia)) return;
    socket.emit('send-message', {
      chatId: workspace.selectedChatId,
      message: workspace.newMessage.trim(),
      ticketId: workspace.selectedContact.id || null,
      media: workspace.pendingMedia ? {
        data: workspace.pendingMedia.data,
        mimetype: workspace.pendingMedia.mimetype,
        filename: workspace.pendingMedia.filename,
      } : null,
    });
    workspace.setNewMessage('');
    workspace.setPendingMedia(null);
    workspace.setShowEmojiPicker(false);
  }, [socket, workspace.selectedId, workspace.selectedContact, workspace.selectedChatId, workspace.newMessage, workspace.pendingMedia, workspace.setNewMessage, workspace.setPendingMedia, workspace.setShowEmojiPicker]);

  const handleFileSelect = useCallback(event => {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = loadEvent => {
      const dataUrl = loadEvent.target.result;
      const type = file.type.split('/')[0];
      workspace.setPendingMedia({ data: dataUrl.split(',')[1], mimetype: file.type, filename: file.name, type, preview: type === 'image' ? dataUrl : null });
    };
    reader.readAsDataURL(file);
    event.target.value = '';
  }, [workspace.setPendingMedia]);

  const claimTicket = useCallback(contact => {
    const key = String(contact.id);
    const correlationId = globalThis.crypto?.randomUUID?.() || `${key}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    workspace.setClaimStates(previous => ({ ...previous, [key]: 'pending' }));
    try {
      socket.emit('assign-ticket', { ticketId: contact.id, correlationId, analystId: workspace.principal?.analyst?.id, expectedRevision: Number(contact.workflow_revision || 0), idempotencyKey: makeIdempotencyKey('claim') });
    } catch (error) {
      workspace.setClaimStates(previous => ({ ...previous, [key]: `error:${error.message}` }));
    }
  }, [socket, workspace.principal?.analyst?.id, workspace.setClaimStates]);

  const moveBoardTicket = useCallback(async (ticket, target, waitingReason = null) => {
    workspace.setBoardError('');
    try {
      const result = await transitionWorkflow(ticket, target, waitingReason);
      workspace.setContacts(previous => mergeRealtimeWorkflow(previous, result));
    } catch (error) {
      if (error.status === 409) {
        try { const fresh = await getWorkflow(ticket.id); workspace.setContacts(previous => mergeRealtimeWorkflow(previous, fresh)); } catch { /* Preserve conflict copy. */ }
      }
      workspace.setBoardError(workflowErrorCopy(error));
    }
  }, [workspace.setBoardError, workspace.setContacts]);

  const changeCandidateStatus = useCallback(async () => {
    const { selectedContact, selectedChatId, selectedId, candidateAction } = workspace;
    if (!selectedContact?.id || !selectedChatId || candidateAction.loading) return;
    const marking = !selectedContact.candidate;
    if (!window.confirm(marking ? '¿Marcar como candidato? Se detendrá el procesamiento de soporte y no se crearán tickets futuros. WhatsApp seguirá recibiendo sus mensajes.' : '¿Restaurar la atención de soporte? Los mensajes futuros podrán volver a iniciar el flujo de soporte.')) return;
    workspace.setCandidateAction({ loading: true, error: '', notice: '' });
    try {
      const result = await apiRequest(`/api/candidates/${encodeURIComponent(selectedChatId)}?ticket_id=${selectedContact.id}`, { method: marking ? 'PUT' : 'DELETE', body: JSON.stringify({ ticket_id: selectedContact.id }) });
      workspace.setContacts(previous => ({ ...previous, [selectedId]: { ...previous[selectedId], candidate: !!result.candidate } }));
      workspace.setCandidateAction({ loading: false, error: '', notice: marking ? 'Contacto marcado como candidato.' : 'Atención de soporte restaurada.' });
    } catch (error) {
      const effectiveState = effectiveCandidateState(error);
      if (effectiveState !== null) workspace.setContacts(previous => updateCandidateContact(previous, selectedId, effectiveState));
      workspace.setCandidateAction({ loading: false, error: error.message || 'No se pudo cambiar el estado. Reintenta.', notice: '' });
    }
  }, [workspace]);

  const toggleMode = useCallback(contactKey => {
    const contact = workspace.contacts[contactKey];
    const chatId = contact?.chatId || contact?.telefono || contactKey;
    socket.emit('toggle-mode', { chatId, mode: workspace.chatModes[chatId] === 'manual' ? 'auto' : 'manual' });
  }, [socket, workspace.contacts, workspace.chatModes]);
  const toggleSilence = useCallback(() => socket.emit(workspace.silenced[workspace.selectedChatId] ? 'unsilence-chat' : 'silence-chat', workspace.selectedChatId), [socket, workspace.silenced, workspace.selectedChatId]);
  const sendReaction = useCallback((waMessageId, emoji) => socket.emit('react-message', { waMessageId, emoji }), [socket]);
  const improveGrammar = useCallback(() => { if (workspace.newMessage.trim()) { workspace.setIsImprovingText(true); socket.emit('request-grammar', { text: workspace.newMessage, callbackId: Date.now() }); } }, [socket, workspace.newMessage, workspace.setIsImprovingText]);

  return { selectContact, sendMessage, handleFileSelect, claimTicket, moveBoardTicket, changeCandidateStatus, toggleMode, toggleSilence, sendReaction, improveGrammar };
}
