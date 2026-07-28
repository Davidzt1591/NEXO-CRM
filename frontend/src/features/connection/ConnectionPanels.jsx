export function QrConnectionPanel({ qrDataUrl, qrCountdown, onRequestQr }) {
  return (
    <div
      role="tabpanel"
      id="auth-panel-qr"
      aria-labelledby="auth-tab-qr"
      tabIndex={0}
    >
      {qrDataUrl ? (
        <div className="qr-panel__image-wrap">
          <img
            src={qrDataUrl}
            alt="Código QR para vincular WhatsApp"
            className="qr-modal__image"
          />
        </div>
      ) : (
        <div className="qr-loading" role="status">
          <div className="qr-loading__spinner" />
          <p>Generando código QR...</p>
        </div>
      )}
      {qrDataUrl ? (
        <div className="qr-countdown">
          <div
            className="qr-countdown__bar"
            style={{
              width: `${(qrCountdown / 20) * 100}%`,
              background: qrCountdown <= 5 ? "var(--red)" : "var(--blue)",
            }}
          />
          <span className="qr-countdown__text">
            {qrCountdown > 0 ? `Válido por ${qrCountdown}s` : "QR expirado"}
          </span>
        </div>
      ) : null}
      {qrCountdown === 0 && qrDataUrl ? (
        <button className="qr-refresh-btn" onClick={onRequestQr}>
          Solicitar nuevo QR
        </button>
      ) : null}
      <div className="qr-panel__steps">
        <p>1. Abre WhatsApp en tu teléfono</p>
        <p>
          2. Toca <strong>Dispositivos vinculados</strong>
        </p>
        <p>
          3. Toca <strong>Vincular un dispositivo</strong> y escanea
        </p>
      </div>
    </div>
  );
}

export function PairingConnectionPanel({ ui, pairing, onRequestPairing }) {
  return (
    <div
      className="pairing-panel"
      role="tabpanel"
      id="auth-panel-code"
      aria-labelledby="auth-tab-code"
      tabIndex={0}
    >
      <p className="pairing-panel__desc">
        Ingresa el número de WhatsApp que quieres vincular (con código de país,
        sin espacios ni guiones).
      </p>
      <div className="pairing-input-row">
        <label className="nx-sr-only" htmlFor="pairing-phone">
          Número de WhatsApp con código de país
        </label>
        <input
          id="pairing-phone"
          type="tel"
          className="pairing-input"
          placeholder="Ej: 573001234567"
          value={ui.phone}
          onChange={(event) => ui.changePhone(event.target.value)}
        />
        <button
          className="pairing-request-btn"
          disabled={!ui.validPhone || pairing.loading}
          onClick={() => onRequestPairing(ui.phone)}
        >
          {pairing.loading ? "Generando..." : "Obtener código"}
        </button>
      </div>
      {pairing.loading && !pairing.code ? (
        <div className="pairing-loading" role="status">
          <div className="qr-loading__spinner" />
          <p>
            Reiniciando sesión y solicitando código...
            <br />
            <small>Puede tardar 15-30 segundos</small>
          </p>
        </div>
      ) : null}
      {pairing.code ? (
        <div className="pairing-code-display">
          <p className="pairing-code-display__label">
            Ingresa este código en WhatsApp:
          </p>
          <div className="pairing-code">{pairing.code}</div>
          <p className="pairing-code-display__hint">
            WhatsApp → Dispositivos vinculados → Vincular con número de teléfono
          </p>
        </div>
      ) : null}
      {pairing.error ? (
        <div className="pairing-error" role="alert">
          {pairing.error}
        </div>
      ) : null}
      <div className="qr-panel__steps" style={{ marginTop: 16 }}>
        <p>
          1. Ingresa el número y toca <strong>Obtener código</strong>
        </p>
        <p>2. Abre WhatsApp → Dispositivos vinculados</p>
        <p>
          3. Toca <strong>Vincular con número de teléfono</strong>
        </p>
        <p>4. Ingresa el código de 8 dígitos</p>
      </div>
    </div>
  );
}
