import {
  BellOff,
  BellRing,
  Bot,
  CornerUpRight,
  Info,
  Trash2,
  UserRoundCheck,
  UserRoundX,
} from "lucide-react";
import {
  Avatar,
  PriorityBadge,
  PriorityModeToggle,
} from "./WorkspacePrimitives";

function CandidateAction({ candidate, action }) {
  return (
    <button
      onClick={action.onChangeStatus}
      disabled={action.loading}
      className="action-btn action-btn--candidate"
    >
      {candidate ? <UserRoundCheck size={17} /> : <UserRoundX size={17} />}
      {action.loading
        ? "Guardando…"
        : candidate
          ? "Restaurar soporte"
          : "Marcar candidato"}
    </button>
  );
}

function DestructiveActions({
  silenced,
  onRedirect,
  onToggleSilence,
  onDelete,
}) {
  return (
    <>
      <button
        onClick={onRedirect}
        className="action-btn action-btn--icon action-btn--warning"
        title="Derivar a soporte"
      >
        <CornerUpRight size={18} />
      </button>
      <button
        onClick={onToggleSilence}
        className="action-btn action-btn--icon action-btn--glass"
        title={silenced ? "Activar notificaciones" : "Silenciar chat"}
      >
        {silenced ? <BellRing size={18} /> : <BellOff size={18} />}
      </button>
      <button
        onClick={onDelete}
        className="action-btn action-btn--icon action-btn--danger"
        title="Eliminar registro"
      >
        <Trash2 size={18} />
      </button>
    </>
  );
}

export default function ChatHeader({
  contact,
  headerName,
  mode,
  silenced,
  actions,
}) {
  return (
    <div className="chat-header">
      <div className="chat-header__left">
        <Avatar name={headerName} />
        <div>
          <h2 className="chat-header__name">{headerName}</h2>
          <p className="chat-header__sub">
            {contact.nombre_empresa ||
              contact.chatId?.replace(/@c\.us|@lid/g, "")}
          </p>
        </div>
        <PriorityBadge priority={contact.prioridad} />
        {contact.candidate ? (
          <span className="candidate-badge">Candidato · soporte detenido</span>
        ) : null}
      </div>
      <div className="chat-header__actions">
        <div className="contact-tag-selector">
          <button
            onClick={() => actions.onSetTag("proveedor")}
            className="tag-btn"
          >
            🛡️ PROV
          </button>
          <button
            onClick={() => actions.onSetTag("cliente_vip")}
            className="tag-btn"
          >
            ⭐ VIP
          </button>
        </div>
        <button
          onClick={actions.onForceBot}
          className="action-btn action-btn--icon"
          title="Forzar inicio del Bot para este chat"
        >
          <Bot size={18} />
        </button>
        {contact.id ? (
          <button
            onClick={actions.onOpenSalesforce}
            className="action-btn action-btn--icon"
            title="Gestionar en Salesforce"
          >
            ☁️
          </button>
        ) : null}
        <button
          onClick={actions.onToggleDetails}
          className="action-btn action-btn--icon"
          title="Ver Detalles del Perfil"
        >
          <Info size={18} />
        </button>
        {contact.id ? (
          <CandidateAction
            candidate={contact.candidate}
            action={{
              loading: actions.candidateLoading,
              onChangeStatus: actions.onChangeCandidateStatus,
            }}
          />
        ) : null}
        <PriorityModeToggle mode={mode} onToggle={actions.onToggleMode} />
        <DestructiveActions
          silenced={silenced}
          onRedirect={actions.onRedirect}
          onToggleSilence={actions.onToggleSilence}
          onDelete={actions.onDelete}
        />
      </div>
    </div>
  );
}
