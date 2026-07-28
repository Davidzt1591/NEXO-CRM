import { useId, useMemo, useRef, useState } from "react";
import {
  Button,
  FeedbackState,
  StatusPill,
} from "../../components/design-system/NexoPrimitives";
import {
  EMPTY_CALENDAR_DRAFT,
  EMPTY_POLICY_DRAFT,
  calendarDraftToRequest,
  latestPolicies,
  minutesLabel,
  validateCalendarDraft,
  validatePolicyDraft,
} from "./slaAdminContracts";
import { CalendarEditor, PolicyEditor, PolicyMatrix } from "./SlaEditors";
import SlaConfirmation from "./SlaConfirmations";
import { useSlaAdministration } from "./useSlaAdministration";
import "./slaAdministration.css";

const TABS = [
  { key: "policies", label: "Políticas" },
  { key: "calendars", label: "Calendarios" },
  { key: "history", label: "Historial" },
];
export default function SlaAdministration({ areas = [] }) {
  const api = useSlaAdministration();
  const [areaId, setAreaId] = useState(() =>
    String(areas.find((area) => area.active)?.id || areas[0]?.id || ""),
  );
  const [policyDraft, setPolicyDraft] = useState(() => ({
    ...EMPTY_POLICY_DRAFT,
  }));
  const [calendarDraft, setCalendarDraft] = useState(() => ({
    ...EMPTY_CALENDAR_DRAFT,
    windows: [],
    exceptions: [],
  }));
  const [review, setReview] = useState(null);
  const [tab, setTab] = useState("policies");
  const tabBaseId = useId();
  const tabRefs = useRef([]);
  const latest = useMemo(() => latestPolicies(api.policies), [api.policies]);
  const areaCalendars = api.calendars.filter(
    (item) => String(item.area_id) === areaId,
  );
  const selectTab = (next, focus = false) => {
    setTab(next);
    if (focus)
      queueMicrotask(() =>
        tabRefs.current[TABS.findIndex((item) => item.key === next)]?.focus(),
      );
  };
  const onTabKeyDown = (event) => {
    const index = TABS.findIndex((item) => item.key === tab);
    let next;
    if (event.key === "ArrowRight") next = TABS[(index + 1) % TABS.length].key;
    if (event.key === "ArrowLeft")
      next = TABS[(index - 1 + TABS.length) % TABS.length].key;
    if (event.key === "Home") next = TABS[0].key;
    if (event.key === "End") next = TABS.at(-1).key;
    if (next) {
      event.preventDefault();
      selectTab(next, true);
    }
  };
  const editPolicy = (policy, priority, clock) =>
    setPolicyDraft(
      policy
        ? {
            area_id: areaId,
            priority,
            clock_type: clock,
            clock_mode: policy.clock_mode,
            calendar_id: policy.calendar_id || "",
            target_minutes: policy.target_minutes,
            warning_minutes: policy.warning_minutes,
          }
        : {
            ...EMPTY_POLICY_DRAFT,
            area_id: areaId,
            priority,
            clock_type: clock,
          },
    );
  const reviewPolicy = (event) => {
    event.preventDefault();
    const candidate = { ...policyDraft, area_id: Number(areaId) };
    if (validatePolicyDraft(candidate).length) return;
    setReview({
      type: "policy",
      draft: {
        ...candidate,
        calendar_id:
          candidate.clock_mode === "24x7"
            ? null
            : Number(candidate.calendar_id),
        target_minutes: Number(candidate.target_minutes),
        warning_minutes: Number(candidate.warning_minutes),
      },
    });
  };
  const reviewCalendar = (event) => {
    event.preventDefault();
    if (validateCalendarDraft(calendarDraft).length || !areaId) return;
    setReview({
      type: "calendar",
      draft: {
        ...calendarDraft,
        area_id: Number(areaId),
        windows: calendarDraft.mode === "24x7" ? [] : calendarDraft.windows,
      },
    });
  };
  const confirm = async () => {
    const ok =
      review.type === "policy"
        ? await api.savePolicy(review.draft)
        : await api.saveCalendar(calendarDraftToRequest(review.draft));
    if (ok) {
      setReview(null);
      if (review.type === "calendar")
        setCalendarDraft({
          ...EMPTY_CALENDAR_DRAFT,
          area_id: areaId,
          windows: [],
          exceptions: [],
        });
    }
  };
  return (
    <section
      id="admin-sla-escalamientos"
      className="sla-admin admin-section-anchor"
      aria-labelledby="sla-admin-title"
    >
      <header className="sla-admin__intro">
        <div>
          <p className="admin-kicker">Gobierno de tiempos</p>
          <h3 id="sla-admin-title">SLA y Escalamientos</h3>
          <p>
            Configura los relojes de Soporte y Desarrollo. Cada guardado crea
            una versión no retroactiva.
          </p>
        </div>
        <Button onClick={api.reload} disabled={api.state.loading}>
          Actualizar
        </Button>
      </header>
      {api.state.error ? (
        <FeedbackState
          type="error"
          title="No se pudo completar la operación"
          message={api.state.error}
        />
      ) : null}
      {api.state.notice ? (
        <FeedbackState
          type="success"
          title={api.state.notice}
          message="La nueva versión aplica solo a relojes creados desde ahora."
        />
      ) : null}
      <div
        className="sla-tabs"
        role="tablist"
        aria-label="Configuración SLA"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map(({ key, label }, index) => (
          <button
            ref={(node) => {
              tabRefs.current[index] = node;
            }}
            id={`${tabBaseId}-tab-${key}`}
            aria-controls={`${tabBaseId}-panel-${key}`}
            tabIndex={tab === key ? 0 : -1}
            role="tab"
            aria-selected={tab === key}
            onClick={() => selectTab(key)}
            key={key}
          >
            {label}
          </button>
        ))}
      </div>
      <label className="sla-field sla-area">
        <span>Área</span>
        <select
          value={areaId}
          onChange={(event) => {
            setAreaId(event.target.value);
            setPolicyDraft((current) => ({
              ...current,
              area_id: event.target.value,
              calendar_id: "",
            }));
            setCalendarDraft((current) => ({
              ...current,
              area_id: event.target.value,
            }));
          }}
        >
          {areas.map((area) => (
            <option value={area.id} key={area.id}>
              {area.name}
            </option>
          ))}
        </select>
      </label>
      {api.state.loading ? (
        <FeedbackState
          type="loading"
          title="Cargando configuración real"
          message="Consultando políticas y calendarios…"
        />
      ) : null}
      {!api.state.loading && tab === "policies" ? (
        <section
          role="tabpanel"
          id={`${tabBaseId}-panel-policies`}
          aria-labelledby={`${tabBaseId}-tab-policies`}
        >
          <PolicyMatrix areaId={areaId} latest={latest} onEdit={editPolicy} />
          <PolicyEditor
            draft={policyDraft}
            calendars={areaCalendars}
            onChange={(patch) =>
              setPolicyDraft((current) => ({
                ...current,
                area_id: areaId,
                ...patch,
              }))
            }
            onSubmit={reviewPolicy}
          />
        </section>
      ) : null}
      {!api.state.loading && tab === "calendars" ? (
        <section
          role="tabpanel"
          id={`${tabBaseId}-panel-calendars`}
          aria-labelledby={`${tabBaseId}-tab-calendars`}
        >
          <CalendarEditor
            draft={calendarDraft}
            onChange={setCalendarDraft}
            onSubmit={reviewCalendar}
          />
        </section>
      ) : null}
      {!api.state.loading && tab === "history" ? (
        <section
          role="tabpanel"
          id={`${tabBaseId}-panel-history`}
          aria-labelledby={`${tabBaseId}-tab-history`}
          className="sla-history"
        >
          <p>Historial real devuelto por la API.</p>
          {api.policies
            .filter((item) => String(item.area_id) === areaId)
            .map((item) => (
              <article key={item.id}>
                <StatusPill tone={item.active ? "success" : "neutral"}>
                  {item.active ? "Activa" : "Histórica"}
                </StatusPill>
                <strong>
                  {item.priority} · {item.clock_type} · v{item.version}
                </strong>
                <span>
                  {minutesLabel(item.target_minutes)} · creada{" "}
                  {new Date(item.created_at).toLocaleString("es-CO")}
                </span>
              </article>
            ))}
        </section>
      ) : null}
      <SlaConfirmation
        review={review}
        areas={areas}
        calendars={api.calendars}
        pending={api.state.pending}
        onClose={() => setReview(null)}
        onConfirm={confirm}
      />
    </section>
  );
}
