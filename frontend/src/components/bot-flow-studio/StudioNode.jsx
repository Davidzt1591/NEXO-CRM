import { Handle, Position } from '@xyflow/react';
import { Bot, CircleStop, GitBranch, MessageCircleQuestion, Play, ShieldCheck } from 'lucide-react';

const ICONS = Object.freeze({ entry: Play, capture: MessageCircleQuestion, decision: GitBranch, effect: Bot, terminal: CircleStop });

export default function StudioNode({ data, selected }) {
  const Icon = ICONS[data.runtime_type] || Bot;
  const decisionSource = data.runtime_type === 'decision';
  return (
    <article className={`studio-node studio-node--${data.runtime_type} ${data.canonical ? 'studio-node--canonical' : 'studio-node--draft'} ${selected ? 'studio-node--selected' : ''}`} aria-label={`${data.intentLabel}: ${data.displayLabel}`}>
      <Handle type="target" position={Position.Left} isConnectable={!data.canonical} aria-label="Recibe desde" title="Recibe desde" />
      {data.guidedDestination ? <button type="button" className="studio-guided-destination nodrag nopan" onClick={event => { event.stopPropagation(); data.onGuidedDestination(data.node_id); }} aria-label={`Conectar con ${data.displayLabel}`}>Conectar aquí</button> : null}
      <header><span className="studio-node__icon"><Icon size={16} /></span><span>{data.intentLabel}</span>{data.canonical ? <ShieldCheck size={14} aria-label="Conversación vigente protegida" /> : <small>Borrador</small>}</header>
      <strong>{data.displayLabel || 'Sin nombre'}</strong>
      <p>{data.message || 'Todavía no tiene mensaje.'}</p>
      <footer>{data.canonical ? 'Contenido/rutas protegidos · posición ajustable' : 'Borrador local · no ejecutable'}</footer>
      <Handle type="source" position={Position.Right} isConnectable={!decisionSource} aria-label={decisionSource ? 'Usa Conectar bloque para elegir una ruta' : 'Sale hacia'} title={decisionSource ? 'Usa Conectar bloque para elegir Sí, No u Otra respuesta' : 'Sale hacia'} />
    </article>
  );
}
