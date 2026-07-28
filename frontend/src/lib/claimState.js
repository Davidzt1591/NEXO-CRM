export function applyClaimFailure(previous, { ticketId, correlationId, message }) {
  const key = String(ticketId ?? correlationId ?? '');
  return key && previous[key] === 'pending'
    ? { ...previous, [key]: `error:${message || 'El ticket ya no está disponible.'}` }
    : previous;
}
