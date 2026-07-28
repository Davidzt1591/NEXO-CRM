/* eslint-disable react-refresh/only-export-components */
import { useState } from 'react';
import { Edit2, MessageCircle, Plus, X } from 'lucide-react';
import { useAppStore } from '../../store/useAppStore';

const PRIORITIES = { Alta: { cls: 'priority--alta', label: 'Alta' }, Media: { cls: 'priority--media', label: 'Media' }, Baja: { cls: 'priority--baja', label: 'Baja' } };
const BORDERS = { Alta: '#ff4d6d', Media: '#f5c542', Baja: '#00e87a' };
const REACTIONS = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
const EMOJIS = ['😀','😃','😄','😁','😆','😅','🤣','😊','😇','🙂','😉','😌','😍','🥰','😘','😋','😛','😜','🤪','😎','😢','😮','😲','😱','🤔','🤨','😑','😶','😏','😒','🙄','😬','😴','🤒','😷','🤕','🥴','😵','🥺','😭','👍','👎','👌','✌️','🤞','🤙','👏','🙌','🤝','🙏','✊','👊','💪','🫶','❤️','🔥','⭐','✅','⚠️','🎉','🎊','🚀','💡','📌','📋','📞','📧','🔧','⚙️','💻','📱','🔑','💬','🗣️','📊','🛠️','🔔','📂','🗂️','🔍'];

export function formatTime(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return (new Date() - date) / 3600000 < 24 ? date.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' }) : date.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}
export function slaLabel(sla) { return !sla ? 'Sin SLA' : sla.state === 'breached' ? 'SLA vencido' : sla.state === 'warning' ? 'SLA por vencer' : 'SLA en tiempo'; }
export function assignmentLabel(contact) { return contact.assignment?.analyst?.display_name || (contact.assignment?.analyst_id ? `Analista #${contact.assignment.analyst_id}` : 'Sin asignar'); }
export function Avatar({ name, size = 'md' }) {
  const colors = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];
  const bg = colors[name ? name.charCodeAt(0) % colors.length : 0];
  const initials = name ? name.split(' ').slice(0, 2).map(part => part[0]).join('').toUpperCase() : '?';
  return <div className={`avatar avatar--${size}`} style={{ background: `linear-gradient(135deg, ${bg}, ${bg}99)` }}>{initials}</div>;
}
export function PriorityBadge({ priority }) { const value = PRIORITIES[priority]; return value ? <span className={`priority-badge ${value.cls}`}>{value.label}</span> : null; }
export function ConnectionDot({ status }) {
  const labels = { ready: 'Bot activo', connected: 'Conectado', connecting: 'Conectando...', disconnected: 'Desconectado' };
  const classes = { ready: 'dot--green', connected: 'dot--blue', connecting: 'dot--yellow dot--pulse', disconnected: 'dot--red' };
  return <div className="connection-badge"><span className={`dot ${classes[status] || 'dot--yellow dot--pulse'}`} /><span>{labels[status] || 'Conectando...'}</span></div>;
}
export function StatPill({ label, value, color }) { return <div className="stat-pill"><span className="stat-pill__value" style={{ color }}>{value}</span><span className="stat-pill__label">{label}</span></div>; }
export function PriorityModeToggle({ mode, onToggle }) { const manual = mode === 'manual'; return <button onClick={onToggle} className={`mode-toggle ${manual ? 'mode-toggle--manual' : 'mode-toggle--auto'}`}><span className={`mode-toggle__dot ${manual ? 'mode-toggle__dot--on' : ''}`} />{manual ? 'Manual' : 'Automático'}</button>; }
export function DetailRow({ label, value, mono = false, colorClass = '', onEdit }) { if (!value && !onEdit) return null; return <div className="detail-row"><div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}><p className="detail-row__label" style={{ margin: 0 }}>{label}</p>{onEdit ? <button onClick={onEdit} style={{ background: 'transparent', border: 0, color: 'var(--neon-cyan)', cursor: 'pointer', padding: 0 }} title="Editar Nombre"><Edit2 size={12} /></button> : null}</div><p className={`detail-row__value ${mono ? 'detail-row__value--mono' : ''} ${colorClass}`}>{value || '—'}</p></div>; }
export function EmptyState() { return <div className="empty-state"><div className="empty-state__icon pulse"><MessageCircle size={56} strokeWidth={1.5} /></div><h2 className="empty-state__title">NEXO AI Hub</h2><p className="empty-state__sub">Entorno seguro. En espera de nuevas conversaciones en tiempo real.</p></div>; }

function MediaRenderer({ media }) {
  if (!media?.data) return null;
  const src = `data:${media.mimetype};base64,${media.data}`;
  const type = media.mimetype?.split('/')[0];
  if (type === 'image') return <img src={src} className="media-img" alt={media.filename || 'imagen'} onClick={() => window.open(src, '_blank')} />;
  if (type === 'video') return <video src={src} className="media-video" controls />;
  if (type === 'audio') return <audio src={src} className="media-audio" controls />;
  return <a href={src} download={media.filename || 'archivo'} className="media-file">{media.filename || 'Descargar archivo'}</a>;
}
export function MessageBubble({ msg, contactName, onReact }) {
  const [open, setOpen] = useState(false);
  const incoming = msg.from_user;
  return <div style={{ display: 'flex', flexDirection: 'column', width: '100%', marginBottom: 8 }} onMouseLeave={() => setOpen(false)}><span style={{ alignSelf: incoming ? 'flex-start' : 'flex-end', fontSize: 11, color: 'var(--text-tertiary)', marginBottom: 6, fontWeight: 'bold' }}>{incoming ? contactName : msg.is_bot ? 'Bot' : 'Agente'}</span><div style={{ display: 'flex', flexDirection: incoming ? 'row' : 'row-reverse', alignItems: 'center', gap: 8 }}><div className={`message ${incoming ? 'message--in' : 'message--out'}`}><MediaRenderer media={msg.media} />{msg.body ? <p style={{ margin: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{msg.body}</p> : null}<span className="message__time">{formatTime(msg.timestamp)}</span>{msg.reaction ? <span>{msg.reaction}</span> : null}</div>{msg.waMessageId && onReact ? <div style={{ position: 'relative' }}><button onClick={() => setOpen(value => !value)} title="Reaccionar">☺</button>{open ? <div className="emoji-picker">{REACTIONS.map(emoji => <button key={emoji} onClick={() => { onReact(msg.waMessageId, emoji); setOpen(false); }}>{emoji}</button>)}</div> : null}</div> : null}</div></div>;
}
export function QuickEmojiGrid({ onSelect }) { return <div className="emoji-picker">{EMOJIS.map(emoji => <button key={emoji} className="emoji-btn" onClick={() => onSelect(emoji)}>{emoji}</button>)}</div>; }
export function QuickRepliesMenu({ replies, onSelect, onAdd, onDelete }) {
  const [title, setTitle] = useState(''); const [text, setText] = useState(''); const [adding, setAdding] = useState(false);
  return <div className="quick-replies-overlay"><div className="quick-replies-header"><h4>Respuestas Rápidas</h4><button onClick={() => setAdding(value => !value)} title="Nueva plantilla"><Plus size={16} /></button></div>{adding ? <div className="quick-replies-add-form"><input placeholder="Título (ej: Bienvenida)" value={title} onChange={event => setTitle(event.target.value)} /><textarea placeholder="Texto del mensaje..." value={text} onChange={event => setText(event.target.value)} rows={3} /><button disabled={!title.trim() || !text.trim()} onClick={() => { onAdd({ title: title.trim(), text: text.trim() }); setAdding(false); setTitle(''); setText(''); }}>Guardar Plantilla</button></div> : null}<div className="quick-replies-list">{replies.map(reply => <div key={reply.id} className="quick-reply-item"><button className="qr-body" onClick={() => onSelect(reply.text)}><strong>{reply.title}</strong><p>{reply.text.length > 60 ? `${reply.text.substring(0, 60)}...` : reply.text}</p></button><button className="qr-delete" onClick={() => onDelete(reply.id)} title="Eliminar"><X size={14} /></button></div>)}</div></div>;
}
export function ContactCard({ contact, isSelected, mode, isSilenced, unread, onClick, onClaim, claimState }) {
  const { contactTags, customNames } = useAppStore(); const key = contact.contactKey || contact.chatId; const name = contact.queue_card ? 'Caso sin asignar' : customNames[key] || contact.nombre_analista || (contact.chatId || contact.telefono || '').replace(/@c\.us|@lid/g, '') || 'Sin nombre';
  return <div className={`contact-card ${isSelected ? 'contact-card--selected' : ''} ${unread ? 'contact-card--unread' : ''}`} style={BORDERS[contact.prioridad] ? { borderLeft: `3px solid ${BORDERS[contact.prioridad]}` } : {}}><button type="button" className="contact-card__select" onClick={onClick} aria-label={`Abrir ticket de ${name}`}><Avatar name={name} size="sm" /><div className="contact-card__body"><div className="contact-card__row"><span className="contact-card__name">{name}</span><span className="contact-card__time">{formatTime(contact.lastTimestamp)}</span></div><p className="contact-card__preview">{contact.queue_card ? 'Detalles protegidos hasta tomar el caso' : contact.lastMessage || 'Sin mensajes'}</p><div className="contact-card__tags"><PriorityBadge priority={contact.prioridad} /><span className="tag tag--area">{contact.area?.name || (contact.area_id ? `Área #${contact.area_id}` : 'Sin área')}</span><span className={`tag tag--sla-${contact.sla?.state || 'none'}`}>{slaLabel(contact.sla)}</span>{contactTags[key] ? <span className="tag">{contactTags[key]}</span> : null}{mode === 'manual' ? <span className="tag tag--manual">Manual</span> : null}{isSilenced ? <span className="tag tag--silenced">Silenciado</span> : null}</div></div></button>{contact.queue_card && !contact.assignment?.analyst_id ? <button type="button" className="admin-soft-btn" disabled={claimState === 'pending'} onClick={() => onClaim?.(contact)}>{claimState === 'pending' ? 'Tomando…' : claimState === 'success' ? 'Asignado' : 'Tomar ticket'}</button> : null}{claimState?.startsWith?.('error:') ? <span role="alert" className="admin-error">{claimState.slice(6)}</span> : null}</div>;
}
