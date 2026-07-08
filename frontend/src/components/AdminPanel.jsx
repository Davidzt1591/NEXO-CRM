import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Building2,
  Check,
  CircleDot,
  Clock,
  LogOut,
  RefreshCw,
  Save,
  ShieldCheck,
  UserCog,
  Users,
} from 'lucide-react';
import { apiRequest, jsonBody } from '../lib/apiClient';

const DEFAULT_SLA_MINUTES = 30;
const ADMIN_REFRESH_INTERVAL_MS = 30000;

const EMPTY_AREA_FORM = {
  id: null,
  name: '',
  description: '',
  welcome_msg: '',
  sla_minutes: DEFAULT_SLA_MINUTES,
  active: true,
};

const EMPTY_ANALYST_FORM = {
  id: null,
  display_name: '',
  token_id: '',
  area_id: '',
  available: false,
};

function formatDate(value) {
  if (!value) return 'Never';
  return new Date(value).toLocaleString('es-CO', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function normalizeId(value) {
  if (value === '' || value === null || value === undefined) return null;
  return Number(value);
}

function normalizeAreaPayload(form) {
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    welcome_msg: form.welcome_msg.trim() || null,
    sla_minutes: Number(form.sla_minutes) || DEFAULT_SLA_MINUTES,
    active: !!form.active,
  };
}

function normalizeAnalystPayload(form) {
  return {
    display_name: form.display_name.trim(),
    token_id: normalizeId(form.token_id),
    area_id: normalizeId(form.area_id),
    available: !!form.available,
  };
}

function AdminStat({ icon, label, value, tone = 'cyan' }) {
  const StatIcon = icon;
  return (
    <div className={`admin-stat admin-stat--${tone}`}>
      <div className="admin-stat__icon"><StatIcon size={18} /></div>
      <div>
        <p className="admin-stat__value">{value}</p>
        <p className="admin-stat__label">{label}</p>
      </div>
    </div>
  );
}

function AdminAlert({ type = 'info', children }) {
  return (
    <div className={`admin-alert admin-alert--${type}`}>
      <AlertTriangle size={16} />
      <span>{children}</span>
    </div>
  );
}

export default function AdminPanel({ socket, onLogout }) {
  const [areas, setAreas] = useState([]);
  const [analysts, setAnalysts] = useState([]);
  const [areaForm, setAreaForm] = useState(EMPTY_AREA_FORM);
  const [analystForm, setAnalystForm] = useState(EMPTY_ANALYST_FORM);
  const [loading, setLoading] = useState(true);
  const [savingArea, setSavingArea] = useState(false);
  const [savingAnalyst, setSavingAnalyst] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [forbidden, setForbidden] = useState(false);
  const [lastRefresh, setLastRefresh] = useState(null);

  const loadAdminData = useCallback(async ({ backgroundRefresh = false } = {}) => {
    if (!backgroundRefresh) setLoading(true);
    setError(null);

    try {
      const [nextAreas, nextAnalysts] = await Promise.all([
        apiRequest('/api/admin/areas'),
        apiRequest('/api/admin/analysts'),
      ]);

      setAreas(Array.isArray(nextAreas) ? nextAreas : []);
      setAnalysts(Array.isArray(nextAnalysts) ? nextAnalysts : []);
      setForbidden(false);
      setLastRefresh(new Date());
    } catch (err) {
      if (err.status === 403) setForbidden(true);
      setError(err.message || 'Admin data could not be loaded.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAdminData();
  }, [loadAdminData]);

  useEffect(() => {
    const interval = window.setInterval(() => loadAdminData({ backgroundRefresh: true }), ADMIN_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, [loadAdminData]);

  useEffect(() => {
    if (!socket) return undefined;

    const refreshPresence = () => loadAdminData({ backgroundRefresh: true });
    socket.on('connect', refreshPresence);
    socket.on('disconnect', refreshPresence);
    socket.on('analyst-presence', refreshPresence);
    socket.on('analyst-updated', refreshPresence);

    return () => {
      socket.off('connect', refreshPresence);
      socket.off('disconnect', refreshPresence);
      socket.off('analyst-presence', refreshPresence);
      socket.off('analyst-updated', refreshPresence);
    };
  }, [loadAdminData, socket]);

  const activeAreas = useMemo(() => areas.filter(area => area.active !== false), [areas]);
  const availableAnalysts = useMemo(() => analysts.filter(analyst => analyst.available), [analysts]);
  const unassignedAnalysts = useMemo(() => analysts.filter(analyst => !analyst.area_id), [analysts]);

  const resetAreaForm = () => setAreaForm(EMPTY_AREA_FORM);
  const resetAnalystForm = () => setAnalystForm(EMPTY_ANALYST_FORM);

  const editArea = (area) => {
    setAreaForm({
      id: area.id,
      name: area.name || '',
      description: area.description || '',
      welcome_msg: area.welcome_msg || '',
      sla_minutes: area.sla_minutes || DEFAULT_SLA_MINUTES,
      active: area.active !== false,
    });
  };

  const editAnalyst = (analyst) => {
    setAnalystForm({
      id: analyst.id,
      display_name: analyst.display_name || '',
      token_id: analyst.token_id || '',
      area_id: analyst.area_id || '',
      available: !!analyst.available,
    });
  };

  const submitArea = async (event) => {
    event.preventDefault();
    if (!areaForm.name.trim()) return;

    setSavingArea(true);
    setError(null);
    setNotice(null);

    try {
      const payload = normalizeAreaPayload(areaForm);
      if (areaForm.id) {
        await apiRequest(`/api/admin/areas/${areaForm.id}`, {
          method: 'PATCH',
          body: jsonBody(payload),
        });
        setNotice('Area updated.');
      } else {
        await apiRequest('/api/admin/areas', {
          method: 'POST',
          body: jsonBody(payload),
        });
        setNotice('Area created.');
      }

      resetAreaForm();
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'Area could not be saved.');
    } finally {
      setSavingArea(false);
    }
  };

  const submitAnalyst = async (event) => {
    event.preventDefault();
    if (!analystForm.display_name.trim()) return;

    setSavingAnalyst(true);
    setError(null);
    setNotice(null);

    try {
      const payload = normalizeAnalystPayload(analystForm);
      if (analystForm.id) {
        await apiRequest(`/api/admin/analysts/${analystForm.id}`, {
          method: 'PATCH',
          body: jsonBody(payload),
        });
        setNotice('Analyst updated.');
      } else {
        await apiRequest('/api/admin/analysts', {
          method: 'POST',
          body: jsonBody(payload),
        });
        setNotice('Analyst created.');
      }

      resetAnalystForm();
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'Analyst could not be saved.');
    } finally {
      setSavingAnalyst(false);
    }
  };

  const toggleAnalystAvailability = async (analyst) => {
    setError(null);
    setNotice(null);

    try {
      await apiRequest(`/api/admin/analysts/${analyst.id}`, {
        method: 'PATCH',
        body: jsonBody({ available: !analyst.available }),
      });
      setNotice(`${analyst.display_name} marked ${analyst.available ? 'unavailable' : 'available'}.`);
      await loadAdminData({ backgroundRefresh: true });
    } catch (err) {
      setError(err.message || 'Availability could not be changed.');
    }
  };

  if (forbidden) {
    return (
      <div className="admin-shell admin-shell--centered">
        <section className="admin-denied-card">
          <div className="admin-denied-card__icon"><ShieldCheck size={34} /></div>
          <p className="admin-kicker">Restricted route</p>
          <h1>Admin access required</h1>
          <p>This token is valid for the analyst dashboard, but it cannot access the administration panel.</p>
          <div className="admin-denied-card__actions">
            <a className="admin-link-btn" href="/">Back to dashboard</a>
            <button className="admin-link-btn admin-link-btn--danger" onClick={onLogout}>Log out</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div className="admin-shell">
      <header className="admin-topbar">
        <div className="admin-topbar__brand">
          <div className="topbar__logo">N</div>
          <div>
            <p className="admin-kicker">NEXO command layer</p>
            <h1>Admin Panel</h1>
          </div>
        </div>
        <div className="admin-topbar__actions">
          <span className="admin-refresh-stamp">
            <Clock size={14} /> {lastRefresh ? `Updated ${formatDate(lastRefresh)}` : 'Waiting for data'}
          </span>
          <button className="action-btn action-btn--glass" onClick={() => loadAdminData()} disabled={loading}>
            <RefreshCw size={16} className={loading ? 'admin-spin' : ''} /> Refresh
          </button>
          <a className="action-btn action-btn--glass" href="/">Dashboard</a>
          <button className="action-btn action-btn--secondary" onClick={onLogout}>
            <LogOut size={16} /> Log out
          </button>
        </div>
      </header>

      <main className="admin-workspace">
        <section className="admin-hero-card">
          <div>
            <p className="admin-kicker">Operations topology</p>
            <h2>Areas, analysts and availability in one control surface.</h2>
            <p>
              This panel uses the authenticated admin API and refreshes analyst state safely while the backend presence contract matures.
            </p>
          </div>
          <div className="admin-stat-grid">
            <AdminStat icon={Building2} label="Active areas" value={activeAreas.length} />
            <AdminStat icon={Users} label="Analysts" value={analysts.length} tone="purple" />
            <AdminStat icon={Activity} label="Available" value={availableAnalysts.length} tone="green" />
            <AdminStat icon={AlertTriangle} label="Unassigned" value={unassignedAnalysts.length} tone="amber" />
          </div>
        </section>

        {error && <AdminAlert type="error">{error}</AdminAlert>}
        {notice && <AdminAlert type="success">{notice}</AdminAlert>}
        <AdminAlert>
          Presence is refreshed every {ADMIN_REFRESH_INTERVAL_MS / 1000} seconds and on socket reconnect. No unsupported realtime event contract is assumed.
        </AdminAlert>

        <div className="admin-grid">
          <section className="admin-card admin-card--form">
            <div className="admin-section-heading">
              <div>
                <p className="admin-kicker">Support areas</p>
                <h3>{areaForm.id ? 'Edit area' : 'Create area'}</h3>
              </div>
              {areaForm.id && <button className="admin-soft-btn" onClick={resetAreaForm}>New area</button>}
            </div>

            <form className="admin-form" onSubmit={submitArea}>
              <label>
                <span>Name</span>
                <input value={areaForm.name} onChange={e => setAreaForm(prev => ({ ...prev, name: e.target.value }))} placeholder="Integrations support" />
              </label>
              <label>
                <span>Description</span>
                <input value={areaForm.description} onChange={e => setAreaForm(prev => ({ ...prev, description: e.target.value }))} placeholder="Scope and ownership" />
              </label>
              <label>
                <span>Welcome message</span>
                <textarea value={areaForm.welcome_msg} onChange={e => setAreaForm(prev => ({ ...prev, welcome_msg: e.target.value }))} rows={4} placeholder="Message used when an area receives a conversation" />
              </label>
              <div className="admin-form__row">
                <label>
                  <span>SLA minutes</span>
                  <input type="number" min="1" value={areaForm.sla_minutes} onChange={e => setAreaForm(prev => ({ ...prev, sla_minutes: e.target.value }))} />
                </label>
                <label className="admin-check-row">
                  <input type="checkbox" checked={areaForm.active} onChange={e => setAreaForm(prev => ({ ...prev, active: e.target.checked }))} />
                  <span>Active</span>
                </label>
              </div>
              <button className="admin-primary-btn" disabled={savingArea || !areaForm.name.trim()}>
                <Save size={16} /> {savingArea ? 'Saving...' : areaForm.id ? 'Update area' : 'Create area'}
              </button>
            </form>
          </section>

          <section className="admin-card admin-card--list">
            <div className="admin-section-heading">
              <div>
                <p className="admin-kicker">Routing map</p>
                <h3>Areas</h3>
              </div>
              {loading && <div className="qr-loading__spinner admin-mini-spinner" />}
            </div>

            <div className="admin-list">
              {areas.length === 0 && !loading ? <p className="admin-empty">No areas configured yet.</p> : null}
              {areas.map(area => (
                <article key={area.id} className={`admin-list-item ${area.active === false ? 'admin-list-item--muted' : ''}`}>
                  <div>
                    <div className="admin-list-item__title-row">
                      <h4>{area.name}</h4>
                      <span className={`admin-pill ${area.active === false ? 'admin-pill--muted' : 'admin-pill--green'}`}>
                        {area.active === false ? 'Inactive' : 'Active'}
                      </span>
                    </div>
                    <p>{area.description || 'No description yet.'}</p>
                    <div className="admin-meta-row">
                      <span><Clock size={13} /> SLA {area.sla_minutes || DEFAULT_SLA_MINUTES}m</span>
                      <span>{analysts.filter(analyst => String(analyst.area_id) === String(area.id)).length} analysts</span>
                    </div>
                  </div>
                  <button className="admin-soft-btn" onClick={() => editArea(area)}>Edit</button>
                </article>
              ))}
            </div>
          </section>

          <section className="admin-card admin-card--form">
            <div className="admin-section-heading">
              <div>
                <p className="admin-kicker">Analyst roster</p>
                <h3>{analystForm.id ? 'Edit analyst' : 'Create analyst'}</h3>
              </div>
              {analystForm.id && <button className="admin-soft-btn" onClick={resetAnalystForm}>New analyst</button>}
            </div>

            <form className="admin-form" onSubmit={submitAnalyst}>
              <label>
                <span>Display name</span>
                <input value={analystForm.display_name} onChange={e => setAnalystForm(prev => ({ ...prev, display_name: e.target.value }))} placeholder="Analyst name" />
              </label>
              <div className="admin-form__row">
                <label>
                  <span>Token ID</span>
                  <input type="number" min="1" value={analystForm.token_id} onChange={e => setAnalystForm(prev => ({ ...prev, token_id: e.target.value }))} placeholder="dashboard_tokens.id" />
                </label>
                <label>
                  <span>Area</span>
                  <select value={analystForm.area_id} onChange={e => setAnalystForm(prev => ({ ...prev, area_id: e.target.value }))}>
                    <option value="">Unassigned</option>
                    {areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}
                  </select>
                </label>
              </div>
              <label className="admin-check-row">
                <input type="checkbox" checked={analystForm.available} onChange={e => setAnalystForm(prev => ({ ...prev, available: e.target.checked }))} />
                <span>Available for routing</span>
              </label>
              <button className="admin-primary-btn" disabled={savingAnalyst || !analystForm.display_name.trim()}>
                <UserCog size={16} /> {savingAnalyst ? 'Saving...' : analystForm.id ? 'Update analyst' : 'Create analyst'}
              </button>
            </form>
          </section>

          <section className="admin-card admin-card--list admin-card--wide">
            <div className="admin-section-heading">
              <div>
                <p className="admin-kicker">Presence board</p>
                <h3>Analysts</h3>
              </div>
              {socket?.connected ? <span className="admin-pill admin-pill--green"><CircleDot size={12} /> Socket online</span> : <span className="admin-pill admin-pill--muted">Socket offline</span>}
            </div>

            <div className="admin-table-wrap">
              <table className="admin-table">
                <thead>
                  <tr>
                    <th>Analyst</th>
                    <th>Area</th>
                    <th>Token</th>
                    <th>Availability</th>
                    <th>Last seen</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {analysts.length === 0 && !loading ? (
                    <tr><td colSpan="6" className="admin-empty">No analysts configured yet.</td></tr>
                  ) : analysts.map(analyst => (
                    <tr key={analyst.id}>
                      <td>
                        <div className="admin-identity-cell">
                          <div className="admin-avatar">{analyst.display_name?.slice(0, 2).toUpperCase() || 'AN'}</div>
                          <div>
                            <strong>{analyst.display_name}</strong>
                            <span>#{analyst.id}</span>
                          </div>
                        </div>
                      </td>
                      <td>{analyst.area?.name || 'Unassigned'}</td>
                      <td>{analyst.token?.name || (analyst.token_id ? `Token #${analyst.token_id}` : 'No token')}</td>
                      <td>
                        <span className={`admin-pill ${analyst.available ? 'admin-pill--green' : 'admin-pill--muted'}`}>
                          {analyst.available ? <Check size={12} /> : null} {analyst.available ? 'Available' : 'Unavailable'}
                        </span>
                      </td>
                      <td>{formatDate(analyst.last_seen)}</td>
                      <td>
                        <div className="admin-row-actions">
                          <button className="admin-soft-btn" onClick={() => editAnalyst(analyst)}>Edit</button>
                          <button className="admin-soft-btn" onClick={() => toggleAnalystAvailability(analyst)}>
                            {analyst.available ? 'Pause' : 'Enable'}
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </main>
    </div>
  );
}
