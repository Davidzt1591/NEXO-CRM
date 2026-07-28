export function toCasePulseClock(sla, type) {
  const value = sla?.[type];
  if (!value) return { state: 'unconfigured' };
  return { state: value.state || value.status || 'unconfigured', display: Number.isFinite(value.minutes_remaining) ? `${Math.max(0, Math.ceil(value.minutes_remaining))} min` : undefined };
}
