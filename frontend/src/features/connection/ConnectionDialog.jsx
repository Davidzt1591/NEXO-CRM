import AccessibleDialog from "../../components/design-system/AccessibleDialog";
import MagnetoLogo from "../../components/design-system/MagnetoLogo";
import { PairingConnectionPanel, QrConnectionPanel } from "./ConnectionPanels";
import { useConnectionDialog } from "./useConnectionDialog";

export function AuthMethodTabs({ mode, onSelect }) {
  const select = (next) => {
    onSelect(next);
    requestAnimationFrame(() =>
      document.getElementById(`auth-tab-${next}`)?.focus(),
    );
  };
  const keyDown = (event) => {
    const modes = ["qr", "code"];
    const current = modes.indexOf(mode);
    let next = null;
    if (event.key === "ArrowRight") next = (current + 1) % modes.length;
    if (event.key === "ArrowLeft")
      next = (current - 1 + modes.length) % modes.length;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = modes.length - 1;
    if (next === null) return;
    event.preventDefault();
    select(modes[next]);
  };
  return (
    <div
      className="auth-tabs"
      role="tablist"
      aria-label="Método de vinculación"
      onKeyDown={keyDown}
    >
      <button
        id="auth-tab-qr"
        role="tab"
        aria-selected={mode === "qr"}
        aria-controls="auth-panel-qr"
        tabIndex={mode === "qr" ? 0 : -1}
        className={`auth-tab ${mode === "qr" ? "auth-tab--active" : ""}`}
        onClick={() => onSelect("qr")}
      >
        Código QR
      </button>
      <button
        id="auth-tab-code"
        role="tab"
        aria-selected={mode === "code"}
        aria-controls="auth-panel-code"
        tabIndex={mode === "code" ? 0 : -1}
        className={`auth-tab ${mode === "code" ? "auth-tab--active" : ""}`}
        onClick={() => onSelect("code")}
      >
        Código numérico
      </button>
    </div>
  );
}

export default function ConnectionDialog({
  open,
  onClose,
  qrDataUrl,
  qrCountdown,
  pairingCode,
  pairingError,
  pairingLoading,
  onRequestQr,
  onRequestPairing,
  onResetPairing,
}) {
  const ui = useConnectionDialog({ open, onResetPairing });
  if (!open) return null;

  return (
    <AccessibleDialog
      title="Conectar WhatsApp"
      onClose={onClose}
      className="qr-modal"
    >
      <MagnetoLogo variant="dark" className="qr-panel__magneto-logo" />
      <p className="qr-panel__sub">Elige cómo vincular tu cuenta</p>
      <AuthMethodTabs mode={ui.mode} onSelect={ui.selectMode} />
      {ui.mode === "qr" ? (
        <QrConnectionPanel
          qrDataUrl={qrDataUrl}
          qrCountdown={qrCountdown}
          onRequestQr={onRequestQr}
        />
      ) : (
        <PairingConnectionPanel
          ui={ui}
          pairing={{
            code: pairingCode,
            error: pairingError,
            loading: pairingLoading,
          }}
          onRequestPairing={onRequestPairing}
        />
      )}
    </AccessibleDialog>
  );
}
