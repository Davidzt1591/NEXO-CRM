/* eslint-disable react-hooks/refs -- Callback refs are intentionally carried by the lifecycle controller. */
import { useState } from "react";
import MagnetoLogo from "../../components/design-system/MagnetoLogo";

function SessionBrand() {
  return <MagnetoLogo variant="dark" className="login-magneto-logo" />;
}

export function LoginView({ session }) {
  const [token, setToken] = useState("");
  const submit = (event) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) return;
    setToken("");
    void session.login(value);
  };
  return (
    <div className="login-container">
      <div className="login-card">
        <SessionBrand />
        <h1 className="login-title" ref={session.headingRef} tabIndex={-1}>
          NEXO
        </h1>
        <p className="login-subtitle">Dashboard de Integraciones</p>
        <form onSubmit={submit} className="login-form">
          <div className="login-input-group">
            <label className="login-label" htmlFor="nexo-token-input">
              Token de Acceso Corporativo
            </label>
            <input
              type="password"
              id="nexo-token-input"
              className="login-input"
              placeholder="Introduce tu token nexo_tkn_..."
              value={token}
              ref={session.tokenInputRef}
              onChange={(event) => setToken(event.target.value)}
              required
            />
          </div>
          {session.error ? (
            <div className="login-error-msg" role="alert">
              {session.error}
            </div>
          ) : null}
          <button
            type="submit"
            className="login-submit-btn"
            disabled={session.pending}
          >
            {session.pending ? "Verificando…" : "Verificar Credenciales"}
          </button>
        </form>
        <div className="login-footer">
          Área protegida de Magneto365. Acceso auditado.
        </div>
      </div>
    </div>
  );
}
export default function SessionGate({ session, children }) {
  if (session.unavailable && !session.authenticated)
    return (
      <div className="login-container">
        <div
          className="login-card"
          ref={session.statusRef}
          tabIndex={-1}
          role="alert"
          aria-labelledby="session-unavailable-title"
        >
          <SessionBrand />
          <h1 id="session-unavailable-title">No pudimos verificar tu sesión</h1>
          <p>
            La autenticación no está disponible temporalmente. Tu sesión no fue
            cerrada.
          </p>
          <button
            type="button"
            className="login-submit-btn"
            onClick={session.restore}
          >
            Reintentar
          </button>
        </div>
      </div>
    );
  if (session.authenticated === null)
    return (
      <div className="login-container">
        <div className="login-card" role="status" aria-live="polite">
          <SessionBrand />
          <h1 className="login-title">Restaurando sesión segura</h1>
          <p>Verificando tus credenciales protegidas…</p>
        </div>
      </div>
    );
  if (!session.authenticated) return <LoginView session={session} />;
  return children;
}
