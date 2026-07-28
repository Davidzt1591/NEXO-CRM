// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import { canTransition, canUpdateDevelopment, legalTargets, makeIdempotencyKey, safeBoardTicket, workflowErrorCopy } from './conversationContracts';
import { mergeRealtimeWorkflow, newerWorkflow } from './useConversationWorkflow';

describe('conversation contracts', () => {
  it('allows only the Phase11 legal state machine and never reopens closed cases', () => {
    expect(legalTargets({ conversation_state: 'new' })).toEqual([]);
    expect(legalTargets({ conversation_state: 'in_progress' })).toEqual(['waiting', 'closed']);
    expect(legalTargets({ conversation_state: 'waiting' })).toEqual(['in_progress', 'closed']);
    expect(legalTargets({ conversation_state: 'closed' })).toEqual([]);
    expect(canTransition({ conversation_state: 'closed' }, 'in_progress')).toBe(false);
  });

  it('enforces legal development status updates', () => {
    expect(canUpdateDevelopment({ status: 'requested' }, 'in_progress')).toBe(true);
    expect(canUpdateDevelopment({ status: 'in_progress' }, 'resolved')).toBe(true);
    expect(canUpdateDevelopment({ status: 'resolved' }, 'in_progress')).toBe(false);
  });

  it('requires cryptographically generated idempotency keys', () => {
    vi.stubGlobal('crypto', { randomUUID: () => '12345678-1234-1234-1234-123456789abc' });
    expect(makeIdempotencyKey('transition')).toBe('transition_12345678_1234_1234_1234_123456789abc');
    vi.unstubAllGlobals();
  });

  it('strips unavailable PII from minimal queue cards', () => {
    const card = safeBoardTicket({ id: 1, queue_card: true, area_id: 2, telefono: 'secret', correo: 'secret@example.com', nombre_empresa: 'Secret' });
    expect(card).not.toHaveProperty('telefono'); expect(card).not.toHaveProperty('correo'); expect(card).not.toHaveProperty('nombre_empresa');
  });

  it('deduplicates stale realtime updates by workflow revision', () => {
    const current = { 1: { id: 1, workflow_revision: 3, conversation_state: 'waiting' } };
    expect(mergeRealtimeWorkflow(current, { id: 1, workflow_revision: 2, conversation_state: 'new' })).toBe(current);
    expect(mergeRealtimeWorkflow(current, { id: 1, workflow_revision: 4, conversation_state: 'closed' })['1'].conversation_state).toBe('closed');
  });

  it('replaces a previous full contact with a strict minimal allowlist', () => {
    const full = { id: 1, workflow_revision: 3, nombre_analista: 'Persona', telefono: '300', correo: 'x@y.co', nombre_empresa: 'Empresa', chatId: 'secret', situacion: 'Issue', messages: ['secret'], media: 'secret', customName: 'secret', unknown_secret: 'secret' };
    const result = mergeRealtimeWorkflow({ 1: full }, { id: 1, workflow_revision: 4, queue_card: true, area_id: 2, conversation_state: 'new' })['1'];
    ['nombre_analista', 'telefono', 'correo', 'nombre_empresa', 'chatId', 'situacion', 'messages', 'media', 'customName', 'unknown_secret'].forEach(key => expect(result).not.toHaveProperty(key));
    expect(Object.keys(result).sort()).toEqual(['id','area_id','categoria','prioridad','priority_normalized','status','conversation_state','workflow_revision','created_at','closed_at','sla','assignment','queue_card','contactKey'].sort());
  });

  it('guards selected workflow against lower and equal duplicate revisions', () => {
    const current = { id: 1, workflow_revision: 5, conversation_state: 'closed' };
    expect(newerWorkflow(current, { id: 1, workflow_revision: 4, conversation_state: 'new' })).toBe(current);
    expect(newerWorkflow(current, { id: 1, workflow_revision: 5, conversation_state: 'waiting' })).toBe(current);
    expect(newerWorkflow(current, { id: 1, workflow_revision: 6, conversation_state: 'waiting' }).conversation_state).toBe('waiting');
    expect(newerWorkflow(current, { id: 2, workflow_revision: 2, conversation_state: 'new' }).id).toBe(2);
  });

  it('maps stale revision conflicts to actionable Spanish copy', () => {
    expect(workflowErrorCopy({ status: 409 })).toContain('cambió en otra sesión');
  });
});
