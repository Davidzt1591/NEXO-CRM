// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AgentWorkspaceShell from './AgentWorkspaceShell';

vi.mock('../../components/ChatFilters', () => ({
  default: () => <button>Filtro de chats</button>,
}));
vi.mock('../../store/useAppStore', () => ({
  useAppStore: () => ({ contactTags: {}, customNames: {} }),
}));
vi.mock('../conversations/ConversationExperience', () => ({
  default: ({ board }) => <button onClick={board.onReturnList}>Volver a lista</button>,
}));
vi.mock('./ChatWorkspace', () => ({ default: () => <button>Área de chat</button> }));

afterEach(cleanup);

function createWorkspace(conversationView) {
  return {
    authMode: 'qr',
    boardError: null,
    botActivo: true,
    botStatus: 'disconnected',
    chatModes: {},
    claimStates: {},
    conversationView,
    counts: { open: 0, high: 0, manual: 0 },
    currentView: 'chats',
    filter: 'all',
    principal: { user: { role: 'agent' } },
    search: '',
    selectedContact: null,
    selectedId: null,
    silenced: {},
    unread: {},
    visibleContacts: [],
    setAuthMode: vi.fn(),
    setConversationView: vi.fn(),
    setCurrentView: vi.fn(),
    setFilter: vi.fn(),
    setPairingCode: vi.fn(),
    setQrCountdown: vi.fn(),
    setQrDataUrl: vi.fn(),
    setSearch: vi.fn(),
    setSelectedId: vi.fn(),
    setShowQR: vi.fn(),
  };
}

function renderShell(conversationView) {
  const workspace = createWorkspace(conversationView);
  render(
    <AgentWorkspaceShell
      socket={{ emit: vi.fn() }}
      workspace={workspace}
      actions={{}}
      workflowController={{}}
      onLogout={vi.fn()}
      onLoadLogs={vi.fn()}
    />,
  );
  return workspace;
}

async function tabUntil(user, element, maximum = 12) {
  for (let index = 0; index < maximum && document.activeElement !== element; index += 1) {
    await user.tab();
  }
}

describe('AgentWorkspaceShell accessibility', () => {
  it('removes the sidebar from board mode tab order while keeping list return accessible', async () => {
    const user = userEvent.setup();
    renderShell('board');
    const returnControl = screen.getByRole('button', { name: 'Volver a lista' });

    expect(screen.queryByRole('button', { name: 'Chats' })).not.toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Buscar contactos' })).not.toBeInTheDocument();
    await tabUntil(user, returnControl);
    expect(returnControl).toHaveFocus();
  });

  it('includes sidebar controls in list mode and gives contact search an accessible name', async () => {
    const user = userEvent.setup();
    renderShell('list');
    const search = screen.getByRole('textbox', { name: 'Buscar contactos' });

    expect(screen.getByRole('button', { name: 'Chats' })).toBeInTheDocument();
    await tabUntil(user, search);
    expect(search).toHaveFocus();
  });
});
