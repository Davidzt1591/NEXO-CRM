export const PRIORITIES = Object.freeze([{ key: 'critical', label: 'Crítica' }, { key: 'high', label: 'Alta' }, { key: 'medium', label: 'Media' }, { key: 'low', label: 'Baja' }]);
export const CLOCKS = Object.freeze([{ key: 'support', label: 'Soporte' }, { key: 'development', label: 'Desarrollo' }]);
export const WEEKDAYS = Object.freeze(['Domingo', 'Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado']);

// Control selections only: these are not persisted policy values.
export const POLICY_DRAFT_SELECTIONS = Object.freeze({ priority: 'critical', clock_type: 'support', clock_mode: 'business_hours' });
export const EMPTY_POLICY_DRAFT = Object.freeze({ area_id: '', ...POLICY_DRAFT_SELECTIONS, calendar_id: '', target_minutes: '', warning_minutes: '' });
export const EMPTY_CALENDAR_DRAFT = Object.freeze({ area_id: '', name: '', timezone: 'America/Bogota', mode: 'business_hours', windows: Object.freeze([]), exceptions: Object.freeze([]) });
export const EMPTY_WINDOW_DRAFT = Object.freeze({ weekday: 1, starts_at: '', ends_at: '' });
export const minutesLabel = value => `${Math.floor(Number(value) / 60)}h ${Number(value) % 60}m`;

function minutes(value) { const [hour, minute] = String(value || '').split(':').map(Number); return Number.isInteger(hour) && Number.isInteger(minute) ? hour * 60 + minute : NaN; }
function timeWindowOverlap(a, b) { const range = window => { const start = minutes(window.starts_at); let end = minutes(window.ends_at); if (end <= start) end += 1440; return [start, end]; }; const [as, ae] = range(a); const [bs, be] = range(b); return [-1440, 0, 1440].some(shift => as < be + shift && bs + shift < ae); }
export function windowsOverlap(a, b) {
  const range = window => { const start = Number(window.weekday) * 1440 + minutes(window.starts_at); let end = Number(window.weekday) * 1440 + minutes(window.ends_at); if (end <= start) end += 1440; return [start, end]; };
  const [as, ae] = range(a); const [bs, be] = range(b);
  return [-10080, 0, 10080].some(shift => as < be + shift && bs + shift < ae);
}
export function validateCalendarDraft(draft) {
  const errors = [];
  if (!draft.name?.trim()) errors.push('El nombre es obligatorio.');
  try { new Intl.DateTimeFormat('en', { timeZone: draft.timezone }).format(); } catch { errors.push('La zona horaria debe ser IANA válida.'); }
  const windows = draft.mode === '24x7' ? [] : draft.windows || [];
  if (draft.mode === 'business_hours' && windows.length === 0) errors.push('Añade al menos una franja para el horario hábil.');
  windows.forEach((window, index) => { if (!Number.isInteger(Number(window.weekday)) || Number(window.weekday) < 0 || Number(window.weekday) > 6 || !Number.isFinite(minutes(window.starts_at)) || !Number.isFinite(minutes(window.ends_at)) || window.starts_at === window.ends_at) errors.push(`La franja ${index + 1} no es válida.`); });
  for (let i = 0; i < windows.length; i += 1) for (let j = i + 1; j < windows.length; j += 1) if (windowsOverlap(windows[i], windows[j])) errors.push(`Las franjas ${i + 1} y ${j + 1} se superponen.`);
  const dates = new Set();
  (draft.exceptions || []).forEach((exception, index) => { if (!/^\d{4}-\d{2}-\d{2}$/.test(exception.exception_date || '') || Number.isNaN(Date.parse(`${exception.exception_date}T00:00:00Z`))) errors.push(`La excepción ${index + 1} requiere una fecha válida.`); if (dates.has(exception.exception_date)) errors.push(`La fecha ${exception.exception_date} está repetida.`); dates.add(exception.exception_date); const replacements = exception.windows || []; if (!exception.closed && replacements.length === 0) errors.push(`La excepción abierta ${index + 1} requiere al menos una franja de reemplazo.`); replacements.forEach((window, windowIndex) => { if (!Number.isFinite(minutes(window.starts_at)) || !Number.isFinite(minutes(window.ends_at)) || window.starts_at === window.ends_at) errors.push(`La franja ${windowIndex + 1} de la excepción ${index + 1} no es válida.`); }); for (let i = 0; i < replacements.length; i += 1) for (let j = i + 1; j < replacements.length; j += 1) if (timeWindowOverlap(replacements[i], replacements[j])) errors.push(`Las franjas de la excepción ${index + 1} se superponen.`); });
  return [...new Set(errors)];
}
export function validatePolicyDraft(draft) {
  const errors = [];
  const target = Number(draft.target_minutes);
  const warning = Number(draft.warning_minutes);
  if (!draft.area_id) errors.push('Selecciona un área.');
  if (draft.target_minutes === '' || draft.target_minutes == null || !Number.isFinite(target) || target <= 0) errors.push('Configura un objetivo mayor que cero.');
  if (draft.warning_minutes === '' || draft.warning_minutes == null || !Number.isFinite(warning) || warning < 0) errors.push('Configura un umbral de aviso válido.');
  if (Number.isFinite(target) && Number.isFinite(warning) && warning >= target) errors.push('El aviso debe ser menor que el objetivo.');
  if (draft.clock_mode === 'business_hours' && !draft.calendar_id) errors.push('Selecciona un calendario para horario hábil.');
  return [...new Set(errors)];
}
export function calendarDraftToRequest(draft) {
  return {
    area_id: Number(draft.area_id), name: draft.name.trim(), timezone: draft.timezone.trim(),
    windows: draft.mode === '24x7' ? [] : (draft.windows || []).map(window => ({ weekday: Number(window.weekday), start: window.starts_at, end: window.ends_at })),
    exceptions: (draft.exceptions || []).map(exception => ({ date: exception.exception_date, closed: Boolean(exception.closed), windows: exception.closed ? null : (exception.windows || []).map(window => ({ start: window.starts_at, end: window.ends_at })) })),
  };
}
export function latestPolicies(policies) {
  const result = new Map();
  for (const policy of policies || []) { const key = `${policy.area_id}:${policy.priority}:${policy.clock_type}`; const current = result.get(key); if (!current || Number(policy.version) > Number(current.version)) result.set(key, policy); }
  return result;
}
export function policyKey(areaId, priority, clock) { return `${areaId}:${priority}:${clock}`; }
export function adminSlaError(error) { if (error?.status === 409) return 'La configuración cambió en otra sesión. Recargamos los datos; revisa antes de volver a guardar.'; if (error?.status === 403) return 'Tu sesión no tiene permisos administrativos.'; return error?.message || 'No se pudo guardar la configuración SLA.'; }
