import { Save } from "lucide-react";
import {
  Button,
  StatusPill,
} from "../../components/design-system/NexoPrimitives";
import {
  CLOCKS,
  PRIORITIES,
  minutesLabel,
  policyKey,
} from "./slaAdminContracts";

export function PolicyMatrix({ areaId, latest, onEdit }) {
  return (
    <div className="sla-matrix-wrap">
      <table className="sla-matrix">
        <caption className="nx-sr-only">Políticas SLA del área</caption>
        <thead>
          <tr>
            <th scope="col">Prioridad</th>
            {CLOCKS.map((clock) => (
              <th scope="col" key={clock.key}>
                {clock.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {PRIORITIES.map((priority) => (
            <tr key={priority.key}>
              <th scope="row">{priority.label}</th>
              {CLOCKS.map((clock) => {
                const policy = latest.get(
                  policyKey(areaId, priority.key, clock.key),
                );
                return (
                  <td key={clock.key}>
                    <button
                      type="button"
                      className="sla-policy-cell"
                      onClick={() => onEdit(policy, priority.key, clock.key)}
                    >
                      <StatusPill tone={policy ? "success" : "warning"}>
                        {policy ? `v${policy.version}` : "SLA no configurado"}
                      </StatusPill>
                      <span>
                        {policy
                          ? `${minutesLabel(policy.target_minutes)} · aviso ${minutesLabel(policy.warning_minutes)}`
                          : "Crear política"}
                      </span>
                    </button>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function PolicyEditor({ draft, calendars, onChange, onSubmit }) {
  const configured =
    draft.target_minutes !== "" && draft.warning_minutes !== "";
  return (
    <form className="sla-editor" onSubmit={onSubmit}>
      <h4>Borrador de política</h4>
      <div className="sla-form-grid">
        <label className="sla-field">
          <span>Prioridad</span>
          <select
            value={draft.priority}
            onChange={(event) => onChange({ priority: event.target.value })}
          >
            {PRIORITIES.map((item) => (
              <option value={item.key} key={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sla-field">
          <span>Reloj</span>
          <select
            value={draft.clock_type}
            onChange={(event) => onChange({ clock_type: event.target.value })}
          >
            {CLOCKS.map((item) => (
              <option value={item.key} key={item.key}>
                {item.label}
              </option>
            ))}
          </select>
        </label>
        <label className="sla-field">
          <span>Modo</span>
          <select
            value={draft.clock_mode}
            onChange={(event) =>
              onChange({
                clock_mode: event.target.value,
                calendar_id:
                  event.target.value === "24x7" ? "" : draft.calendar_id,
              })
            }
          >
            <option value="business_hours">Horario hábil</option>
            <option value="24x7">24 × 7</option>
          </select>
        </label>
        {draft.clock_mode === "business_hours" ? (
          <label className="sla-field">
            <span>Calendario</span>
            <select
              required
              value={draft.calendar_id}
              onChange={(event) =>
                onChange({ calendar_id: event.target.value })
              }
            >
              <option value="">Selecciona…</option>
              {calendars.map((item) => (
                <option value={item.id} key={item.id}>
                  {item.name} · v{item.version}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <label className="sla-field">
          <span>Objetivo (min)</span>
          <input
            type="number"
            min="1"
            value={draft.target_minutes}
            onChange={(event) =>
              onChange({ target_minutes: event.target.value })
            }
          />
        </label>
        <label className="sla-field">
          <span>Aviso (min)</span>
          <input
            type="number"
            min="0"
            value={draft.warning_minutes}
            onChange={(event) =>
              onChange({ warning_minutes: event.target.value })
            }
          />
        </label>
      </div>
      <aside
        className="sla-draft-preview"
        aria-label="Vista previa inactiva del borrador"
      >
        <span>Vista previa del borrador · No activa</span>
        <strong>
          {CLOCKS.find((item) => item.key === draft.clock_type)?.label}
        </strong>
        {configured ? (
          <dl>
            <div>
              <dt>Objetivo</dt>
              <dd>{minutesLabel(draft.target_minutes)}</dd>
            </div>
            <div>
              <dt>Umbral de aviso</dt>
              <dd>
                {minutesLabel(draft.warning_minutes)} antes del vencimiento
              </dd>
            </div>
          </dl>
        ) : (
          <p>
            <strong>SLA no configurado.</strong> Define objetivo y aviso para
            guardar.
          </p>
        )}
        <p>No representa una cuenta regresiva ni una fecha límite real.</p>
      </aside>
      <Button variant="primary" type="submit">
        <Save /> Revisar y guardar
      </Button>
    </form>
  );
}

export { default as CalendarEditor } from "./CalendarEditor";
