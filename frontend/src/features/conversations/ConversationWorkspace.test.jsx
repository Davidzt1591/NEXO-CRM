// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ConversationWorkspace from './ConversationWorkspace';

afterEach(cleanup);
const workflow = { id: 1, conversation_state: 'in_progress', workflow_revision: 2, priority_normalized: 'critical', area: { name: 'Producto' }, assignment: { analyst_id: 4, analyst: { display_name: 'Ana' } }, sla: {} };
function controller(overrides = {}) { return { workflow, state: { pending: '', error: '' }, transition: vi.fn(), escalate: vi.fn(), updateEscalation: vi.fn(), ...overrides }; }

describe('ConversationWorkspace', () => {
  it('uses Case Pulse and captures an internal escalation summary without customer messaging controls', () => {
    const value = controller(); render(<ConversationWorkspace controller={value} principal={{ analyst: { id: 4 }, user: { role: 'analyst' } }} />);
    expect(screen.getByRole('region', { name: 'Pulso del caso' })).toHaveTextContent('SLA no configurado');
    fireEvent.click(screen.getByRole('button', { name: /Escalar a Desarrollo/ }));
    expect(screen.getByPlaceholderText(/No se enviará a WhatsApp/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Resumen interno'), { target: { value: 'Impacto alto, logs disponibles.' } }); fireEvent.click(screen.getByRole('button', { name: 'Confirmar' }));
    expect(value.escalate).toHaveBeenCalledWith('Impacto alto, logs disponibles.');
  });

  it('renders internal timeline separately and allows only assigned analyst updates', () => {
    const escalated = { ...workflow, conversation_state: 'waiting', waiting_reason: 'development_escalation', development_escalations: [{ status: 'requested', note: 'Solo interno' }] };
    const value = controller({ workflow: escalated }); render(<ConversationWorkspace controller={value} principal={{ analyst: { id: 4 }, user: { role: 'analyst' } }} />);
    expect(screen.getByRole('region', { name: 'Escalamiento interno a Desarrollo' })).toHaveTextContent('Canal interno');
    expect(screen.getByRole('complementary', { name: 'Nota interna' })).toHaveTextContent('Solo interno');
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar trabajo' })); expect(value.updateEscalation).toHaveBeenCalledWith('in_progress');
  });

  it('hides development updates from a different analyst and exposes workflow errors', () => {
    const escalated = { ...workflow, development_escalations: [{ status: 'in_progress' }] };
    render(<ConversationWorkspace controller={controller({ workflow: escalated, state: { pending: '', error: 'El caso cambió en otra sesión.' } })} principal={{ analyst: { id: 99 }, user: { role: 'analyst' } }} />);
    expect(screen.queryByRole('button', { name: 'Marcar solucionado' })).not.toBeInTheDocument(); expect(screen.getByRole('alert')).toHaveTextContent('cambió');
  });
});
