/* eslint-disable react-hooks/refs */
import { Send, Zap } from "lucide-react";
import { QuickEmojiGrid, QuickRepliesMenu } from "./WorkspacePrimitives";

export default function ChatComposer({ workspace, actions, manual, silenced }) {
  const insertReply = (text) => {
    workspace.setNewMessage(text);
    workspace.setShowQuickReplies(false);
    workspace.inputRef.current?.focus();
  };
  const addReply = (data) =>
    workspace.setQuickReplies([
      ...workspace.quickReplies,
      { ...data, id: Date.now().toString() },
    ]);

  return (
    <div className="message-input-area">
      {silenced ? (
        <div className="input-notice input-notice--danger">
          Chat silenciado — el bot no responderá automáticamente
        </div>
      ) : null}
      {!manual && !silenced ? (
        <div className="input-notice input-notice--info">
          Modo automático activo — activa Manual para responder
        </div>
      ) : null}
      {workspace.pendingMedia ? (
        <div className="pending-media-preview">
          <span>{workspace.pendingMedia.filename}</span>
          <button onClick={() => workspace.setPendingMedia(null)}>✕</button>
        </div>
      ) : null}
      <div className="message-input-row">
        <input
          type="file"
          ref={workspace.fileInputRef}
          onChange={actions.handleFileSelect}
          style={{ display: "none" }}
        />
        <button
          className="attach-btn"
          onClick={() => workspace.fileInputRef.current?.click()}
          disabled={!manual}
        >
          📎
        </button>
        <button
          onClick={actions.improveGrammar}
          disabled={
            !workspace.newMessage.trim() || !manual || workspace.isImprovingText
          }
        >
          {workspace.isImprovingText ? "⏳" : "✨"}
        </button>
        <button
          className="emoji-toggle-btn"
          onClick={() => {
            workspace.setShowQuickReplies((value) => !value);
            workspace.setShowEmojiPicker(false);
          }}
          disabled={!manual}
        >
          <Zap size={17} />
        </button>
        <button
          className="emoji-toggle-btn"
          onClick={() => {
            workspace.setShowEmojiPicker((value) => !value);
            workspace.setShowQuickReplies(false);
          }}
          disabled={!manual}
        >
          😊
        </button>
        <textarea
          ref={workspace.inputRef}
          value={workspace.newMessage}
          onChange={(event) => workspace.setNewMessage(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              actions.sendMessage();
            }
          }}
          placeholder={
            manual
              ? "Escribe tu mensaje... (Usa Shift+Enter para saldo de línea)"
              : "Activa el modo manual para responder"
          }
          disabled={!manual}
          className="message-input"
          rows={1}
        />
        <button
          onClick={actions.sendMessage}
          disabled={
            (!workspace.newMessage.trim() && !workspace.pendingMedia) || !manual
          }
          className="send-btn"
        >
          <Send size={18} />
        </button>
        {workspace.showEmojiPicker && manual ? (
          <div className="emoji-picker-wrap">
            <QuickEmojiGrid
              onSelect={(emoji) => {
                workspace.setNewMessage((previous) => previous + emoji);
                workspace.setShowEmojiPicker(false);
              }}
            />
          </div>
        ) : null}
        {workspace.showQuickReplies && manual ? (
          <div className="quick-replies-wrap">
            <QuickRepliesMenu
              replies={workspace.quickReplies}
              onSelect={insertReply}
              onAdd={addReply}
              onDelete={(id) =>
                workspace.setQuickReplies(
                  workspace.quickReplies.filter((reply) => reply.id !== id),
                )
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
