const MINUTE_MS = 60_000;

const formatterCache = new Map();

function formatter(timeZone) {
  if (!formatterCache.has(timeZone)) {
    formatterCache.set(timeZone, new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }));
  }
  return formatterCache.get(timeZone);
}

function zonedParts(value, timeZone) {
  const parts = Object.fromEntries(formatter(timeZone).formatToParts(new Date(value))
    .filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const weekdays = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    weekday: weekdays[parts.weekday],
    minute: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

function parseMinute(value) {
  if (Number.isInteger(value)) return value;
  const match = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(String(value || ''));
  if (!match) throw new TypeError(`Invalid business window time: ${value}`);
  return Number(match[1]) * 60 + Number(match[2]);
}

function windowsForDate(parts, calendar) {
  const exception = (calendar.exceptions || []).find(item => item.date === parts.date);
  if (exception?.closed) return [];
  if (exception?.windows) return exception.windows;
  return (calendar.windows || []).filter(item => Number(item.weekday) === parts.weekday);
}

function isBusinessMinute(value, calendar) {
  const timeZone = calendar.timezone || 'America/Bogota';
  const current = zonedParts(value, timeZone);
  const windows = windowsForDate(current, calendar);
  if (windows.some(window => {
    const start = parseMinute(window.start); const end = parseMinute(window.end);
    return end > start && current.minute >= start && current.minute < end;
  })) return true;

  const previous = zonedParts(new Date(value).getTime() - 24 * 60 * MINUTE_MS, timeZone);
  return windowsForDate(previous, calendar).some(window => {
    const start = parseMinute(window.start); const end = parseMinute(window.end);
    return end <= start && current.minute < end;
  });
}

function businessMilliseconds(start, end, calendar) {
  let cursor = new Date(start).getTime();
  const finish = new Date(end).getTime();
  if (!Number.isFinite(cursor) || !Number.isFinite(finish) || finish <= cursor) return 0;
  let total = 0;
  while (cursor < finish) {
    const boundary = Math.min(finish, Math.floor(cursor / MINUTE_MS) * MINUTE_MS + MINUTE_MS);
    if (isBusinessMinute(cursor, calendar)) total += boundary - cursor;
    cursor = boundary;
  }
  return total;
}

function elapsedForSegments(snapshot, segments, now = new Date()) {
  const mode = snapshot.clock_mode || 'business_hours';
  const calendar = snapshot.calendar || {};
  return (segments || []).reduce((total, segment) => {
    const start = new Date(segment.started_at);
    const end = segment.stopped_at ? new Date(segment.stopped_at) : new Date(now);
    if (end <= start) return total;
    return total + (mode === '24x7' ? end - start : businessMilliseconds(start, end, calendar));
  }, 0);
}

function computeClock(snapshot, segments, now = new Date()) {
  if (!snapshot || !Number.isFinite(Number(snapshot.target_minutes))) {
    return { status: 'unconfigured', consumed_minutes: 0, remaining_minutes: null, deadline_at: null };
  }
  const target = Number(snapshot.target_minutes);
  const consumedMs = elapsedForSegments(snapshot, segments, now);
  const consumed = consumedMs / MINUTE_MS;
  const remaining = Math.max(0, target - consumed);
  const warningAt = Number.isFinite(Number(snapshot.warning_minutes))
    ? Number(snapshot.warning_minutes) : Math.ceil(target * 0.2);
  const stopped = (segments || []).length > 0 && (segments || []).every(segment => segment.stopped_at);
  return {
    status: consumed >= target ? 'breached' : remaining <= warningAt ? 'warning' : stopped ? 'stopped' : 'ok',
    consumed_minutes: consumed,
    remaining_minutes: remaining,
    target_minutes: target,
    policy_version: snapshot.policy_version,
    clock_mode: snapshot.clock_mode || 'business_hours',
    timezone: snapshot.timezone || snapshot.calendar?.timezone || 'America/Bogota',
    deadline_at: null,
  };
}

module.exports = { businessMilliseconds, computeClock, elapsedForSegments, isBusinessMinute, zonedParts };
