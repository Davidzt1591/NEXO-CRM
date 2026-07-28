import { X } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef } from 'react';

const FOCUSABLE = 'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

export default function AccessibleDialog({ title, onClose, children, footer, busy = false, backdropDismiss = true, initialFocus = 'first', className = '' }) {
  const titleId = useId();
  const backdropRef = useRef(null);
  const returnFocusRef = useRef(document.activeElement);
  const onCloseRef = useRef(onClose);
  const busyRef = useRef(busy);
  useLayoutEffect(() => { onCloseRef.current = onClose; busyRef.current = busy; }, [busy, onClose]);
  useEffect(() => {
    const backdrop = backdropRef.current;
    const returnFocus = returnFocusRef.current;
    const siblings = backdrop ? [...backdrop.parentElement.children].filter(node => node !== backdrop) : [];
    siblings.forEach(node => { node.setAttribute('aria-hidden', 'true'); node.inert = true; });
    const focusable = [...backdrop.querySelectorAll(FOCUSABLE)];
    (initialFocus === 'last' ? focusable.at(-1) : focusable[0])?.focus();
    const keydown = event => {
      if (event.key === 'Escape' && !busyRef.current) { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab' || !focusable.length) return;
      const first = focusable[0]; const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    backdrop.addEventListener('keydown', keydown);
    return () => {
      backdrop.removeEventListener('keydown', keydown);
      siblings.forEach(node => { node.removeAttribute('aria-hidden'); node.inert = false; });
      window.setTimeout(() => returnFocus?.focus(), 0);
    };
  }, [initialFocus]);
  return <div ref={backdropRef} className="nx-dialog-backdrop" onMouseDown={event => event.target === event.currentTarget && backdropDismiss && !busy && onClose()}><section role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy || undefined} className={`nx-dialog ${className}`.trim()}><header><h2 id={titleId}>{title}</h2><button disabled={busy} onClick={onClose} aria-label="Cerrar diálogo"><X aria-hidden="true" /></button></header><div className="nx-dialog__body">{children}</div>{footer ? <footer>{footer}</footer> : null}</section></div>;
}
