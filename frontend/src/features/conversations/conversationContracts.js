export const CONVERSATION_STATES = Object.freeze(['new', 'in_progress', 'waiting', 'closed']);
export const STATE_LABELS = Object.freeze({ new: 'Nuevos', in_progress: 'En gestión', waiting: 'En espera', closed: 'Cerrados' });
export const WAITING_REASONS = Object.freeze({ customer_response: 'Respuesta del cliente', internal_information: 'Información interna', development_escalation: 'Escalamiento a Desarrollo', special_situation: 'Situación especial' });
export const DEVELOPMENT_LABELS = Object.freeze({ requested: 'Solicitado', in_progress: 'En trabajo', resolved: 'Solucionado', cancelled: 'Cancelado' });

const LEGAL_TRANSITIONS = Object.freeze({ new: [], in_progress: ['waiting', 'closed'], waiting: ['in_progress', 'closed'], closed: [] });
const DEVELOPMENT_TRANSITIONS = Object.freeze({ requested: ['in_progress', 'cancelled'], in_progress: ['resolved', 'cancelled'], resolved: [], cancelled: [] });

export function conversationState(ticket) {
  return CONVERSATION_STATES.includes(ticket?.conversation_state) ? ticket.conversation_state : ticket?.status === 'closed' ? 'closed' : 'new';
}

export function legalTargets(ticket) {
  return LEGAL_TRANSITIONS[conversationState(ticket)] || [];
}

export function canTransition(ticket, target) {
  return legalTargets(ticket).includes(target);
}

export function canUpdateDevelopment(escalation, target) {
  return (DEVELOPMENT_TRANSITIONS[escalation?.status] || []).includes(target);
}

export function makeIdempotencyKey(prefix = 'workflow') {
  const random = globalThis.crypto?.randomUUID?.();
  if (!random) throw new Error('Tu navegador no puede generar una clave segura para esta operación.');
  return `${prefix}_${random.replaceAll('-', '_')}`;
}

export function displayPriority(ticket) {
  return ({ critical: 'Crítica', high: 'Alta', medium: 'Media', low: 'Baja' })[ticket?.priority_normalized] || ticket?.prioridad || 'Media';
}

export function safeBoardTicket(ticket) {
  if (!ticket?.queue_card) return ticket;
  return {
    id: ticket.id, area_id: ticket.area_id, categoria: ticket.categoria,
    prioridad: ticket.prioridad, priority_normalized: ticket.priority_normalized,
    status: ticket.status, conversation_state: ticket.conversation_state,
    workflow_revision: ticket.workflow_revision, created_at: ticket.created_at,
    closed_at: ticket.closed_at, sla: ticket.sla, assignment: ticket.assignment,
    queue_card: true,
  };
}

export function workflowErrorCopy(error) {
  if (error?.status === 409) return 'El caso cambió en otra sesión. Actualizamos sus datos; revisa el estado antes de intentarlo de nuevo.';
  if (error?.status === 403) return 'No tienes permisos para realizar esta acción en el caso.';
  if (error?.status === 503) return 'El flujo no está disponible temporalmente. Intenta de nuevo más tarde.';
  return 'No pudimos actualizar el caso. Revisa los datos e inténtalo nuevamente.';
}
