import { AlertCircle, CheckCircle2, Info, LoaderCircle, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useId, useMemo, useRef, useState } from 'react';

export function Button({ variant = 'secondary', loading = false, children, className = '', disabled, ...props }) {
  return <button className={`nx-button nx-button--${variant} ${className}`.trim()} disabled={disabled || loading} aria-busy={loading || undefined} {...props}>{loading ? <LoaderCircle className="nx-spin" aria-hidden="true" /> : null}<span>{children}</span></button>;
}

export function StatusPill({ tone = 'neutral', children }) {
  return <span className={`nx-status nx-status--${tone}`}><span className="nx-status__dot" aria-hidden="true" />{children}</span>;
}

const slaCopy = { healthy: 'En tiempo', warning: 'Por vencer', breached: 'Vencido', paused: 'Pausado', unconfigured: 'SLA no configurado' };
function SlaClock({ label, clock }) {
  const state = clock?.state || 'unconfigured';
  return <div className={`nx-case-pulse__clock nx-case-pulse__clock--${state}`}><span>{label}</span><strong>{clock?.display || slaCopy[state] || slaCopy.unconfigured}</strong><span className="nx-sr-only">, {slaCopy[state] || state}</span></div>;
}

export function CasePulse({ state, area, priority, assignee, supportSla, developmentSla, compact = false }) {
  return (
    <section className={`nx-case-pulse ${compact ? 'nx-case-pulse--compact' : ''}`} aria-label="Pulso del caso">
      <div className="nx-case-pulse__facts">
        <StatusPill tone={state === 'closed' ? 'neutral' : 'info'}>{state || 'Sin estado'}</StatusPill>
        <span>{area || 'Sin área'}</span><span className={`nx-case-pulse__priority nx-case-pulse__priority--${String(priority || 'media').toLowerCase()}`}>{priority || 'Media'}</span><span>{assignee || 'Sin asignar'}</span>
      </div>
      <div className="nx-case-pulse__ribbon"><SlaClock label="Soporte" clock={supportSla} /><SlaClock label="Desarrollo" clock={developmentSla} /></div>
    </section>
  );
}

const feedbackIcons = { error: AlertCircle, success: CheckCircle2, info: Info, loading: LoaderCircle };
export function FeedbackState({ type = 'info', title, message, action }) {
  const Icon = feedbackIcons[type] || Info;
  return <div className={`nx-feedback nx-feedback--${type}`} role={type === 'error' ? 'alert' : 'status'}><Icon className={type === 'loading' ? 'nx-spin' : ''} aria-hidden="true" /><div><strong>{title}</strong>{message ? <p>{message}</p> : null}{action}</div></div>;
}

const ToastContext = createContext(null);
export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Map());
  const dismiss = useCallback(id => { window.clearTimeout(timers.current.get(id)); timers.current.delete(id); setToasts(current => current.filter(item => item.id !== id)); }, []);
  const notify = useCallback(({ duration = 5000, ...toast }) => {
    const id = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random()}`;
    setToasts(current => [...current, { ...toast, id }]);
    if (duration > 0) timers.current.set(id, window.setTimeout(() => dismiss(id), duration));
    return id;
  }, [dismiss]);
  useEffect(() => () => timers.current.forEach(timer => window.clearTimeout(timer)), []);
  const value = useMemo(() => ({ notify, dismiss }), [dismiss, notify]);
  return <ToastContext.Provider value={value}>{children}<div className="nx-toast-region" aria-label="Notificaciones" aria-live="polite">{toasts.map(toast => <div className={`nx-toast nx-toast--${toast.tone || 'info'}`} role={toast.tone === 'error' ? 'alert' : 'status'} key={toast.id}><div><strong>{toast.title}</strong>{toast.message ? <p>{toast.message}</p> : null}</div><button type="button" onClick={() => dismiss(toast.id)} aria-label="Cerrar notificación"><X aria-hidden="true" /></button></div>)}</div></ToastContext.Provider>;
}

// Hook and provider intentionally share this small context boundary.
// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error('useToast must be used within ToastProvider');
  return context;
}

export function NotificationPreference({ enabled, onChange, label = 'Notificaciones del navegador' }) {
  const baseId = useId();
  const labelId = `${baseId}-label`;
  const descriptionId = `${baseId}-description`;
  return <div className="nx-notification-preference"><div><strong id={labelId}>{label}</strong><span id={descriptionId}>Desactivadas por defecto. Requieren tu acción y no mostrarán información personal.</span></div><Button variant="secondary" aria-describedby={descriptionId} aria-pressed={enabled} onClick={() => onChange?.(!enabled)}>{enabled ? 'Desactivar' : 'Activar'}</Button></div>;
}
