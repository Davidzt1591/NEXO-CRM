import { LockKeyhole, MoveRight } from 'lucide-react';
import { useState } from 'react';
import AccessibleDialog from '../../components/design-system/AccessibleDialog';
import { Button, CasePulse } from '../../components/design-system/NexoPrimitives';
import {
  STATE_LABELS,
  WAITING_REASONS,
  canTransition,
  conversationState,
  displayPriority,
  legalTargets,
} from './conversationContracts';
import { toCasePulseClock } from './slaClockAdapter';

function StateMenu({ ticket, onMove }) {
  const [open, setOpen] = useState(false);
  const targets = legalTargets(ticket);
  if (!targets.length) return null;
  const move = (target) => {
    setOpen(false);
    onMove(ticket, target);
  };
  return (
    <div className="nx-state-menu">
      <Button
        variant="secondary"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        Cambiar estado
      </Button>
      {open ? (
        <div role="menu" className="nx-state-menu__surface">
          {targets.map((target) => (
            <button role="menuitem" key={target} onClick={() => move(target)}>
              <MoveRight aria-hidden="true" />
              {STATE_LABELS[target]}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function CaseCard(props) {
  const { ticket, unread, incoming, onSelect, onMove, onClaim, onDragStart } = props;
  const minimal = ticket.queue_card === true;
  const targets = legalTargets(ticket);
  const area = ticket.area?.name || (ticket.area_id ? `Área ${ticket.area_id}` : 'Sin área');
  const assignee = ticket.assignment?.analyst?.display_name
    || (ticket.assignment?.analyst_id ? `Analista ${ticket.assignment.analyst_id}` : 'Sin asignar');
  const startDrag = (event) => {
    event.dataTransfer.setData('text/plain', String(ticket.id));
    onDragStart(ticket);
  };
  return (
    <article
      className={`nx-board-card ${incoming ? 'nx-board-card--incoming' : ''}`}
      draggable={!minimal && targets.length > 0}
      onDragStart={startDrag}
    >
      <button
        type="button"
        className="nx-board-card__select"
        onClick={() => onSelect(String(ticket.id))}
        aria-label={`Abrir caso ${ticket.id}`}
      >
        <span className="nx-board-card__top">
          <strong>Caso #{ticket.id}</strong>
          {unread ? (
            <span className="nx-board-card__unread" aria-label={`${unread} mensajes sin leer`}>
              {unread}
            </span>
          ) : null}
        </span>
        {minimal ? (
          <span className="nx-board-card__privacy">
            <LockKeyhole aria-hidden="true" /> Detalles disponibles al tomar el caso
          </span>
        ) : null}
        <CasePulse
          compact
          state={STATE_LABELS[conversationState(ticket)]}
          area={area}
          priority={displayPriority(ticket)}
          assignee={assignee}
          supportSla={toCasePulseClock(ticket.sla, 'support')}
          developmentSla={toCasePulseClock(ticket.sla, 'development')}
        />
        {!minimal && ticket.waiting_reason ? (
          <span className="nx-board-card__reason">{WAITING_REASONS[ticket.waiting_reason]}</span>
        ) : null}
        <time>
          {ticket.lastTimestamp
            ? new Date(ticket.lastTimestamp).toLocaleString('es-CO')
            : 'Sin actividad registrada'}
        </time>
      </button>
      {minimal ? (
        <Button variant="primary" onClick={() => onClaim(ticket)}>Tomar caso</Button>
      ) : (
        <StateMenu ticket={ticket} onMove={onMove} />
      )}
    </article>
  );
}

export function BoardLane(props) {
  const { state, tickets, unread, incomingIds, draggedTicket, targetLane, actions } = props;
  const hovered = targetLane === state;
  const legal = draggedTicket ? canTransition(draggedTicket, state) : false;
  const targetClass = hovered
    ? legal ? 'nx-board-lane--target-legal' : 'nx-board-lane--target-illegal'
    : '';
  const drop = (event) => {
    event.preventDefault();
    const ticket = actions.findTicket(event.dataTransfer.getData('text/plain'));
    actions.finishDrag();
    if (ticket) actions.requestMove(ticket, state);
  };
  return (
    <section
      className={`nx-board-lane ${targetClass}`}
      aria-labelledby={`lane-${state}`}
      onDragEnter={(event) => {
        event.preventDefault();
        actions.setTargetLane(state);
      }}
      onDragOver={(event) => event.preventDefault()}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) actions.setTargetLane(null);
      }}
      onDrop={drop}
    >
      <header>
        <h2 id={`lane-${state}`}>{STATE_LABELS[state]}</h2>
        <span>{tickets.length}</span>
      </header>
      <div className="nx-board-lane__cards">
        {tickets.map((ticket) => (
          <CaseCard
            key={ticket.id}
            ticket={ticket}
            unread={unread[String(ticket.id)] || 0}
            incoming={incomingIds.has(String(ticket.id))}
            onSelect={actions.onSelect}
            onMove={actions.requestMove}
            onClaim={actions.onClaim}
            onDragStart={actions.startDrag}
          />
        ))}
        {tickets.length === 0 ? <p className="nx-board-lane__empty">Sin casos en este estado</p> : null}
      </div>
    </section>
  );
}

export function StateDialog(props) {
  const { pendingMove, waitingReason, onWaitingReasonChange, onClose, onConfirm } = props;
  if (!pendingMove) return null;
  const waiting = pendingMove.target === 'waiting';
  return (
    <AccessibleDialog
      title={waiting ? 'Poner caso en espera' : 'Cerrar conversación'}
      onClose={onClose}
      footer={(
        <>
          <Button onClick={onClose}>Cancelar</Button>
          <Button variant="technology" onClick={onConfirm}>Confirmar</Button>
        </>
      )}
    >
      {waiting ? (
        <label>
          Motivo
          <select value={waitingReason} onChange={(event) => onWaitingReasonChange(event.target.value)}>
            {Object.entries(WAITING_REASONS).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
      ) : (
        <p>El caso se cerrará y no podrá reabrirse desde este flujo.</p>
      )}
    </AccessibleDialog>
  );
}
