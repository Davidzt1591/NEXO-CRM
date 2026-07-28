import { useEffect, useRef, useState } from 'react';
import { ChevronLeft, Command, X } from 'lucide-react';

export default function AdminCommandDock({ sections, activeModule, context, onSelect }) {
  const [expanded, setExpanded] = useState(false);
  const dockRef = useRef(null);
  const triggerRef = useRef(null);

  const close = (returnFocus = false) => {
    setExpanded(false);
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  useEffect(() => {
    if (!expanded) return undefined;
    const onPointerDown = event => {
      if (!dockRef.current?.contains(event.target)) close();
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close(true);
      }
    };
    document.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [expanded]);

  return (
    <aside ref={dockRef} className={`admin-command-dock ${expanded ? 'admin-command-dock--expanded' : ''}`} aria-label="Comandos de administración">
      <button
        ref={triggerRef}
        type="button"
        className="admin-command-dock__launcher"
        aria-label={expanded ? 'Cerrar comandos' : 'Abrir comandos'}
        aria-expanded={expanded}
        aria-controls="admin-command-surface"
        data-active-module={activeModule.id}
        title={expanded ? 'Cerrar comandos' : `Abrir comandos · ${activeModule.label}`}
        onClick={() => setExpanded(value => !value)}
      >
        {expanded ? <X size={19} /> : <Command size={19} />}
        {expanded ? <><span>Cerrar</span><ChevronLeft size={15} /></> : null}
      </button>
      {expanded ? <div id="admin-command-surface" className="admin-command-dock__surface">
        <header><span>Centro de control</span><strong>Cambiar módulo</strong></header>
        <nav aria-label="Secciones de administración">
          {sections.map(section => {
            const Icon = section.icon;
            const selected = section.id === activeModule.id;
            return (
              <button key={section.id} type="button" aria-current={selected ? 'page' : undefined} aria-label={section.label} className={selected ? 'is-current' : ''} onClick={() => { onSelect(section.id); close(true); }}>
                <span className="admin-command-dock__icon"><Icon size={18} /></span>
                <span><strong>{section.label}</strong><small>{section.status?.(context) || 'Disponible'}</small></span>
              </button>
            );
          })}
        </nav>
      </div> : null}
    </aside>
  );
}
