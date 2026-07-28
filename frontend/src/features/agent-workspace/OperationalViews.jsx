import { RefreshCw } from "lucide-react";
import { DetailRow } from "./WorkspacePrimitives";

function LoadingIndicator() {
  return (
    <div className="qr-loading">
      <div className="qr-loading__spinner" />
    </div>
  );
}

function LogsView({ workspace, onLoadLogs }) {
  return (
    <main
      className="chat-area logs-view"
      style={{ flex: 1, padding: 32, overflowY: "auto" }}
    >
      <div>
        <h2 className="empty-state__title">📋 Logs del Sistema</h2>
        <button onClick={onLoadLogs} className="action-btn action-btn--glass">
          <RefreshCw size={16} /> Actualizar
        </button>
      </div>
      {workspace.logsLoading ? (
        <LoadingIndicator />
      ) : (
        <div className="logs-terminal">
          {workspace.logs.map((log, index) => (
            <div
              key={index}
              className={`log-entry log-entry--${log.type.toLowerCase()}`}
            >
              <span className="log-ts">
                {new Date(log.ts).toLocaleTimeString("es-CO")}
              </span>
              <span
                className={`log-badge log-badge--${log.type.toLowerCase()}`}
              >
                {log.type}
              </span>
              <span className="log-msg">{log.msg}</span>
            </div>
          ))}
        </div>
      )}
    </main>
  );
}

function MetricsView({ workspace }) {
  return (
    <main
      className="chat-area"
      style={{ flex: 1, padding: 48, overflowY: "auto" }}
    >
      <h2 className="empty-state__title">Dashboard Analítico</h2>
      {workspace.stats ? (
        <>
          <div className="dashboard-grid">
            <div className="dash-card">
              <h3>Total Atenciones</h3>
              <p>{workspace.stats.total}</p>
            </div>
            <div className="dash-card">
              <h3>Casos Activos</h3>
              <p>{workspace.stats.open}</p>
            </div>
            <div className="dash-card">
              <h3>Casos Cerrados</h3>
              <p>{workspace.stats.closed}</p>
            </div>
            <div className="dash-card">
              <h3>Tiempo Medio Atención</h3>
              <p>{workspace.stats.tmaMins} min</p>
            </div>
          </div>
          <div className="system-status-panel">
            {workspace.systemInfo ? (
              <>
                <DetailRow
                  label="Número Vinculado"
                  value={`+${workspace.systemInfo.user}`}
                  mono
                />
                <DetailRow
                  label="Nombre Dispositivo"
                  value={workspace.systemInfo.pushname}
                />
              </>
            ) : (
              <p>Obteniendo datos del ecosistema base...</p>
            )}
          </div>
        </>
      ) : (
        <LoadingIndicator />
      )}
    </main>
  );
}

export default function OperationalViews({ workspace, onLoadLogs }) {
  if (workspace.currentView === "logs") {
    return <LogsView workspace={workspace} onLoadLogs={onLoadLogs} />;
  }
  if (workspace.currentView === "metrics")
    return <MetricsView workspace={workspace} />;
  return null;
}
