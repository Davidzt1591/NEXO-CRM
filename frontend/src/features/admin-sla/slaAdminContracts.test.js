import { describe, expect, it } from 'vitest';
import { calendarDraftToRequest, latestPolicies, validateCalendarDraft, windowsOverlap } from './slaAdminContracts';

describe('SLA administration contracts', () => {
  it('keeps the newest policy version for each area, priority and clock', () => {
    const result = latestPolicies([{ id: 1, area_id: 2, priority: 'high', clock_type: 'support', version: 1 }, { id: 2, area_id: 2, priority: 'high', clock_type: 'support', version: 3 }, { id: 3, area_id: 2, priority: 'high', clock_type: 'development', version: 1 }]);
    expect(result.get('2:high:support').id).toBe(2);
    expect(result.get('2:high:development').id).toBe(3);
  });

  it('supports overnight windows and detects overlap on both sides of midnight', () => {
    const overnight = { weekday: 1, starts_at: '22:00', ends_at: '02:00' };
    expect(windowsOverlap(overnight, { weekday: 1, starts_at: '23:00', ends_at: '23:30' })).toBe(true);
    expect(windowsOverlap(overnight, { weekday: 2, starts_at: '01:00', ends_at: '03:00' })).toBe(true);
    expect(windowsOverlap(overnight, { weekday: 1, starts_at: '08:00', ends_at: '17:00' })).toBe(false);
  });

  it('rejects overlapping windows, invalid timezones and duplicate exceptions', () => {
    const errors = validateCalendarDraft({ name: 'Bogotá', timezone: 'Not/AZone', mode: 'business_hours', windows: [{ weekday: 1, starts_at: '08:00', ends_at: '17:00' }, { weekday: 1, starts_at: '12:00', ends_at: '18:00' }], exceptions: [{ exception_date: '2026-12-25', closed: true }, { exception_date: '2026-12-25', closed: true }] });
    expect(errors.join(' ')).toMatch(/zona horaria/i);
    expect(errors.join(' ')).toMatch(/superponen/i);
    expect(errors.join(' ')).toMatch(/repetida/i);
  });

  it('accepts 24x7 calendars without windows', () => {
    expect(validateCalendarDraft({ name: 'Siempre', timezone: 'America/Bogota', mode: '24x7', windows: [], exceptions: [] })).toEqual([]);
  });

  it('adapts realistic form state to the exact Phase11 RPC request contract', () => {
    expect(calendarDraftToRequest({ area_id: '7', name: '  Bogotá nocturno ', timezone: 'America/Bogota', mode: 'business_hours', windows: [{ weekday: '1', starts_at: '22:00', ends_at: '02:00' }], exceptions: [{ exception_date: '2026-12-25', closed: true, windows: [] }, { exception_date: '2026-12-31', closed: false, windows: [{ starts_at: '08:00', ends_at: '12:00' }] }] })).toEqual({ area_id: 7, name: 'Bogotá nocturno', timezone: 'America/Bogota', windows: [{ weekday: 1, start: '22:00', end: '02:00' }], exceptions: [{ date: '2026-12-25', closed: true, windows: null }, { date: '2026-12-31', closed: false, windows: [{ start: '08:00', end: '12:00' }] }] });
  });

  it('rejects empty and overlapping replacement windows for open exceptions', () => {
    expect(validateCalendarDraft({ name: 'X', timezone: 'America/Bogota', mode: '24x7', exceptions: [{ exception_date: '2026-12-31', closed: false, windows: [] }] }).join(' ')).toMatch(/al menos una/i);
    expect(validateCalendarDraft({ name: 'X', timezone: 'America/Bogota', mode: '24x7', exceptions: [{ exception_date: '2026-12-31', closed: false, windows: [{ starts_at: '22:00', ends_at: '02:00' }, { starts_at: '01:00', ends_at: '03:00' }] }] }).join(' ')).toMatch(/superponen/i);
  });
});
