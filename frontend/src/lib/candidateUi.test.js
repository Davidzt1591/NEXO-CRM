import { describe, expect, it } from 'vitest';
import { contactMatchesSupportFilter, effectiveCandidateState, updateCandidateContact } from './candidateUi';

describe('candidate mutation effective state', () => {
  it('uses the server state for mark partial failures', () => {
    const state = effectiveCandidateState({ data: { code: 'CANDIDATE_MARK_PARTIAL', candidate: true } });
    expect(updateCandidateContact({ selected: { candidate: false } }, 'selected', state).selected.candidate).toBe(true);
  });

  it('uses the server state for unmark partial failures', () => {
    const state = effectiveCandidateState({ data: { code: 'CANDIDATE_UNMARK_PARTIAL', candidate: true } });
    expect(updateCandidateContact({ selected: { candidate: false } }, 'selected', state).selected.candidate).toBe(true);
  });
});

describe('candidate queue exclusion', () => {
  const candidate = {
    candidate: true, status: 'open', prioridad: 'Alta', chatId: 'chat-1',
    assignment: { analyst_id: 8 }, sla: { state: 'breached' },
  };
  const context = { isAdmin: true, myAnalystId: 8, chatModes: { 'chat-1': 'manual' }, silenced: { 'chat-1': true } };

  it.each([
    ['all', {}], ['alta', {}], ['manual', {}], ['mine', {}],
    ['unassigned', { assignment: null }], ['sla', {}], ['silenced', {}],
    ['cerrados', { status: 'closed' }],
  ])(
    'excludes candidates from the %s operational filter',
    (filter, overrides) => expect(contactMatchesSupportFilter({ ...candidate, ...overrides }, filter, context)).toBe(false),
  );

  it('shows candidates only in the explicit admin candidate filter', () => {
    expect(contactMatchesSupportFilter(candidate, 'candidates', context)).toBe(true);
    expect(contactMatchesSupportFilter(candidate, 'candidates', { ...context, isAdmin: false })).toBe(false);
  });
});
