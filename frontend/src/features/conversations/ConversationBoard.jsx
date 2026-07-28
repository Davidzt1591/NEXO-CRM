import { Columns3, List } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Button,
  FeedbackState,
  NotificationPreference,
} from '../../components/design-system/NexoPrimitives';
import {
  CONVERSATION_STATES,
  WAITING_REASONS,
  canTransition,
  conversationState,
} from './conversationContracts';
import { BoardLane, StateDialog } from './ConversationBoardParts';
import { incomingCaseHighlightDuration } from './motionTokens';

export default function ConversationBoard(props) {
  const { tickets, unread, onSelect, onMove, onClaim, onReturnList, error } = props;
  const [draggedCaseId, setDraggedCaseId] = useState(null);
  const [targetLane, setTargetLane] = useState(null);
  const [incomingIds, setIncomingIds] = useState(new Set());
  const [pendingMove, setPendingMove] = useState(null);
  const [waitingReason, setWaitingReason] = useState('customer_response');
  const notificationSupported = typeof Notification !== 'undefined'
    && typeof Notification.requestPermission === 'function';
  const [notifications, setNotifications] = useState(
    () => notificationSupported
      && Notification.permission === 'granted'
      && localStorage.getItem('nexo_board_notifications') === 'on',
  );
  const knownIds = useRef(new Set(tickets.map((ticket) => String(ticket.id))));
  const lanes = useMemo(
    () => Object.fromEntries(
      CONVERSATION_STATES.map((state) => [
        state,
        tickets.filter((ticket) => conversationState(ticket) === state),
      ]),
    ),
    [tickets],
  );

  useEffect(() => {
    const nextIds = new Set(tickets.map((ticket) => String(ticket.id)));
    const added = tickets.filter(
      (ticket) => !knownIds.current.has(String(ticket.id)) && conversationState(ticket) === 'new',
    );
    knownIds.current = nextIds;
    if (!added.length) return undefined;
    setIncomingIds(new Set(added.map((ticket) => String(ticket.id))));
    if (notifications && notificationSupported && Notification.permission === 'granted') {
      try {
        new Notification('Nuevo caso en NEXO', {
          body: 'Hay un nuevo caso operativo por revisar.',
          tag: 'nexo-new-case',
        });
      } catch {
        localStorage.setItem('nexo_board_notifications', 'off');
        setNotifications(false);
      }
    }
    const duration = incomingCaseHighlightDuration();
    if (duration === 0) {
      setIncomingIds(new Set());
      return undefined;
    }
    const timer = window.setTimeout(() => setIncomingIds(new Set()), duration);
    return () => window.clearTimeout(timer);
  }, [notificationSupported, notifications, tickets]);

  const changeNotifications = async (enabled) => {
    if (!enabled || !notificationSupported) {
      localStorage.setItem('nexo_board_notifications', 'off');
      setNotifications(false);
      return;
    }
    const permission = await Notification.requestPermission().catch(() => 'denied');
    const granted = permission === 'granted';
    localStorage.setItem('nexo_board_notifications', granted ? 'on' : 'off');
    setNotifications(granted);
  };
  const requestMove = (ticket, target) => {
    if (!canTransition(ticket, target)) return;
    if (target === 'waiting' || target === 'closed') {
      setPendingMove({ ticket, target });
      return;
    }
    onMove(ticket, target);
  };
  const confirmMove = () => {
    const move = pendingMove;
    setPendingMove(null);
    onMove(move.ticket, move.target, move.target === 'waiting' ? waitingReason : null);
  };
  const draggedTicket = tickets.find((ticket) => String(ticket.id) === draggedCaseId);
  const laneActions = {
    findTicket: (id) => tickets.find((ticket) => String(ticket.id) === id),
    finishDrag: () => {
      setTargetLane(null);
      setDraggedCaseId(null);
    },
    onClaim,
    onSelect,
    requestMove,
    setTargetLane,
    startDrag: (ticket) => setDraggedCaseId(String(ticket.id)),
  };

  return (
    <main className="nx-board" aria-label="Tablero de conversaciones">
      <header className="nx-board__header">
        <div>
          <Button variant="secondary" onClick={onReturnList}><List /> Volver a lista</Button>
          <span className="nx-board__eyebrow"><Columns3 aria-hidden="true" /> Flujo operativo</span>
          <h1>Conversaciones</h1>
          <p>Identifica el próximo caso y muévelo sin perder su propiedad.</p>
        </div>
        {notificationSupported ? (
          <NotificationPreference
            enabled={notifications}
            onChange={changeNotifications}
            label="Avisos de casos nuevos"
          />
        ) : (
          <span className="nx-board__notification-unavailable">
            Avisos del navegador no disponibles
          </span>
        )}
      </header>
      {error ? <FeedbackState type="error" title="No se pudo mover el caso" message={error} /> : null}
      <div className="nx-board__lanes">
        {CONVERSATION_STATES.map((state) => (
          <BoardLane
            key={state}
            state={state}
            tickets={lanes[state]}
            unread={unread}
            incomingIds={incomingIds}
            draggedTicket={draggedTicket}
            targetLane={targetLane}
            actions={laneActions}
          />
        ))}
      </div>
      <StateDialog
        pendingMove={pendingMove}
        waitingReason={waitingReason}
        onWaitingReasonChange={setWaitingReason}
        onClose={() => setPendingMove(null)}
        onConfirm={confirmMove}
      />
    </main>
  );
}

export function ConversationViewToggle({ view, onChange }) {
  return (
    <div className="nx-view-toggle" aria-label="Vista de conversaciones">
      <button aria-pressed={view === 'list'} onClick={() => onChange('list')}>
        <List aria-hidden="true" /> Lista
      </button>
      <button aria-pressed={view === 'board'} onClick={() => onChange('board')}>
        <Columns3 aria-hidden="true" /> Tablero
      </button>
    </div>
  );
}
