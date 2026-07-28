/* @vitest-environment jsdom */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

vi.mock('./store/useAppStore', () => ({
  useAppStore: () => ({ contactTags: {}, customNames: {} }),
}));

import { ContactCard } from './App';
import { applyClaimFailure } from './lib/claimState';

describe('Phase 10 contact card accessibility', () => {
  it('selects an assigned ticket with the keyboard without nesting the claim action', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const { container } = render(
      <ContactCard
        contact={{ id: 42, nombre_analista: 'Ada', area: { name: 'Integrations' }, assignment: { analyst_id: 7 } }}
        unread={0}
        onClick={onSelect}
      />,
    );

    const select = screen.getByRole('button', { name: 'Abrir ticket de Ada' });
    select.focus();
    await user.keyboard('{Enter}');
    await user.keyboard(' ');

    expect(onSelect).toHaveBeenCalledTimes(2);
    expect(container.querySelector('button button')).toBeNull();
  });

  it('attributes concurrent claim failures only to the matching ticket', () => {
    const pending = { '41': 'pending', '42': 'pending' };
    expect(applyClaimFailure(pending, { ticketId: 42, correlationId: '42', message: 'Taken' })).toEqual({
      '41': 'pending',
      '42': 'error:Taken',
    });
  });

  it('cleans up only the correlated pending claim for assignment and auth errors', () => {
    const pending = { '41': 'pending', '42': 'pending' };
    const assignment = applyClaimFailure(pending, { ticketId: '41', correlationId: 'claim-a', message: 'Taken' });
    const auth = applyClaimFailure(assignment, { ticketId: '42', correlationId: 'claim-b', message: 'Unauthorized' });
    expect(auth).toEqual({ '41': 'error:Taken', '42': 'error:Unauthorized' });
    expect(Object.values(auth)).not.toContain('pending');
  });
});
