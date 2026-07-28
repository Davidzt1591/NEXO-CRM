import { CheckCircle2, ChevronRight, Clock3, Code2, PauseCircle, PlayCircle } from 'lucide-react';
import { useState } from 'react';
import { Button, CasePulse, FeedbackState } from '../../components/design-system/NexoPrimitives';
import AccessibleDialog from '../../components/design-system/AccessibleDialog';
import { DEVELOPMENT_LABELS, WAITING_REASONS, canUpdateDevelopment, conversationState, displayPriority } from './conversationContracts';
import { toCasePulseClock } from './slaClockAdapter';

const clock = toCasePulseClock;

function WorkflowDialog({ dialog, onClose, onConfirm }) {
  const [value, setValue] = useState(dialog.type === 'waiting' ? 'customer_response' : '');
  const title = dialog.type === 'waiting' ? 'Poner en espera' : dialog.type === 'development' ? 'Escalar a Desarrollo' : 'Cerrar conversación';
  return <AccessibleDialog title={title} onClose={onClose} footer={<><Button variant="secondary" onClick={onClose}>Cancelar</Button><Button variant="technology" disabled={dialog.type === 'development' && !value.trim()} onClick={() => onConfirm(value)}>Confirmar</Button></>}>{dialog.type === 'waiting' ? <label>Motivo<select value={value} onChange={event => setValue(event.target.value)}>{Object.entries(WAITING_REASONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label> : dialog.type === 'development' ? <label>Resumen interno<textarea value={value} maxLength={4000} required onChange={event => setValue(event.target.value)} placeholder="Describe impacto, contexto y evidencia disponible. No se enviará a WhatsApp." /></label> : <p>La conversación quedará cerrada y no podrá reabrirse desde este flujo.</p>}</AccessibleDialog>;
}

export default function ConversationWorkspace({ controller, principal }) {
  const { workflow, state, transition, escalate, updateEscalation } = controller;
  const [dialog, setDialog] = useState(null);
  if (!workflow?.id || workflow.queue_card) return null;
  const current = conversationState(workflow);
  const escalation = workflow.development_escalations?.[0] || null;
  const canUpdate = principal?.user?.role === 'admin' || String(workflow.assignment?.analyst_id) === String(principal?.analyst?.id);
  const closeDialog = () => setDialog(null);
  const openDialog = (_event, type) => setDialog({ type });
  const confirm = async value => {
    const type = dialog.type; closeDialog();
    if (type === 'waiting') await transition('waiting', value);
    if (type === 'development') await escalate(value.trim());
    if (type === 'close') await transition('closed');
  };
  return <section className="nx-workflow" aria-label="Flujo de la conversación"><CasePulse state={({ new: 'Nuevo', in_progress: 'En gestión', waiting: 'En espera', closed: 'Cerrado' })[current]} area={workflow.area?.name || (workflow.area_id ? `Área ${workflow.area_id}` : 'Sin área')} priority={displayPriority(workflow)} assignee={workflow.assignment?.analyst?.display_name || 'Sin asignar'} supportSla={clock(workflow.sla, 'support')} developmentSla={clock(workflow.sla, 'development')} />{state.error ? <FeedbackState type="error" title="No se pudo actualizar" message={state.error} /> : null}<div className="nx-workflow__actions">{current === 'waiting' ? <Button loading={state.pending === 'transition:in_progress'} onClick={() => transition('in_progress')}><PlayCircle /> En gestión</Button> : null}{current === 'in_progress' ? <><Button loading={state.pending === 'transition:waiting'} onClick={event => openDialog(event, 'waiting')}><PauseCircle /> Poner en espera</Button>{!escalation || ['resolved', 'cancelled'].includes(escalation.status) ? <Button variant="technology" loading={state.pending === 'development:requested'} onClick={event => openDialog(event, 'development')}><Code2 /> Escalar a Desarrollo</Button> : null}</> : null}{current !== 'closed' ? <Button loading={state.pending === 'transition:closed'} onClick={event => openDialog(event, 'close')}><CheckCircle2 /> Cerrar</Button> : null}</div>{escalation ? <section className="nx-development" aria-label="Escalamiento interno a Desarrollo"><header><div><span>Canal interno · no se envía a WhatsApp</span><h3>Desarrollo</h3></div><strong>{DEVELOPMENT_LABELS[escalation.status]}</strong></header><ol>{['requested', 'in_progress', escalation.status === 'cancelled' ? 'cancelled' : 'resolved'].map((step, index) => <li className={step === escalation.status ? 'is-current' : ''} key={step}><span>{index + 1}</span>{DEVELOPMENT_LABELS[step]}{index < 2 ? <ChevronRight /> : null}</li>)}</ol>{escalation.note ? <aside aria-label="Nota interna"><strong>Nota interna</strong><p>{escalation.note}</p></aside> : null}{canUpdate ? <div className="nx-development__actions">{canUpdateDevelopment(escalation, 'in_progress') ? <Button onClick={() => updateEscalation('in_progress')}>Iniciar trabajo</Button> : null}{canUpdateDevelopment(escalation, 'resolved') ? <Button variant="technology" onClick={() => updateEscalation('resolved')}>Marcar solucionado</Button> : null}{canUpdateDevelopment(escalation, 'cancelled') ? <Button onClick={() => updateEscalation('cancelled')}>Cancelar</Button> : null}</div> : null}<p className="nx-development__explanation"><Clock3 /> El SLA de soporte se pausa durante Desarrollo y luego continúa con el tiempo restante. El SLA de Desarrollo es independiente.</p></section> : null}{dialog ? <WorkflowDialog dialog={dialog} onClose={closeDialog} onConfirm={confirm} /> : null}</section>;
}
