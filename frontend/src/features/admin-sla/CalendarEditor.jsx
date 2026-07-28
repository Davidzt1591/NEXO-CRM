import { Plus, Save } from "lucide-react";
import { Button } from "../../components/design-system/NexoPrimitives";
import { EMPTY_WINDOW_DRAFT, WEEKDAYS } from "./slaAdminContracts";

function WindowEditor({ windows, onChange, weekly = false }) {
  const update = (index, patch) =>
    onChange(
      windows.map((window, current) =>
        current === index ? { ...window, ...patch } : window,
      ),
    );
  const emptyWindow = weekly
    ? { ...EMPTY_WINDOW_DRAFT }
    : { starts_at: "", ends_at: "" };

  return (
    <div className="sla-window-list">
      {windows.length === 0 ? (
        <p>Sin franjas. Añade el horario aprobado por el área.</p>
      ) : null}
      {windows.map((window, index) => (
        <div className="sla-window" key={index}>
          {weekly ? (
            <select
              aria-label={`Día de franja ${index + 1}`}
              value={window.weekday}
              onChange={(event) =>
                update(index, { weekday: Number(event.target.value) })
              }
            >
              {WEEKDAYS.map((day, dayIndex) => (
                <option value={dayIndex} key={day}>
                  {day}
                </option>
              ))}
            </select>
          ) : null}
          <input
            aria-label={`Inicio de franja ${index + 1}`}
            type="time"
            value={window.starts_at}
            onChange={(event) =>
              update(index, { starts_at: event.target.value })
            }
          />
          <input
            aria-label={`Fin de franja ${index + 1}`}
            type="time"
            value={window.ends_at}
            onChange={(event) => update(index, { ends_at: event.target.value })}
          />
          <button
            type="button"
            onClick={() =>
              onChange(windows.filter((_, current) => current !== index))
            }
          >
            Quitar
          </button>
        </div>
      ))}
      <Button type="button" onClick={() => onChange([...windows, emptyWindow])}>
        <Plus /> Añadir franja
      </Button>
    </div>
  );
}

function CalendarException({ exception, index, onChange, onRemove }) {
  return (
    <fieldset className="sla-exception">
      <legend>Excepción {index + 1}</legend>
      <input
        aria-label={`Fecha de excepción ${index + 1}`}
        type="date"
        value={exception.exception_date}
        onChange={(event) => onChange({ exception_date: event.target.value })}
      />
      <label>
        <input
          type="checkbox"
          checked={exception.closed}
          onChange={(event) =>
            onChange({
              closed: event.target.checked,
              windows: event.target.checked
                ? []
                : exception.windows?.length
                  ? exception.windows
                  : [{ starts_at: "", ends_at: "" }],
            })
          }
        />
        Día cerrado
      </label>
      {!exception.closed ? (
        <div>
          <h6>Franjas de reemplazo</h6>
          <WindowEditor
            windows={exception.windows || []}
            onChange={(windows) => onChange({ windows })}
          />
        </div>
      ) : null}
      <button type="button" onClick={onRemove}>
        Quitar excepción
      </button>
    </fieldset>
  );
}

export default function CalendarEditor({ draft, onChange, onSubmit }) {
  const patch = (value) => onChange({ ...draft, ...value });
  const updateException = (index, value) =>
    patch({
      exceptions: draft.exceptions.map((item, current) =>
        current === index ? { ...item, ...value } : item,
      ),
    });

  return (
    <form className="sla-editor" onSubmit={onSubmit}>
      <h4>Nuevo calendario versionado</h4>
      <div className="sla-form-grid">
        <label className="sla-field">
          <span>Nombre</span>
          <input
            value={draft.name}
            onChange={(event) => patch({ name: event.target.value })}
          />
        </label>
        <label className="sla-field">
          <span>Zona horaria IANA</span>
          <input
            value={draft.timezone}
            onChange={(event) => patch({ timezone: event.target.value })}
          />
        </label>
        <label className="sla-field">
          <span>Modo</span>
          <select
            value={draft.mode}
            onChange={(event) => patch({ mode: event.target.value })}
          >
            <option value="business_hours">Horario hábil</option>
            <option value="24x7">24 × 7</option>
          </select>
        </label>
      </div>
      {draft.mode === "business_hours" ? (
        <section aria-labelledby="weekly-windows-title">
          <h5 id="weekly-windows-title">
            Franjas semanales · se admite horario nocturno
          </h5>
          <WindowEditor
            weekly
            windows={draft.windows}
            onChange={(windows) => patch({ windows })}
          />
        </section>
      ) : null}
      <section className="sla-window-list" aria-labelledby="exceptions-title">
        <h5 id="exceptions-title">Excepciones</h5>
        {draft.exceptions.map((exception, index) => (
          <CalendarException
            key={index}
            exception={exception}
            index={index}
            onChange={(value) => updateException(index, value)}
            onRemove={() =>
              patch({
                exceptions: draft.exceptions.filter(
                  (_, current) => current !== index,
                ),
              })
            }
          />
        ))}
        <Button
          type="button"
          onClick={() =>
            patch({
              exceptions: [
                ...draft.exceptions,
                { exception_date: "", closed: true, windows: [] },
              ],
            })
          }
        >
          <Plus /> Añadir excepción
        </Button>
      </section>
      <Button variant="primary" type="submit">
        <Save /> Revisar y guardar
      </Button>
    </form>
  );
}
