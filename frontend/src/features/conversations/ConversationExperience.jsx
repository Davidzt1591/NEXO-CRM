import { Button } from '../../components/design-system/NexoPrimitives';
import ConversationBoard from './ConversationBoard';
import ConversationWorkspace from './ConversationWorkspace';

export function BoardExperience({ tickets, unread, selectedContact, controller, principal, error, onSelect, onMove, onClaim, onReturnList, onCloseWorkspace }) {
  return <><ConversationBoard tickets={tickets} unread={unread} onSelect={onSelect} onMove={onMove} onClaim={onClaim} onReturnList={onReturnList} error={error} />{selectedContact && !selectedContact.queue_card ? <aside className="nx-board-workspace-overlay" aria-label="Espacio de conversación"><Button variant="secondary" onClick={onCloseWorkspace}>Volver al tablero</Button><ConversationWorkspace controller={controller} principal={principal} /></aside> : null}</>;
}

export default function ConversationExperience({ view, children, board }) {
  if (view === 'board') return <BoardExperience {...board} />;
  return children;
}
