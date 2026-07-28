import {
  Inbox,
  LayoutDashboard,
  QrCode,
  Search,
  ShieldCheck,
  Terminal,
  MessageSquare,
} from "lucide-react";
import ChatFilters from "../../components/ChatFilters";
import MagnetoLogo from "../../components/design-system/MagnetoLogo";
import { ConversationViewToggle } from "../conversations/ConversationBoard";
import ConversationExperience from "../conversations/ConversationExperience";
import ChatWorkspace from "./ChatWorkspace";
import OperationalViews from "./OperationalViews";
import { ConnectionDot, ContactCard, StatPill } from "./WorkspacePrimitives";

function Header({ socket, workspace, onLogout }) {
  const changeAccount = () => {
    if (!window.confirm("¿Cerrar sesión de WhatsApp y conectar otra cuenta?"))
      return;
    workspace.setQrDataUrl(null);
    workspace.setQrCountdown(0);
    workspace.setAuthMode("qr");
    workspace.setPairingCode(null);
    workspace.setShowQR(true);
    socket.emit("logout");
  };
  return (
    <header className="topbar">
      <div className="topbar__brand">
        <MagnetoLogo variant="dark" className="topbar__magneto-logo" />
        <span className="topbar__product">
          <span className="topbar__name">NEXO</span>
          <span className="topbar__sub">Centro operativo</span>
        </span>
      </div>
      <div className="topbar__right">
        <div className="stats-row">
          <StatPill
            label="Abiertos"
            value={workspace.counts.open}
            color="var(--blue)"
          />
          <StatPill
            label="Alta Prior."
            value={workspace.counts.high}
            color="var(--red)"
          />
          <StatPill
            label="Manuales"
            value={workspace.counts.manual}
            color="var(--yellow)"
          />
        </div>
        <button
          onClick={() => socket.emit("set-bot-activo", !workspace.botActivo)}
          className={`bot-switch ${workspace.botActivo ? "bot-switch--on" : "bot-switch--off"}`}
        >
          {workspace.botActivo ? "Bot activo" : "Bot inactivo"}
        </button>
        {workspace.botStatus === "ready" ? (
          <button
            className="action-btn action-btn--danger"
            onClick={changeAccount}
          >
            <ShieldCheck size={18} />
            Cambiar cuenta
          </button>
        ) : (
          <button
            className="action-btn action-btn--primary"
            onClick={() => workspace.setShowQR(true)}
          >
            <QrCode size={18} />
            Conectar WhatsApp
          </button>
        )}
        <ConnectionDot status={workspace.botStatus} />
        <button className="action-btn action-btn--secondary" onClick={onLogout}>
          Salir
        </button>
      </div>
    </header>
  );
}
function Sidebar({
  workspace,
  actions,
  onLoadStats,
  onLoadLogs,
  onChangeConversationView,
}) {
  return (
    <aside className="sidebar">
      <div className="sidebar-nav">
        <button
          onClick={() => workspace.setCurrentView("chats")}
          className={`sidebar-nav__btn ${workspace.currentView === "chats" ? "sidebar-nav__btn--active" : ""}`}
        >
          <MessageSquare size={16} /> Chats
        </button>
        <button
          onClick={onLoadStats}
          className={`sidebar-nav__btn ${workspace.currentView === "metrics" ? "sidebar-nav__btn--active" : ""}`}
        >
          <LayoutDashboard size={16} /> Métricas
        </button>
        <button
          onClick={onLoadLogs}
          className={`sidebar-nav__btn ${workspace.currentView === "logs" ? "sidebar-nav__btn--active" : ""}`}
        >
          <Terminal size={16} /> Logs
        </button>
      </div>
      {workspace.currentView === "chats" ? (
        <>
          <div className="sidebar__search">
            <Search size={18} className="sidebar__search-icon" />
            <input
              aria-label="Buscar contactos"
              placeholder="Buscar contacto..."
              value={workspace.search}
              onChange={(event) => workspace.setSearch(event.target.value)}
              className="sidebar__search-input"
            />
          </div>
          <ChatFilters
            filter={workspace.filter}
            isAdmin={workspace.principal?.user?.role === "admin"}
            onChange={workspace.setFilter}
          />
          <ConversationViewToggle
            view={workspace.conversationView}
            onChange={onChangeConversationView}
          />
          <div className="contact-list">
            {workspace.visibleContacts.length ? (
              workspace.visibleContacts.map((contact) => {
                const key = contact.contactKey || contact.chatId;
                return (
                  <ContactCard
                    key={key}
                    contact={contact}
                    isSelected={workspace.selectedId === key}
                    mode={workspace.chatModes[contact.chatId]}
                    isSilenced={workspace.silenced[contact.chatId]}
                    unread={workspace.unread[key] || 0}
                    onClick={() => actions.selectContact(key)}
                    onClaim={actions.claimTicket}
                    claimState={workspace.claimStates[String(contact.id)]}
                  />
                );
              })
            ) : (
              <div className="contact-list__empty">
                <Inbox size={48} />
                <p>Bandeja Segura Vacía</p>
              </div>
            )}
          </div>
        </>
      ) : null}
    </aside>
  );
}
export default function AgentWorkspaceShell({
  socket,
  workspace,
  actions,
  workflowController,
  onLogout,
  onLoadLogs,
}) {
  const changeView = (view) => {
    localStorage.setItem("nexo_conversation_view", view);
    workspace.setConversationView(view);
  };
  const loadStats = () => {
    workspace.setCurrentView("metrics");
    socket.emit("get-stats");
    socket.emit("get-system-info");
  };
  const board =
    workspace.currentView === "chats" && workspace.conversationView === "board";
  return (
    <>
      <Header socket={socket} workspace={workspace} onLogout={onLogout} />
      <div className={`workspace ${board ? "workspace--board" : ""}`}>
        {!board ? (
          <Sidebar
            workspace={workspace}
            actions={actions}
            onLoadStats={loadStats}
            onLoadLogs={onLoadLogs}
            onChangeConversationView={changeView}
          />
        ) : null}
        {board ? (
          <ConversationExperience
            view="board"
            board={{
              tickets: workspace.visibleContacts,
              unread: workspace.unread,
              selectedContact: workspace.selectedContact,
              controller: workflowController,
              principal: workspace.principal,
              error: workspace.boardError,
              onSelect: actions.selectContact,
              onMove: actions.moveBoardTicket,
              onClaim: actions.claimTicket,
              onReturnList: () => changeView("list"),
              onCloseWorkspace: () => workspace.setSelectedId(null),
            }}
          />
        ) : workspace.currentView !== "chats" ? (
          <OperationalViews workspace={workspace} onLoadLogs={onLoadLogs} />
        ) : (
          <ChatWorkspace
            socket={socket}
            workspace={workspace}
            actions={actions}
            workflowController={workflowController}
          />
        )}
      </div>
    </>
  );
}
