import { ChevronDown, Copy, Link2, Save, ShieldCheck, Trash2, X } from 'lucide-react';

export default function StudioInspector({ node, edge, flow, areas, label, onLabelChange, onFlowChange, onSave, saving, saveError, serverConflict, onKeepLocal, onReloadServer, onDelete, onDuplicate, onDeleteEdge, onStartConnect, onClose, connecting, connectDisabled = false, connectStatus = '' }) {
  if (edge) return <aside className="studio-inspector" aria-label="Inspector de la ruta seleccionada"><div className="studio-panel-title"><span>Ruta en borrador</span><strong>{edge.label}</strong><button type="button" className="studio-panel-close" aria-label="Cerrar editor" onClick={onClose}><X size={16} /></button></div><div className="studio-local-warning">Esta ruta solo organiza el borrador local. No cambia ni ejecuta la conversación vigente.</div><div className="studio-node-actions"><button type="button" onClick={onDeleteEdge} className="danger"><Trash2 size={15} /> Eliminar ruta seleccionada</button></div></aside>;
  if (!node) return <aside className="studio-inspector studio-panel-empty"><ShieldCheck size={24} /><strong>Selecciona un bloque</strong><span>Aquí podrás ajustar su contenido y entender qué lugar ocupa en la conversación.</span></aside>;
  const isDraft = !node.canonical;
  const canSave = !isDraft && node.message_key && flow?.message?.trim();
  return (
    <aside className="studio-inspector" aria-label="Inspector del bloque seleccionado">
      <div className="studio-panel-title"><span>{isDraft ? 'Bloque en preparación' : 'Conversación vigente'}</span><strong>{label || node.label}</strong><button type="button" className="studio-panel-close" aria-label="Cerrar editor" onClick={onClose}><X size={16} /></button></div>
      {isDraft ? <div className="studio-local-warning">Este borrador solo sirve para diseñar. No cambia lo que responde el bot.</div> : null}
      {node.runtime_type !== 'terminal' ? <><button type="button" className="studio-connect-action" onClick={onStartConnect} aria-label={connecting ? 'Elige el bloque de destino' : 'Conectar bloque desde Editar'} aria-pressed={connecting} disabled={connectDisabled}><Link2 size={16} /> {connecting ? 'Elige el bloque de destino' : 'Conectar bloque'}</button>{connectStatus ? <div role="status" className="studio-local-warning">{connectStatus}</div> : null}</> : null}
      {saveError ? <div className="studio-simulation-error" role="alert">{saveError}</div> : null}
      {serverConflict ? <div className="studio-message-conflict" role="alert"><strong>Hay una versión más reciente</strong><span>Tu texto sigue intacto. Elige cuál versión quieres usar.</span><div><button type="button" onClick={onKeepLocal}>Conservar mi texto</button><button type="button" onClick={onReloadServer}>Usar cambios guardados</button></div></div> : null}
      <label><span>Nombre visible <em>{isDraft ? 'cambio local' : 'no se guarda con el mensaje'}</em></span><input value={label} onChange={event => onLabelChange(event.target.value)} /></label>
      <div className="studio-readout"><span>Intención</span><strong>{humanType(node.runtime_type)}</strong></div>
      {(node.message_key || isDraft) ? (
        <form onSubmit={onSave}>
          <label><span>Mensaje del bot</span><textarea rows="5" value={flow?.message || node.message || ''} onChange={event => onFlowChange({ message: event.target.value })} placeholder="Mensaje que recibe la persona" /></label>
          {!isDraft ? <><div className="studio-field-row"><label><span>Versión activa</span><input value={flow?.version_id || 1} readOnly /></label><label><span>Alcance</span><select value={flow?.area_id || ''} disabled><option value="">Todas las áreas</option>{areas.map(area => <option key={area.id} value={area.id}>{area.name}</option>)}</select></label></div><label className="studio-check"><input type="checkbox" checked={flow?.active !== false} onChange={event => onFlowChange({ active: event.target.checked })} /><span>Mensaje activo</span></label><button className="admin-primary-btn" disabled={!canSave || saving}><Save size={16} /> {saving ? 'Guardando mensaje…' : flow?.id ? 'Guardar solo el mensaje' : 'Crear mensaje'}</button><p className="studio-save-note">Deshacer no modifica mensajes ya guardados. El nombre visible permanece como borrador local.</p></> : null}
        </form>
      ) : null}
      {isDraft ? <div className="studio-node-actions"><button type="button" onClick={onDuplicate}><Copy size={15} /> Duplicar</button><button type="button" onClick={onDelete} className="danger"><Trash2 size={15} /> Eliminar</button></div> : null}
      <details><summary><ChevronDown size={15} /> Información avanzada</summary><dl><dt>Identificador</dt><dd>{node.node_id}</dd><dt>Clave del mensaje</dt><dd>{node.message_key || 'Sin clave asignada'}</dd></dl></details>
    </aside>
  );
}

function humanType(type) { return { entry: 'Enviar mensaje', capture: 'Hacer pregunta', decision: 'Tomar decisión', effect: 'Ejecutar acción', terminal: 'Finalizar' }[type] || 'Bloque conversacional'; }
