// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import MagnetoLogo from './MagnetoLogo';
import { Button, CasePulse, FeedbackState, NotificationPreference, ToastProvider, useToast } from './NexoPrimitives';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('NEXO design system', () => {
  it('renders the official accessible inline logo with the background variant', () => {
    const { container } = render(<MagnetoLogo variant="dark" />);
    expect(screen.getByRole('img', { name: 'Magneto 365 AI' })).toHaveClass('mg-logo--dark');
    expect(container.querySelector('svg path')).toBeInTheDocument();
  });

  it('exposes truthful button loading and disabled states', () => {
    render(<Button loading>Guardar</Button>);
    expect(screen.getByRole('button', { name: 'Guardar' })).toBeDisabled();
    expect(screen.getByRole('button')).toHaveAttribute('aria-busy', 'true');
  });

  it('presents critical priority, dual clocks, and unconfigured SLA copy', () => {
    render(<CasePulse state="En gestión" area="Producto" priority="Crítica" assignee="Ana" supportSla={{ state: 'warning', display: '00:18' }} />);
    expect(screen.getByRole('region', { name: 'Pulso del caso' })).toHaveTextContent('Crítica');
    expect(screen.getByText('00:18')).toBeInTheDocument();
    expect(screen.getByText('SLA no configurado')).toBeInTheDocument();
  });

  it('uses an alert for error feedback', () => {
    render(<FeedbackState type="error" title="No se pudo guardar" message="Revisa la conexión." />);
    expect(screen.getByRole('alert')).toHaveTextContent('Revisa la conexión');
  });

  it('keeps browser notification controls opt-in', () => {
    const onChange = vi.fn();
    render(<NotificationPreference enabled={false} onChange={onChange} />);
    const button = screen.getByRole('button', { name: 'Activar' });
    expect(button).toHaveAccessibleDescription('Desactivadas por defecto. Requieren tu acción y no mostrarán información personal.');
    expect(document.getElementById(button.getAttribute('aria-describedby'))).toHaveTextContent('no mostrarán información personal');
    fireEvent.click(button);
    expect(onChange).toHaveBeenCalledWith(true);
  });

  it('announces and dismisses toasts', () => {
    function Fixture() { const { notify } = useToast(); return <button onClick={() => notify({ title: 'Actualizado', duration: 0 })}>Avisar</button>; }
    render(<ToastProvider><Fixture /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Avisar' }));
    expect(screen.getByText('Actualizado').closest('[role="status"]')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar notificación' }));
    expect(screen.queryByText('Actualizado')).not.toBeInTheDocument();
  });

  it('automatically dismisses a toast after its duration', () => {
    vi.useFakeTimers();
    function Fixture() { const { notify } = useToast(); return <button onClick={() => notify({ title: 'Temporal', duration: 2500 })}>Avisar</button>; }
    render(<ToastProvider><Fixture /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Avisar' }));
    expect(screen.getByText('Temporal')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(2499));
    expect(screen.getByText('Temporal')).toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.queryByText('Temporal')).not.toBeInTheDocument();
  });

  it('clears pending toast timers when the provider unmounts', () => {
    vi.useFakeTimers();
    const clearTimeoutSpy = vi.spyOn(window, 'clearTimeout');
    function Fixture() { const { notify } = useToast(); return <button onClick={() => notify({ title: 'Pendiente' })}>Avisar</button>; }
    const view = render(<ToastProvider><Fixture /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Avisar' }));
    view.unmount();
    expect(clearTimeoutSpy).toHaveBeenCalled();
  });

  it('keeps multiple notifications independent and announces errors assertively', () => {
    function Fixture() {
      const { notify } = useToast();
      return <><button onClick={() => notify({ title: 'Primera', duration: 0 })}>Primera</button><button onClick={() => notify({ title: 'Falló', tone: 'error', duration: 0 })}>Error</button></>;
    }
    render(<ToastProvider><Fixture /></ToastProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Primera' }));
    fireEvent.click(screen.getByRole('button', { name: 'Error' }));
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(screen.getByRole('alert')).toHaveTextContent('Falló');
    expect(screen.getAllByRole('button', { name: 'Cerrar notificación' })).toHaveLength(2);
  });
});
