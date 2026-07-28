import { Edit3, RotateCcw, Send, ShieldOff, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

export default function SimulatorPanel({ messages, busy, error, pending, selection, onEditSelected, onNavigateCandidateSettings, onSend, onRetry, onReset, onClose }) {
  const [input, setInput] = useState('');
  const candidateNoticeHeadingRef = useRef(null);
  const candidateSelection = selection?.message_key === 'candidate_exit';
  useEffect(() => {
    if (candidateSelection) candidateNoticeHeadingRef.current?.focus();
  }, [candidateSelection, selection?.source]);
  const submit = event => { event.preventDefault(); if (!input.trim() || busy) return; onSend(input.trim()); setInput(''); };
  return (
    <section className="studio-simulator" aria-label="Simulador de conversación">
      <header><div><span>Prueba segura</span><strong>Conversación de prueba</strong></div><button type="button" onClick={() => { if (!messages.length || window.confirm('Reiniciar eliminará la conversación de prueba actual. ¿Quieres continuar?')) onReset(); }} disabled={busy}><RotateCcw size={15} /> Reiniciar simulación</button><button type="button" className="studio-panel-close" aria-label="Cerrar simulador" onClick={onClose}><X size={16} /></button></header>
      <div className="studio-dry-run"><ShieldOff size={15} /> Esta prueba no envía mensajes ni crea casos reales.</div>
      {candidateSelection ? <aside className="studio-simulation-provenance" aria-label="Proveniencia del mensaje"><h3 ref={candidateNoticeHeadingRef} tabIndex={-1} aria-label={`Rama seleccionada: Candidato. Este mensaje del flujo de prueba se edita aquí; es distinto de la orientación segura para contactos de WhatsApp ya clasificados. Origen: ${selection.source === 'bot_flows' ? 'mensaje guardado en Bot Flows' : 'mensaje de respaldo'}.`}>Rama seleccionada: Candidato</h3><span>Este mensaje pertenece al flujo de prueba.</span><span>Origen: {selection.source === 'bot_flows' ? 'mensaje guardado en Bot Flows' : 'mensaje de respaldo'}</span><button type="button" className="admin-primary-btn" onClick={onEditSelected}><Edit3 size={15} /> Editar este mensaje</button><p>Los contactos de WhatsApp ya clasificados usan <button type="button" className="studio-inline-link" onClick={onNavigateCandidateSettings}>Administración &gt; Candidatos &gt; Orientación segura</button>, un mensaje operativo separado.</p></aside> : null}
      <div className="studio-chat" role="log" aria-live="polite" aria-label="Mensajes de la prueba">
        {messages.length === 0 && busy ? <div className="studio-chat__empty">Abriendo la conversación…</div> : null}
        {messages.map(message => <div key={message.id} className={`studio-bubble studio-bubble--${message.role}`}><span className="sr-only">{message.role === 'user' ? 'Tú' : message.role === 'bot' ? 'Bot' : 'Error'}: </span>{message.text}</div>)}
        {busy && messages.length > 0 ? <div className="studio-bubble studio-bubble--bot"><span className="sr-only">Bot: </span>Buscando la siguiente respuesta…</div> : null}
        {error ? <div className="studio-simulation-error" role="alert">{error}{pending ? <button type="button" onClick={onRetry} disabled={busy}>Reintentar respuesta</button> : null}</div> : null}
      </div>
      <form onSubmit={submit}><label className="sr-only" htmlFor="studio-simulator-input">Mensaje de prueba</label><input id="studio-simulator-input" value={input} onChange={event => setInput(event.target.value)} disabled={busy || !!pending} placeholder={pending ? 'Reintenta la respuesta pendiente antes de continuar' : 'Responde como lo haría una persona…'} /><button aria-label="Enviar al simulador" disabled={busy || !!pending || !input.trim()}><Send size={18} /></button></form>
    </section>
  );
}
