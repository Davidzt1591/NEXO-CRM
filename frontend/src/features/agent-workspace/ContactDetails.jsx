import {
  DetailRow,
  assignmentLabel,
  formatTime,
  slaLabel,
} from "./WorkspacePrimitives";

export default function ContactDetails({ contact, workspace }) {
  const editName = () => {
    const name = window.prompt(
      "Introduce el alias o nombre real completo del usuario:",
      workspace.customNames[workspace.selectedId] || "",
    );
    if (name !== null)
      workspace.setCustomName(workspace.selectedId, name.trim());
  };

  return (
    <aside
      className={`detail-panel ${workspace.isDetailOpen ? "detail-panel--open" : ""}`}
    >
      <h3 className="detail-panel__title">Detalles del Perfil</h3>
      <div className="detail-panel__body">
        <DetailRow
          label="Ticket ID"
          value={
            contact.id ? `#${String(contact.id).slice(0, 8).toUpperCase()}` : ""
          }
          mono
        />
        <DetailRow
          label="Nombre Contacto"
          value={workspace.headerName}
          onEdit={editName}
        />
        <DetailRow label="Empresa" value={contact.nombre_empresa} />
        <DetailRow label="Correo" value={contact.correo} />
        <DetailRow
          label="Número Tel / ID"
          value={(workspace.selectedChatId || "").replace(/@c\.us|@lid/g, "")}
          mono
        />
        <DetailRow
          label="Área"
          value={
            contact.area?.name ||
            (contact.area_id ? `Área #${contact.area_id}` : "Sin área asignada")
          }
        />
        <DetailRow label="Asignación" value={assignmentLabel(contact)} />
        <DetailRow
          label="SLA"
          value={
            contact.sla
              ? `${slaLabel(contact.sla)} · ${contact.sla.age_minutes} min · vence ${formatTime(contact.sla.due_at)}`
              : "Sin SLA calculado"
          }
        />
        <DetailRow
          label="Mensajes"
          value={String(workspace.selectedMessages.length)}
          mono
        />
      </div>
    </aside>
  );
}
