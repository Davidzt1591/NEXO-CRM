// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import ConversationExperience from './ConversationExperience';

const controller = { workflow: { id: 7, conversation_state: 'new', assignment: {}, sla: {} }, state: {}, transition: vi.fn(), escalate: vi.fn(), updateEscalation: vi.fn() };
describe('ConversationExperience', () => {
  it('composes board selection, list return and selected workspace overlay', async () => {
    const user = userEvent.setup(); const onSelect = vi.fn(); const onReturnList = vi.fn(); const onCloseWorkspace = vi.fn();
    render(<ConversationExperience view="board" board={{ tickets: [{ id: 7, conversation_state: 'new', assignment: {}, sla: {} }], unread: {}, selectedContact: { id: 7 }, controller, principal: { user: { role: 'admin' } }, onSelect, onMove: vi.fn(), onClaim: vi.fn(), onReturnList, onCloseWorkspace }} />);
    await user.click(screen.getByRole('button', { name: /Abrir caso 7/i })); expect(onSelect).toHaveBeenCalledWith('7'); expect(screen.getByLabelText('Espacio de conversación')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Volver a lista/i })); expect(onReturnList).toHaveBeenCalled(); await user.click(screen.getByRole('button', { name: /Volver al tablero/i })); expect(onCloseWorkspace).toHaveBeenCalled();
  });
  it('renders the list/chat composition unchanged outside board mode', () => { render(<ConversationExperience view="list"><div>Lista y chat</div></ConversationExperience>); expect(screen.getByText('Lista y chat')).toBeInTheDocument(); });
});
