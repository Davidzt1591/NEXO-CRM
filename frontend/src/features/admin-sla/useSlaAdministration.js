import { useCallback, useEffect, useRef, useState } from 'react';
import { apiRequest, jsonBody } from '../../lib/apiClient';
import { adminSlaError } from './slaAdminContracts';

export function useSlaAdministration() {
  const [data, setData] = useState({ policies: [], calendars: [] });
  const [state, setState] = useState({ loading: true, pending: false, error: '', notice: '' });
  const abortRef = useRef(null);
  const load = useCallback(async () => {
    abortRef.current?.abort(); const controller = new AbortController(); abortRef.current = controller;
    setState(current => ({ ...current, loading: true, error: '' }));
    try { const [policyResult, calendarResult] = await Promise.all([apiRequest('/api/admin/sla/policies', { signal: controller.signal }), apiRequest('/api/admin/sla/calendars', { signal: controller.signal })]); if (controller.signal.aborted) return; setData({ policies: policyResult?.policies || [], calendars: calendarResult?.calendars || [] }); setState(current => ({ ...current, loading: false })); } catch (error) { if (error.name !== 'AbortError') setState(current => ({ ...current, loading: false, error: adminSlaError(error) })); }
  }, []);
  useEffect(() => { load(); return () => abortRef.current?.abort(); }, [load]);
  const save = useCallback(async (path, payload, success) => {
    setState({ loading: false, pending: true, error: '', notice: '' });
    try { await apiRequest(path, { method: 'POST', body: jsonBody(payload) }); await load(); setState({ loading: false, pending: false, error: '', notice: success }); return true; } catch (error) { if (error.status === 409) await load(); setState({ loading: false, pending: false, error: adminSlaError(error), notice: '' }); return false; }
  }, [load]);
  return { ...data, state, reload: load, savePolicy: payload => save('/api/admin/sla/policies', payload, 'Nueva versión de política creada.'), saveCalendar: payload => save('/api/admin/sla/calendars', payload, 'Nueva versión de calendario creada.') };
}
