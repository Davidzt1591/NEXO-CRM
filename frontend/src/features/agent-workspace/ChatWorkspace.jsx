/* eslint-disable react-hooks/refs */
import { Bot } from "lucide-react";
import ConversationWorkspace from "../conversations/ConversationWorkspace";
import ChatComposer from "./ChatComposer";
import ChatHeader from "./ChatHeader";
import ContactDetails from "./ContactDetails";
import { EmptyState, MessageBubble } from "./WorkspacePrimitives";

export default function ChatWorkspace({
  socket,
  workspace,
  actions,
  workflowController,
}) {
  const contact = workspace.selectedContact;
  if (!contact) {
    return (
      <main className="chat-area">
        <EmptyState />
      </main>
    );
  }

  const manual = workspace.chatModes[workspace.selectedChatId] === "manual";
  const silenced = workspace.silenced[workspace.selectedChatId];
  const setTag = (tag) => {
    const current = workspace.contactTags[workspace.selectedId];
    workspace.setContactTag(workspace.selectedId, current === tag ? null : tag);
    if (current !== tag) {
      socket.emit("toggle-mode", {
        chatId: workspace.selectedChatId,
        mode: "manual",
      });
    }
  };
  const deleteChat = () => {
    const confirmed = window.confirm(
      "🚨 ¿Estás seguro de eliminar este chat/ticket permanentemente? Esta acción destruirá todos los registros asociados en la base de datos y no se puede deshacer.",
    );
    if (!confirmed) return;
    socket.emit("delete-chat", {
      contactKey: workspace.selectedId,
      ticketId: contact.id || null,
    });
    workspace.setContacts((previous) => {
      const next = { ...previous };
      delete next[workspace.selectedId];
      return next;
    });
    workspace.setChatMessages((previous) => {
      const next = { ...previous };
      delete next[workspace.selectedId];
      return next;
    });
    workspace.setSelectedId(null);
  };
  const redirect = () => {
    const confirmed = window.confirm(
      "¿Deseas dar este caso por no correspondiente y enviarlo a soporte general? Se enviará un mensaje al usuario y el chat se finalizará.",
    );
    if (!confirmed) return;
    socket.emit("redirect-support", {
      contactKey: workspace.selectedId,
      ticketId: contact.id || null,
    });
  };
  const forceBot = () => {
    const confirmed = window.confirm(
      "¿Deseas despertar e iniciar el bot conversacional de forma forzada para este cliente?",
    );
    if (confirmed) socket.emit("force-bot", workspace.selectedChatId);
  };

  const headerActions = {
    onSetTag: setTag,
    onForceBot: forceBot,
    onOpenSalesforce: () =>
      workspace.setSfModal({ open: true, ticket: contact }),
    onToggleDetails: () => workspace.setIsDetailOpen((value) => !value),
    onChangeCandidateStatus: actions.changeCandidateStatus,
    candidateLoading: workspace.candidateAction.loading,
    onToggleMode: () => actions.toggleMode(workspace.selectedId),
    onRedirect: redirect,
    onToggleSilence: actions.toggleSilence,
    onDelete: deleteChat,
  };

  return (
    <>
      <main className="chat-area">
        <ChatHeader
          contact={contact}
          headerName={workspace.headerName}
          mode={workspace.chatModes[workspace.selectedChatId]}
          silenced={silenced}
          actions={headerActions}
        />
        <ConversationWorkspace
          controller={workflowController}
          principal={workspace.principal}
        />
        {!workspace.botActivo ? (
          <div className="bot-inactive-banner">
            <Bot size={18} />
            Bot desactivado — los mensajes llegan pero no son contestados
          </div>
        ) : null}
        {workspace.candidateAction.error ? (
          <div className="input-notice input-notice--danger" role="alert">
            {workspace.candidateAction.error}
          </div>
        ) : null}
        {workspace.candidateAction.notice ? (
          <div className="input-notice input-notice--success" role="status">
            {workspace.candidateAction.notice}
          </div>
        ) : null}
        <div className="messages-area">
          {workspace.selectedMessages.length ? (
            workspace.selectedMessages.map((message, index) => (
              <MessageBubble
                key={message.waMessageId || index}
                msg={message}
                contactName={workspace.headerName}
                onReact={actions.sendReaction}
              />
            ))
          ) : (
            <div className="messages-area__empty">Sin mensajes aún</div>
          )}
          <div ref={workspace.messagesEndRef} />
        </div>
        <ChatComposer
          workspace={workspace}
          actions={actions}
          manual={manual}
          silenced={silenced}
        />
      </main>
      <ContactDetails contact={contact} workspace={workspace} />
    </>
  );
}
