// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import ConversationBoard, { ConversationViewToggle } from './ConversationBoard';

beforeEach(() => {
  const store = new Map();
  vi.stubGlobal('localStorage', { getItem: vi.fn(key => store.get(key) || null), setItem: vi.fn((key, value) => store.set(key, value)), removeItem: vi.fn(key => store.delete(key)), clear: vi.fn(() => store.clear()) });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });
const ticket = { id: 7, conversation_state: 'in_progress', workflow_revision: 2, prioridad: 'Crítica', priority_normalized: 'critical', area_id: 3, assignment: { analyst_id: 4 }, sla: { support: { state: 'warning', minutes_remaining: 12 } } };

describe('ConversationBoard', () => {
  it('renders all lanes, critical priority, dual clocks, and keyboard state fallback', () => {
    render(<ConversationBoard tickets={[ticket]} unread={{ 7: 2 }} onSelect={vi.fn()} onMove={vi.fn()} onClaim={vi.fn()} />);
    ['Nuevos', 'En gestión', 'En espera', 'Cerrados'].forEach(label => expect(screen.getByRole('heading', { name: label })).toBeInTheDocument());
    expect(screen.getByText('Crítica')).toBeInTheDocument();
    expect(screen.getByText('SLA no configurado')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar estado' }));
    expect(screen.getByRole('menuitem', { name: /En espera/ })).toBeInTheDocument();
  });

  it('requires a waiting reason and close confirmation', () => {
    const onMove = vi.fn(); render(<ConversationBoard tickets={[ticket]} unread={{}} onSelect={vi.fn()} onMove={onMove} onClaim={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'Cambiar estado' })); fireEvent.click(screen.getByRole('menuitem', { name: /En espera/ }));
    expect(screen.getByRole('dialog', { name: 'Poner caso en espera' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Motivo'), { target: { value: 'internal_information' } }); fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(onMove).toHaveBeenCalledWith(ticket, 'waiting', 'internal_information');
  });

  it('uses the same legal confirmation path for desktop drag and drop', () => {
    render(<ConversationBoard tickets={[ticket]} unread={{}} onSelect={vi.fn()} onMove={vi.fn()} onClaim={vi.fn()} />);
    const waitingLane = screen.getByRole('heading', { name: 'En espera' }).closest('section');
    const dataTransfer = { getData: vi.fn(() => '7'), setData: vi.fn() };
    fireEvent.dragStart(document.querySelector('[draggable="true"]'), { dataTransfer }); fireEvent.dragEnter(waitingLane, { dataTransfer });
    expect(waitingLane).toHaveClass('nx-board-lane--target-legal');
    fireEvent.drop(waitingLane, { dataTransfer });
    expect(screen.getByRole('dialog', { name: 'Poner caso en espera' })).toBeInTheDocument();
  });

  it('marks only the hovered destination and distinguishes illegal targets', () => {
    render(<ConversationBoard tickets={[ticket]} unread={{}} onSelect={vi.fn()} onMove={vi.fn()} onClaim={vi.fn()} />);
    const dataTransfer = { getData: vi.fn(() => '7'), setData: vi.fn() }; const card = document.querySelector('[draggable="true"]');
    const newLane = screen.getByRole('heading', { name: 'Nuevos' }).closest('section'); const closedLane = screen.getByRole('heading', { name: 'Cerrados' }).closest('section');
    fireEvent.dragStart(card, { dataTransfer }); fireEvent.dragEnter(newLane, { dataTransfer });
    expect(newLane).toHaveClass('nx-board-lane--target-illegal'); expect(closedLane).not.toHaveClass('nx-board-lane--target-legal');
    fireEvent.dragLeave(newLane, { relatedTarget: document.body }); fireEvent.dragEnter(closedLane, { dataTransfer });
    expect(newLane).not.toHaveClass('nx-board-lane--target-illegal'); expect(closedLane).toHaveClass('nx-board-lane--target-legal');
  });

  it('shows no PII and requires claim for an unassigned queue card', () => {
    const onClaim = vi.fn(); const minimal = { id: 8, queue_card: true, conversation_state: 'new', workflow_revision: 0, area_id: 3, nombre_empresa: 'Must not render' };
    render(<ConversationBoard tickets={[minimal]} unread={{}} onSelect={vi.fn()} onMove={vi.fn()} onClaim={onClaim} />);
    expect(screen.queryByText('Must not render')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Tomar caso' })); expect(onClaim).toHaveBeenCalledWith(minimal);
    expect(screen.queryByRole('button', { name: 'Cambiar estado' })).not.toBeInTheDocument();
  });

  it('keeps notification opt-in off and requests permission only on user action', async () => {
    const requestPermission = vi.fn().mockResolvedValue('denied'); vi.stubGlobal('Notification', { permission: 'default', requestPermission });
    render(<ConversationBoard tickets={[]} unread={{}} onSelect={vi.fn()} onMove={vi.fn()} onClaim={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Activar' })).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(screen.getByRole('button', { name: 'Activar' })); expect(requestPermission).toHaveBeenCalledTimes(1);
  });

  it('degrades a persisted opt-in safely when notifications are unsupported or revoked', () => {
    localStorage.setItem('nexo_board_notifications', 'on');
    render(<ConversationBoard tickets={[]} unread={{}} onSelect={vi.fn()} onMove={vi.fn()} onClaim={vi.fn()} />);
    expect(screen.getByText('Avisos del navegador no disponibles')).toBeInTheDocument();
    cleanup();
    vi.stubGlobal('Notification', { permission: 'denied', requestPermission: vi.fn() });
    render(<ConversationBoard tickets={[]} unread={{}} onSelect={vi.fn()} onMove={vi.fn()} onClaim={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'Activar' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('persists list/board selection through its owner callback', () => {
    const onChange = vi.fn(); render(<ConversationViewToggle view="list" onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: /Tablero/ })); expect(onChange).toHaveBeenCalledWith('board');
  });
});
