import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import QRCode from 'qrcode';
import { useAppStore } from './store/useAppStore';
import EmojiPicker from 'emoji-picker-react';
import { 
  MessageCircle, Search, Inbox, Send, ShieldCheck, Bot, LayoutDashboard, 
  MessageSquare, QrCode, CornerUpRight, BellOff, BellRing, CheckCircle, Trash2, Edit2, Info,
  Zap, Plus, X, Terminal, RefreshCw
} from 'lucide-react';
import './App.css';
import SalesforceCaseModal from './components/SalesforceCaseModal';
import AdminPanel from './components/AdminPanel';
import { apiRequest } from './lib/apiClient';

const socket = io('http://localhost:3001', {
  transports: ['websocket'],
  autoConnect: false, // Let the app connect explicitly after token check
  auth: (cb) => {
    cb({ token: localStorage.getItem('nexo_token') });
  },
  reconnectionAttempts: 10,
  reconnectionDelay: 1500,
});

// ─────────────────────────────────────────────
// Utils
// ─────────────────────────────────────────────
const PRIORITY_MAP = {
  Alta:  { cls: 'priority--alta',  label: 'Alta' },
  Media: { cls: 'priority--media', label: 'Media' },
  Baja:  { cls: 'priority--baja',  label: 'Baja' },
};

function getInitials(name) {
  if (!name) return '?';
  return name.split(' ').slice(0, 2).map(n => n[0]).join('').toUpperCase();
}

function formatTime(ts) {
  if (!ts) return '';
  const d    = new Date(ts);
  const now  = new Date();
  const diff = (now - d) / 3600000;
  if (diff < 24) return d.toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
  return d.toLocaleDateString('es-CO', { day: '2-digit', month: 'short' });
}

function slaLabel(sla) {
  if (!sla) return 'Sin SLA';
  if (sla.state === 'breached') return 'SLA vencido';
  if (sla.state === 'warning') return 'SLA por vencer';
  return 'SLA en tiempo';
}

function assignmentLabel(contact) {
  const analyst = contact.assignment?.analyst;
  if (analyst?.display_name) return analyst.display_name;
  if (contact.assignment?.analyst_id) return `Analista #${contact.assignment.analyst_id}`;
  return 'Sin asignar';
}

function avatarColor(name) {
  const colors = ['#7c3aed', '#0ea5e9', '#10b981', '#f59e0b', '#ef4444', '#ec4899'];
  const i = name ? name.charCodeAt(0) % colors.length : 0;
  return colors[i];
}

// ─────────────────────────────────────────────
// Componentes auxiliares
// ─────────────────────────────────────────────
function Avatar({ name, size = 'md' }) {
  const bg = avatarColor(name);
  return (
    <div className={`avatar avatar--${size}`} style={{ background: `linear-gradient(135deg, ${bg}, ${bg}99)` }}>
      {getInitials(name)}
    </div>
  );
}

function PriorityBadge({ priority }) {
  const p = PRIORITY_MAP[priority];
  if (!p) return null;
  return <span className={`priority-badge ${p.cls}`}>{p.label}</span>;
}

function ConnectionDot({ status }) {
  const labels = { ready: 'Bot activo', connected: 'Conectado', connecting: 'Conectando...', disconnected: 'Desconectado' };
  const cls    = { ready: 'dot--green', connected: 'dot--blue', connecting: 'dot--yellow dot--pulse', disconnected: 'dot--red' };
  return (
    <div className="connection-badge">
      <span className={`dot ${cls[status] || 'dot--yellow dot--pulse'}`} />
      <span>{labels[status] || 'Conectando...'}</span>
    </div>
  );
}

function StatPill({ label, value, color }) {
  return (
    <div className="stat-pill">
      <span className="stat-pill__value" style={{ color }}>{value}</span>
      <span className="stat-pill__label">{label}</span>
    </div>
  );
}

function BotSwitch({ activo, onChange }) {
  return (
    <button
      onClick={() => onChange(!activo)}
      className={`bot-switch ${activo ? 'bot-switch--on' : 'bot-switch--off'}`}
      title={activo ? 'Bot activo — clic para desactivar' : 'Bot inactivo — clic para activar'}
    >
      <span className="bot-switch__track">
        <span className="bot-switch__thumb" />
      </span>
      <span>{activo ? 'Bot activo' : 'Bot inactivo'}</span>
    </button>
  );
}

function ModeToggle({ mode, onToggle }) {
  const isManual = mode === 'manual';
  return (
    <button onClick={onToggle} className={`mode-toggle ${isManual ? 'mode-toggle--manual' : 'mode-toggle--auto'}`}>
      <span className={`mode-toggle__dot ${isManual ? 'mode-toggle__dot--on' : ''}`} />
      {isManual ? 'Manual' : 'Automático'}
    </button>
  );
}

function MessageBubble({ msg, contactName, onReact }) {
  const [showReactions, setShowReactions] = useState(false);
  const isUser = msg.from_user;
  const isBot  = msg.is_bot;
  
  // Custom display mapper for bot/agent
  const cls = isUser ? 'message message--in' : 'message message--out';
  const sender = isUser ? (contactName) : isBot ? 'Bot' : 'Agente';

  return (
    <div 
      style={{ display: 'flex', flexDirection: 'column', width: '100%', marginBottom: '8px' }}
      onMouseLeave={() => setShowReactions(false)}
    >
      <span style={{ 
        alignSelf: isUser ? 'flex-start' : 'flex-end', 
        fontSize: '11px', color: 'var(--text-tertiary)', 
        marginBottom: '6px', fontWeight: 'bold', letterSpacing: '0.5px' 
      }}>
        {sender}
      </span>
      
      <div style={{ display: 'flex', flexDirection: isUser ? 'row' : 'row-reverse', alignItems: 'center', gap: '8px' }}>
        <div className={cls}>
          {msg.media && <MediaRenderer media={msg.media} />}
          {msg.body && <p style={{ margin: 0, wordBreak: 'break-word', whiteSpace: 'pre-wrap' }}>{msg.body}</p>}
          <span className="message__time">{formatTime(msg.timestamp)}</span>
          {msg.reaction && <span style={{ position: 'absolute', bottom: '-10px', left: isUser ? 'auto' : '-10px', right: isUser ? '-10px' : 'auto', background: 'var(--bg-panel)', padding: '2px 6px', borderRadius: '10px', fontSize: '12px', border: '1px solid var(--border-light)' }}>{msg.reaction}</span>}
        </div>

        {msg.waMessageId && onReact && (
          <div style={{ position: 'relative' }}>
            <button
              onClick={() => setShowReactions(p => !p)}
              style={{ background: 'transparent', border: 'none', cursor: 'pointer', opacity: 0.5, fontSize: '16px' }}
              title="Reaccionar"
            >
              ☺
            </button>
            {showReactions && (
              <div style={{ position: 'absolute', top: '-40px', left: isUser ? '20px' : 'auto', right: isUser ? 'auto' : '20px', background: 'var(--bg-panel)', padding: '4px', borderRadius: '20px', display: 'flex', gap: '4px', border: '1px solid var(--border-light)', backdropFilter: 'blur(10px)', zIndex: 10 }}>
                {QUICK_REACTIONS.map(e => (
                  <button
                    key={e}
                    onClick={() => { onReact(msg.waMessageId, e); setShowReactions(false); }}
                    style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '18px', padding: '4px' }}
                  >
                    {e}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const PRIORITY_BORDER = { Alta: '#ff4d6d', Media: '#f5c542', Baja: '#00e87a' };

// ─────────────────────────────────────────────
// Media renderer
// ─────────────────────────────────────────────
function MediaRenderer({ media }) {
  if (!media?.data) return null;
  const src  = `data:${media.mimetype};base64,${media.data}`;
  const type = media.mimetype?.split('/')[0];
  if (type === 'image') {
    return (
      <img
        src={src}
        className="media-img"
        alt={media.filename || 'imagen'}
        onClick={() => window.open(src, '_blank')}
      />
    );
  }
  if (type === 'video') return <video src={src} className="media-video" controls />;
  if (type === 'audio') return <audio src={src} className="media-audio" controls />;
  return (
    <a href={src} download={media.filename || 'archivo'} className="media-file">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
        <path strokeLinecap="round" strokeLinejoin="round"
          d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a1 1 0 001 1h16a1 1 0 001-1v-3" />
      </svg>
      {media.filename || 'Descargar archivo'}
    </a>
  );
}

// ─────────────────────────────────────────────
// Emoji picker
// ─────────────────────────────────────────────
const EMOJI_LIST = [
  '😀','😃','😄','😁','😆','😅','🤣','😊','😇','🙂','😉','😌','😍','🥰','😘','😋','😛','😜','🤪','😎',
  '😢','😮','😲','😱','🤔','🤨','😑','😶','😏','😒','🙄','😬','😴','🤒','😷','🤕','🥴','😵','🥺','😭',
  '👍','👎','👌','✌️','🤞','🤙','👏','🙌','🤝','🙏','✊','👊','💪','🫶','❤️','🔥','⭐','✅','⚠️','🎉',
  '🎊','🚀','💡','📌','📋','📞','📧','🔧','⚙️','💻','📱','🔑','💬','🗣️','📊','🛠️','🔔','📂','🗂️','🔍',
];

function QuickEmojiGrid({ onSelect }) {
  return (
    <div className="emoji-picker">
      {EMOJI_LIST.map(e => (
        <button key={e} className="emoji-btn" onClick={() => onSelect(e)}>{e}</button>
      ))}
    </div>
  );
}

function QuickRepliesMenu({ replies, onSelect, onAdd, onDelete }) {
  const [newTitle, setNewTitle] = useState('');
  const [newText, setNewText] = useState('');
  const [isAdding, setIsAdding] = useState(false);

  return (
    <div className="quick-replies-overlay">
      <div className="quick-replies-header">
        <h4 style={{ margin: 0, fontWeight: 600, color: 'var(--neon-cyan)', fontSize: '13px' }}>Respuestas Rápidas</h4>
        <button onClick={() => setIsAdding(a => !a)} className="qr-icon-btn" title="Nueva plantilla">
          <Plus size={16} />
        </button>
      </div>

      {isAdding && (
        <div className="quick-replies-add-form">
          <input
            placeholder="Título (ej: Bienvenida)"
            value={newTitle}
            onChange={e => setNewTitle(e.target.value)}
          />
          <textarea
            placeholder="Texto del mensaje..."
            value={newText}
            onChange={e => setNewText(e.target.value)}
            rows={3}
          />
          <button
            disabled={!newTitle.trim() || !newText.trim()}
            onClick={() => {
              onAdd({ title: newTitle.trim(), text: newText.trim() });
              setIsAdding(false);
              setNewTitle('');
              setNewText('');
            }}
          >
            Guardar Plantilla
          </button>
        </div>
      )}

      <div className="quick-replies-list">
        {replies.length === 0 && (
          <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '16px', margin: 0 }}>
            No hay plantillas. Presiona + para crear una.
          </p>
        )}
        {replies.map(r => (
          <div key={r.id} className="quick-reply-item">
            <div className="qr-body" onClick={() => onSelect(r.text)}>
              <strong>{r.title}</strong>
              <p>{r.text.length > 60 ? r.text.substring(0, 60) + '...' : r.text}</p>
            </div>
            <button className="qr-delete" onClick={(e) => { e.stopPropagation(); onDelete(r.id); }} title="Eliminar">
              <X size={14} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

const QUICK_REACTIONS = ['👍','❤️','😂','😮','😢','🙏'];

function ContactCard({ contact, isSelected, mode, isSilenced, unread, onClick }) {
  const { contactTags, customNames } = useAppStore();
  const contactId = contact.contactKey || contact.chatId;
  const tag = contactTags[contactId];
  const customName = customNames[contactId];
  const cName = customName || contact.nombre_analista || (contact.chatId || contact.telefono || '').replace(/@c\.us|@lid/g, '') || 'Sin nombre';
  const p           = PRIORITY_MAP[contact.prioridad];
  const borderColor = PRIORITY_BORDER[contact.prioridad];
  const hasUnread   = unread > 0;

  return (
    <div
      className={`contact-card ${isSelected ? 'contact-card--selected' : ''} ${hasUnread ? 'contact-card--unread' : ''} ${contact.status === 'closed' ? 'contact-card--closed' : ''}`}
      style={borderColor ? { borderLeft: `3px solid ${borderColor}` } : {}}
      onClick={onClick}
    >
      <div className="contact-card__avatar">
        <Avatar name={cName} size="sm" />
        {hasUnread && <span className="unread-badge">{unread > 9 ? '9+' : unread}</span>}
      </div>
      <div className="contact-card__body">
        <div className="contact-card__row">
          <span className="contact-card__name">
            {contact.nombre_empresa && cName !== contact.nombre_empresa
                ? `${cName} (${contact.nombre_empresa})`
                : cName}
          </span>
          <span className="contact-card__time">{formatTime(contact.lastTimestamp)}</span>
        </div>
        <p className="contact-card__preview">{contact.lastMessage || 'Sin mensajes'}</p>
        <div className="contact-card__tags">
          {p && <span className={`priority-badge ${p.cls}`}>{p.label}</span>}
          <span className="tag tag--area">{contact.area?.name || 'Sin área'}</span>
          <span className={`tag tag--sla-${contact.sla?.state || 'none'}`}>{slaLabel(contact.sla)}</span>
          <span className={`tag ${contact.assignment?.analyst_id ? 'tag--assigned' : 'tag--unassigned'}`}>{assignmentLabel(contact)}</span>
          {tag === 'proveedor' && <span className="tag tag--proveedor">🛡️ PROV</span>}
          {tag === 'cliente_vip' && <span className="tag tag--vip">⭐ VIP</span>}
          {mode === 'manual'  && <span className="tag tag--manual">Manual</span>}
          {isSilenced         && <span className="tag tag--silenced">Silenciado</span>}
        </div>
      </div>
    </div>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <div className="empty-state__icon pulse">
        <MessageCircle size={56} strokeWidth={1.5} />
      </div>
      <h2 className="empty-state__title">NEXO AI Hub</h2>
      <p className="empty-state__sub">Entorno seguro. En espera de nuevas conversaciones en tiempo real.</p>
    </div>
  );
}

function DetailRow({ label, value, mono = false, colorClass = '', onEdit }) {
  if (!value && !onEdit) return null;
  return (
    <div className="detail-row">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
        <p className="detail-row__label" style={{ margin: 0 }}>{label}</p>
        {onEdit && (
          <button onClick={onEdit} style={{ background: 'transparent', border: 'none', color: 'var(--neon-cyan)', cursor: 'pointer', padding: 0 }} title="Editar Nombre">
            <Edit2 size={12} />
          </button>
        )}
      </div>
      <p className={`detail-row__value ${mono ? 'detail-row__value--mono' : ''} ${colorClass}`}>{value || '—'}</p>
    </div>
  );
}

// ─────────────────────────────────────────────
// App principal
// ─────────────────────────────────────────────
export default function App() {
  const {
    qrDataUrl, setQrDataUrl,
    qrCountdown, setQrCountdown,
    showQR, setShowQR,
    contacts, setContacts,
    chatMessages, setChatMessages,
    selectedId, setSelectedId,
    chatModes, setChatModes,
    silenced, setSilenced,
    botStatus, setBotStatus,
    botActivo, setBotActivo,
    newMessage, setNewMessage,
    filter, setFilter,
    search, setSearch,
    unread, setUnread,
    showEmojiPicker, setShowEmojiPicker,
    pendingMedia, setPendingMedia,
    authMode, setAuthMode,
    pairingPhone, setPairingPhone,
    pairingCode, setPairingCode,
    pairingError, setPairingError,
    pairingLoading, setPairingLoading,
    contactTags, setContactTag,
    customNames, setCustomName,
    quickReplies, setQuickReplies
  } = useAppStore();

  const qrTimerRef = useRef(null);
  const messagesEndRef  = useRef(null);
  const inputRef        = useRef(null);
  const fileInputRef    = useRef(null);
  const selectedIdRef   = useRef(selectedId);

  const [isSummarizing, setIsSummarizing] = useState(false);
  const [chatSummaries, setChatSummaries] = useState({});
  const [isImprovingText, setIsImprovingText] = useState(false);
  const [isDetailOpen, setIsDetailOpen] = useState(false);
  const [showQuickReplies, setShowQuickReplies] = useState(false);

  // Layout View Tabs
  const [currentView, setCurrentView] = useState('chats');
  const [stats, setStats] = useState(null);
  const [systemInfo, setSystemInfo] = useState(null);
  const [logs, setLogs] = useState([]);
  const [logsLoading, setLogsLoading] = useState(false);
  const [principal, setPrincipal] = useState(null);

  // Salesforce Modal
  const [sfModal, setSfModal] = useState({ open: false, ticket: null });

  // Keep ref in sync so socket handlers always see the current selectedId
  useEffect(() => { selectedIdRef.current = selectedId; }, [selectedId]);

  const selectedContact  = contacts[selectedId];
  const selectedChatId   = selectedContact?.chatId || selectedContact?.telefono;
  const headerName       = customNames[selectedId] || selectedContact?.nombre_analista || (selectedChatId || '').replace(/@c\.us|@lid/g, '') || selectedChatId;

  const tag = contactTags[selectedId];
  const handleSetTag = (newTag) => {
    setContactTag(selectedId, newTag === tag ? null : newTag);
    if (newTag !== tag && newTag) {
      socket.emit('toggle-mode', { chatId: selectedChatId, mode: 'manual' });
    }
  };

  const selectedMessages = chatMessages[selectedId] || [];

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [selectedMessages.length]);

  const [tokenInput, setTokenInput] = useState('');
  const [authError, setAuthError] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(!!localStorage.getItem('nexo_token'));

  const handleLogout = () => {
    localStorage.removeItem('nexo_token');
    setIsAuthenticated(false);
    setSystemInfo(null);
    socket.disconnect();
  };

  const handleLogin = (e) => {
    e.preventDefault();
    if (!tokenInput.trim()) return;
    localStorage.setItem('nexo_token', tokenInput.trim());
    setAuthError(null);
    setIsAuthenticated(true);
  };

  // Socket setup — runs when authenticated
  useEffect(() => {
    if (!isAuthenticated) {
      socket.disconnect();
      return;
    }

    socket.connect();

    socket.on('connect',    () => setBotStatus('connected'));
    socket.on('disconnect', () => setBotStatus('disconnected'));
    
    socket.on('connect_error', (err) => {
      console.error('Socket connection error:', err.message);
      setAuthError('Acceso denegado: Token inválido o revocado.');
      handleLogout();
    });

    socket.on('bot-status', ({ status }) => {
      setBotStatus(status);
      if (status === 'ready') {
        setQrDataUrl(null);
        clearInterval(qrTimerRef.current);
      }
    });
    socket.on('qr', async ({ qr, expiresIn }) => {
      const url = await QRCode.toDataURL(qr, { width: 280, margin: 2, color: { dark: '#ffffff', light: '#0d0d17' } });
      setQrDataUrl(url);
      setQrCountdown(expiresIn);

      clearInterval(qrTimerRef.current);
      qrTimerRef.current = setInterval(() => {
        setQrCountdown(prev => {
          if (prev <= 1) { clearInterval(qrTimerRef.current); return 0; }
          return prev - 1;
        });
      }, 1000);
    });

    socket.on('bot-activo', (valor) => setBotActivo(valor));
    socket.on('principal-info', (info) => setPrincipal(info));

    socket.on('qr-cleared', () => {
      setQrDataUrl(null);
      setQrCountdown(0);
      setPairingCode(null);
      setPairingError(null);
      setPairingLoading(false);
      setAuthMode('qr');
      clearInterval(qrTimerRef.current);
    });

    socket.on('pairing-code', ({ code }) => {
      setPairingCode(code);
      setPairingError(null);
      setPairingLoading(false);
    });

    socket.on('pairing-code-error', ({ message }) => {
      setPairingError(message);
      setPairingCode(null);
      setPairingLoading(false);
    });

    socket.on('tickets-list', (list) => {
      setContacts(prev => {
        const next = { ...prev };
        list.forEach(t => {
          if (!t.telefono) return;
          const key = String(t.id);
          next[key] = {
            ...t,
            chatId:      t.telefono,
            contactKey:  key,
            lastMessage:   prev[key]?.lastMessage || t.situacion || '',
            lastTimestamp: prev[key]?.lastTimestamp || t.created_at,
          };
        });
        return next;
      });

      // Restaurar mensajes del chat seleccionado al recargar
      const savedId = localStorage.getItem('nexo_selected_id');
      if (savedId) {
        const ticket = list.find(t => String(t.id) === savedId);
        if (ticket) {
          socket.emit('get-messages', ticket.id);
        }
      }
    });

    socket.on('system-info', (info) => {
      setSystemInfo(info);
    });

    socket.on('ticket-created', (ticket) => {
      const key = String(ticket.id);
      setContacts(prev => {
        const next = { ...prev };
        // Migrar entrada pre-ticket (keyed by chatId) al nuevo ticketId
        const old = next[ticket.telefono] || {};
        delete next[ticket.telefono];
        next[key] = {
          ...ticket,
          chatId:        ticket.telefono,
          contactKey:    key,
          lastTimestamp: ticket.created_at || old.lastTimestamp,
          lastMessage:   old.lastMessage || ticket.situacion || '',
        };
        return next;
      });
      // Migrar mensajes pre-ticket al nuevo key
      setChatMessages(prev => {
        const old = prev[ticket.telefono] || [];
        if (!old.length && !prev[key]) return prev;
        const next = { ...prev };
        delete next[ticket.telefono];
        next[key] = [...old, ...(next[key] || [])];
        return next;
      });
      // Si estaba viendo la conversación pre-ticket, redirigir al nuevo key
      setSelectedId(prev => prev === ticket.telefono ? key : prev);
    });

    socket.on('new-message', ({ chatId, message, from_user, is_bot, timestamp, ticketId, media, waMessageId }) => {
      const newMsg     = { body: message, from_user, is_bot, timestamp, media: media || null, waMessageId: waMessageId || null };
      const contactKey = ticketId ? String(ticketId) : chatId;

      setChatMessages(prev => ({
        ...prev,
        [contactKey]: [...(prev[contactKey] || []), newMsg]
      }));

      setContacts(prev => ({
        ...prev,
        [contactKey]: {
          ...(prev[contactKey] || { chatId, contactKey }),
          chatId,
          contactKey,
          lastMessage:   message,
          lastTimestamp: timestamp,
        }
      }));

      if (from_user) {
        setUnread(prev => {
          if (contactKey === selectedIdRef.current) return prev;
          return { ...prev, [contactKey]: (prev[contactKey] || 0) + 1 };
        });
      }
    });

    socket.on('messages-list', (msgs) => {
      const id = selectedIdRef.current;
      if (id) setChatMessages(prev => ({ ...prev, [id]: Array.isArray(msgs) ? msgs : [] }));
    });

    socket.on('message-reaction', ({ waMessageId, emoji }) => {
      setChatMessages(prev => {
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          next[id] = next[id].map(m => m.waMessageId === waMessageId ? { ...m, reaction: emoji } : m);
        }
        return next;
      });
    });

    const mergeTicket = (ticket) => {
      if (!ticket?.id) return;
      const key = String(ticket.id);
      setContacts(prev => ({
        ...prev,
        [key]: {
          ...(prev[key] || {}),
          ...ticket,
          chatId: ticket.telefono || prev[key]?.chatId,
          contactKey: key,
          lastTimestamp: prev[key]?.lastTimestamp || ticket.created_at,
          lastMessage: prev[key]?.lastMessage || ticket.situacion || '',
        },
      }));
    };

    socket.on('ticket-assigned', mergeTicket);
    socket.on('queue-updated', ({ ticket }) => mergeTicket(ticket));
    socket.on('sla-alert', ({ ticketId, sla }) => {
      const key = String(ticketId);
      setContacts(prev => prev[key] ? { ...prev, [key]: { ...prev[key], sla } } : prev);
    });

    socket.on('mode-changed',    ({ chatId, mode }) => setChatModes(prev => ({ ...prev, [chatId]: mode })));
    socket.on('chat-silenced',   ({ chatId }) => setSilenced(prev => ({ ...prev, [chatId]: true })));
    socket.on('chat-unsilenced', ({ chatId }) => setSilenced(prev => { const n = { ...prev }; delete n[chatId]; return n; }));
    socket.on('ticket-closed',   ({ ticketId }) => {
      const key = String(ticketId);
      setContacts(prev => {
        if (!prev[key]) return prev;
        return { ...prev, [key]: { ...prev[key], status: 'closed' } };
      });
    });

    socket.on('summary-ready', ({ ticketId, resumen }) => {
      setChatSummaries(prev => ({ ...prev, [ticketId]: resumen }));
      setIsSummarizing(false);
    });
    socket.on('summary-error', () => {
      setIsSummarizing(false);
      alert('Error al generar resumen con IA.');
    });
    socket.on('grammar-ready', ({ improved }) => {
      setNewMessage(improved);
      setIsImprovingText(false);
    });

    socket.on('chat-deleted', ({ contactKey }) => {
      setContacts(prev => { const next = { ...prev }; delete next[contactKey]; return next; });
      setChatMessages(prev => { const next = { ...prev }; delete next[contactKey]; return next; });
      setSelectedId(prev => prev === contactKey ? null : prev);
    });

    socket.on('sf-case-created', ({ contactKey, sf_case_id, sf_case_number }) => {
      setContacts(prev => ({
        ...prev,
        [contactKey]: {
          ...prev[contactKey],
          sf_case_id,
          sf_case_number,
        }
      }));
    });

    socket.on('stats-data', (data) => {
      setStats(data);
    });

    socket.emit('get-tickets');

    return () => {
      socket.removeAllListeners();
      clearInterval(qrTimerRef.current);
    };
  }, [isAuthenticated]);

  const selectContact = useCallback((contactKey) => {
    setSelectedId(contactKey);
    setUnread(prev => { const n = { ...prev }; delete n[contactKey]; return n; });
    const c = contacts[contactKey];
    if (c?.id) socket.emit('get-messages', c.id);
    setTimeout(() => inputRef.current?.focus(), 50);
  }, [contacts]);

  const sendMessage = useCallback(() => {
    if (!selectedId || !selectedContact) return;
    if (!newMessage.trim() && !pendingMedia) return;
    socket.emit('send-message', {
      chatId:   selectedContact.chatId || selectedContact.telefono,
      message:  newMessage.trim(),
      ticketId: selectedContact.id || null,
      media:    pendingMedia ? { data: pendingMedia.data, mimetype: pendingMedia.mimetype, filename: pendingMedia.filename } : null,
    });
    setNewMessage('');
    setPendingMedia(null);
    setShowEmojiPicker(false);
  }, [newMessage, selectedId, selectedContact, pendingMedia]);

  const handleFileSelect = useCallback((e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (ev) => {
      const dataUrl = ev.target.result;
      const base64  = dataUrl.split(',')[1];
      const type    = file.type.split('/')[0];
      setPendingMedia({ data: base64, mimetype: file.type, filename: file.name, type, preview: type === 'image' ? dataUrl : null });
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  }, []);

  const insertEmoji = useCallback((emoji) => {
    setNewMessage(prev => prev + emoji);
    setShowEmojiPicker(false);
    inputRef.current?.focus();
  }, []);

  const insertQuickReply = useCallback((text) => {
    setNewMessage(text);
    setShowQuickReplies(false);
    inputRef.current?.focus();
    setTimeout(() => {
      if (inputRef.current) {
        inputRef.current.style.height = 'auto';
        inputRef.current.style.height = Math.min(inputRef.current.scrollHeight, 120) + 'px';
      }
    }, 10);
  }, []);

  const handleAddQuickReply = useCallback((data) => {
    setQuickReplies([...quickReplies, { ...data, id: Date.now().toString() }]);
  }, [quickReplies, setQuickReplies]);

  const handleDeleteQuickReply = useCallback((id) => {
    setQuickReplies(quickReplies.filter(r => r.id !== id));
  }, [quickReplies, setQuickReplies]);

  const loadLogs = useCallback(async () => {
    setLogsLoading(true);
    setCurrentView('logs');
    try {
      const data = await apiRequest('/api/logs');
      setLogs(data.reverse());
    } catch(e) {
      setLogs([{ ts: new Date().toISOString(), type: 'ERROR', msg: 'No se pudo conectar al API de logs: ' + e.message }]);
    } finally {
      setLogsLoading(false);
    }
  }, []);

  const sendReaction = useCallback((waMessageId, emoji) => {
    socket.emit('react-message', { waMessageId, emoji });
  }, []);

  const buildExportText = useCallback(() => {
    if (!selectedContact) return '';
    const lines = [];
    const sep = '═'.repeat(48);
    lines.push(sep);
    lines.push('TICKET NEXO' + (selectedContact.id ? ` #${String(selectedContact.id).slice(0,8).toUpperCase()}` : ''));
    lines.push(`Fecha: ${new Date().toLocaleString('es-CO')}`);
    lines.push(sep);
    lines.push('');
    lines.push('DATOS DEL CONTACTO');
    lines.push('─'.repeat(32));
    if (selectedContact.nombre_analista) lines.push(`Nombre:   ${selectedContact.nombre_analista}`);
    if (selectedContact.nombre_empresa)  lines.push(`Empresa:  ${selectedContact.nombre_empresa}`);
    if (selectedContact.correo)          lines.push(`Correo:   ${selectedContact.correo}`);
    const phone = selectedContact.chatId || selectedContact.telefono;
    if (phone) lines.push(`Teléfono: ${phone.replace('@c.us', '')}`);
    if (selectedContact.prioridad)       lines.push(`Prioridad: ${selectedContact.prioridad}`);
    lines.push('');
    if (selectedContact.situacion) {
      lines.push('DESCRIPCIÓN DEL REQUERIMIENTO');
      lines.push('─'.repeat(32));
      lines.push(selectedContact.situacion);
      lines.push('');
    }
    if (selectedMessages.length > 0) {
      lines.push('HISTORIAL DE CONVERSACIÓN');
      lines.push('─'.repeat(32));
      selectedMessages.forEach(msg => {
        const time   = new Date(msg.timestamp).toLocaleTimeString('es-CO', { hour: '2-digit', minute: '2-digit' });
        const origen = msg.from_user ? 'Cliente' : msg.is_bot ? 'Bot' : 'Agente';
        lines.push(`[${time}] ${origen}: ${msg.body}`);
      });
      lines.push('');
    }
    lines.push(sep);
    return lines.join('\n');
  }, [selectedContact, selectedMessages]);

  const copyToClipboard = useCallback(async () => {
    const text = buildExportText();
    await navigator.clipboard.writeText(text);
  }, [buildExportText]);

  const downloadTxt = useCallback(() => {
    const text = buildExportText();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    const name = selectedContact?.nombre_empresa?.replace(/\s+/g, '_') || 'ticket';
    a.href     = url;
    a.download = `NEXO_${name}_${new Date().toISOString().slice(0,10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }, [buildExportText, selectedContact]);

  const toggleMode = (contactKey) => {
    const c      = contacts[contactKey];
    const chatId = c?.chatId || c?.telefono || contactKey;
    const next   = chatModes[chatId] === 'manual' ? 'auto' : 'manual';
    socket.emit('toggle-mode', { chatId, mode: next });
  };

  const loadStats = () => {
    setCurrentView('metrics');
    socket.emit('get-stats');
    socket.emit('get-system-info');
  };

  const closeTicket = (ticketId) => {
      if (window.confirm('¿Cerrar este ticket? Esta acción no se puede deshacer.')) {
        socket.emit('close-ticket', ticketId);
      }
    };
  
    const deleteChat = (contactKey) => {
      if (window.confirm('🚨 ¿Estás seguro de eliminar este chat/ticket permanentemente? Esta acción destruirá todos los registros asociados en la base de datos y no se puede deshacer.')) {
        const ticketId = contacts[contactKey]?.id || null;
        socket.emit('delete-chat', { contactKey, ticketId });
        setContacts(prev => { const next = { ...prev }; delete next[contactKey]; return next; });
        setChatMessages(prev => { const next = { ...prev }; delete next[contactKey]; return next; });
        if (selectedId === contactKey) setSelectedId(null);
      }
    };
  
    const redirectSupport = (contactKey) => {
      if (window.confirm('¿Deseas dar este caso por no correspondiente y enviarlo a soporte general? Se enviará un mensaje al usuario y el chat se finalizará.')) {
        const ticketId = contacts[contactKey]?.id || null;
        socket.emit('redirect-support', { contactKey, ticketId });
      }
    };

    const requestSummary = useCallback((ticketId) => {
      setIsSummarizing(true);
      socket.emit('request-summary', ticketId);
    }, []);
  
    const improveGrammar = useCallback(() => {
      if (!newMessage.trim()) return;
      setIsImprovingText(true);
      socket.emit('request-grammar', { text: newMessage, callbackId: Date.now() });
    }, [newMessage]);

  // Stats
  const allContacts   = Object.values(contacts);
  const openCount     = allContacts.filter(c => c.status !== 'closed').length;
  const highCount     = allContacts.filter(c => c.prioridad === 'Alta' && c.status !== 'closed').length;
  const manualCount   = allContacts.filter(c => chatModes[c.chatId] === 'manual' && c.status !== 'closed').length;
  const myAnalystId   = principal?.analyst?.id;

  // Filter + search
  const visibleContacts = allContacts
    .filter(c => {
      if (filter === 'all')      return c.status !== 'closed';
      if (filter === 'alta')     return c.prioridad === 'Alta'           && c.status !== 'closed';
      if (filter === 'manual')   return chatModes[c.chatId] === 'manual' && c.status !== 'closed';
      if (filter === 'mine')     return String(c.assignment?.analyst_id || '') === String(myAnalystId || '') && c.status !== 'closed';
      if (filter === 'unassigned') return !c.assignment?.analyst_id      && c.status !== 'closed';
      if (filter === 'sla')      return ['warning', 'breached'].includes(c.sla?.state) && c.status !== 'closed';
      if (filter === 'silenced') return silenced[c.chatId]               && c.status !== 'closed';
      if (filter === 'cerrados') return c.status === 'closed';
      return c.status !== 'closed'; // 'all' → solo activos
    })
    .filter(c => {
      if (!search) return true;
      const q = search.toLowerCase();
      return (
        c.nombre_analista?.toLowerCase().includes(q) ||
        c.nombre_empresa?.toLowerCase().includes(q)  ||
        c.chatId?.includes(q)
      );
    })
    .sort((a, b) => new Date(b.lastTimestamp || 0) - new Date(a.lastTimestamp || 0));

  const isManual   = chatModes[selectedChatId] === 'manual';
  const isSilenced = silenced[selectedChatId];

  if (!isAuthenticated) {
    return (
      <div className="login-container">
        <div className="login-card">
          <div className="login-logo">N</div>
          <h1 className="login-title">NEXO</h1>
          <p className="login-subtitle">Dashboard de Integraciones</p>
          
          <form onSubmit={handleLogin} className="login-form">
            <div className="login-input-group">
              <label className="login-label">Token de Acceso Corporativo</label>
              <input
                type="password"
                className="login-input"
                placeholder="Introduce tu token nexo_tkn_..."
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                required
              />
            </div>
            
            {authError && <div className="login-error-msg">{authError}</div>}
            
            <button type="submit" className="login-submit-btn">
              Verificar Credenciales
            </button>
          </form>
          
          <div className="login-footer">
            Área protegida de Magneto365. Acceso auditado.
          </div>
        </div>
      </div>
    );
  }

  if (window.location.pathname === '/admin') {
    return <AdminPanel socket={socket} onLogout={handleLogout} />;
  }

  return (
    <div className="layout">

      {/* ── Header ─────────────────────────────── */}
      <header className="topbar">
        <div className="topbar__brand">
          <div className="topbar__logo">N</div>
          <span className="topbar__name">NEXO</span>
          <span className="topbar__sub">by Magneto365</span>
        </div>
        <div className="topbar__right">
          <div className="stats-row">
            <StatPill label="Abiertos"   value={openCount}   color="var(--blue)" />
            <StatPill label="Alta Prior." value={highCount}   color="var(--red)" />
            <StatPill label="Manuales"   value={manualCount} color="var(--yellow)" />
          </div>
          <BotSwitch activo={botActivo} onChange={(v) => socket.emit('set-bot-activo', v)} />

          {botStatus === 'ready' ? (
            <button
              className="action-btn action-btn--danger"
              onClick={() => {
                if (window.confirm('¿Cerrar sesión de WhatsApp y conectar otra cuenta?')) {
                  setQrDataUrl(null);
                  setQrCountdown(0);
                  setAuthMode('qr');
                  setPairingCode(null);
                  setShowQR(true);
                  socket.emit('logout');
                }
              }}
            >
              <ShieldCheck size={18} />
              Cambiar cuenta
            </button>
          ) : (
            <button className="action-btn action-btn--primary" onClick={() => setShowQR(true)}>
              <QrCode size={18} />
              Conectar WhatsApp
              {qrCountdown > 0 && qrCountdown <= 5 && <span style={{ width: 8, height: 8, background: 'var(--danger)', borderRadius: '50%', boxShadow: '0 0 10px var(--danger)' }} />}
            </button>
          )}
          <ConnectionDot status={botStatus} />
          <button 
            className="action-btn action-btn--secondary" 
            onClick={handleLogout}
            title="Cerrar sesión del Dashboard"
            style={{ marginLeft: '8px', padding: '6px 12px', height: '36px' }}
          >
            Salir
          </button>
        </div>
      </header>

      <div className="workspace">

        {/* ── Sidebar ────────────────────────────── */}
        <aside className="sidebar">

          {/* Navegación Principal */}
          <div className="sidebar-nav">
            <button
              onClick={() => setCurrentView('chats')}
              className={`sidebar-nav__btn ${currentView === 'chats' ? 'sidebar-nav__btn--active' : ''}`}
            >
              <MessageSquare size={16} /> Chats
            </button>
            <button
              onClick={loadStats}
              className={`sidebar-nav__btn ${currentView === 'metrics' ? 'sidebar-nav__btn--active' : ''}`}
            >
              <LayoutDashboard size={16} /> Métricas
            </button>
            <button
              onClick={loadLogs}
              className={`sidebar-nav__btn ${currentView === 'logs' ? 'sidebar-nav__btn--active' : ''}`}
            >
              <Terminal size={16} /> Logs
            </button>
          </div>

          {currentView === 'chats' && (
            <>
              {/* Búsqueda */}
              <div className="sidebar__search">
                <Search size={18} className="sidebar__search-icon" />
                <input
                  type="text"
                  placeholder="Buscar contacto..."
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  className="sidebar__search-input"
                />
              </div>

              {/* Filtros */}
              <div className="filter-tabs">
                {[
                  ['all','Activos'],
                  ['mine','Asignados a mí'],
                  ['unassigned','Sin asignar'],
                  ['sla','SLA crítico'],
                  ['alta','Alta'],
                  ['manual','Manual'],
                  ['silenced','Silenc.'],
                  ['cerrados','Cerrados'],
                ].map(([id, label]) => (
                  <button
                    key={id}
                    onClick={() => setFilter(id)}
                    className={`filter-tab ${filter === id ? 'filter-tab--active' : ''}`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Lista de contactos */}
              <div className="contact-list">
                {visibleContacts.length === 0 ? (
                  <div className="contact-list__empty">
                    <Inbox size={48} strokeWidth={1} style={{ opacity: 0.3 }} />
                    <p>Bandeja Segura Vacía</p>
                  </div>
                ) : (
                  visibleContacts.map(c => (
                    <ContactCard
                      key={c.contactKey || c.chatId}
                      contact={c}
                      isSelected={selectedId === (c.contactKey || c.chatId)}
                      mode={chatModes[c.chatId]}
                      isSilenced={silenced[c.chatId]}
                      unread={unread[c.contactKey || c.chatId] || 0}
                      onClick={() => selectContact(c.contactKey || c.chatId)}
                    />
                  ))
                )}
              </div>
            </>
          )}
        </aside>

        {currentView === 'logs' ? (
          <main className="chat-area logs-view" style={{ flex: 1, padding: '32px', overflowY: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
              <div>
                <h2 className="empty-state__title" style={{ textAlign: 'left', margin: 0 }}>📋 Logs del Sistema</h2>
                <p className="empty-state__desc" style={{ textAlign: 'left', margin: '8px 0 0 0' }}>Registros en tiempo real del backend y el bot de WhatsApp.</p>
              </div>
              <button onClick={loadLogs} className="action-btn action-btn--glass" title="Actualizar logs" style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
                <RefreshCw size={16} /> Actualizar
              </button>
            </div>
            {logsLoading ? (
              <div className="qr-loading" style={{ height: '50vh' }}>
                <div className="qr-loading__spinner" />
                <p style={{ marginTop: 20 }}>Cargando registros...</p>
              </div>
            ) : (
              <div className="logs-terminal">
                {logs.length === 0 && <p style={{ color: 'var(--text-tertiary)', padding: '20px' }}>No hay registros disponibles aún.</p>}
                {logs.map((log, i) => (
                  <div key={i} className={`log-entry log-entry--${log.type.toLowerCase()}`}>
                    <span className="log-ts">{new Date(log.ts).toLocaleTimeString('es-CO')}</span>
                    <span className={`log-badge log-badge--${log.type.toLowerCase()}`}>{log.type}</span>
                    <span className="log-msg">{log.msg}</span>
                  </div>
                ))}
              </div>
            )}
          </main>
        ) : currentView === 'metrics' ? (
          <main className="chat-area" style={{ flex: 1, padding: '48px', overflowY: 'auto' }}>
            <h2 className="empty-state__title" style={{ textAlign: 'left', margin: 0 }}>Dashboard Analítico</h2>
            <p className="empty-state__desc" style={{ textAlign: 'left', marginBottom: '40px', marginTop: '12px' }}>Métricas en tiempo real, extraídas desde la arquitectura cero-latencia.</p>
            
            {!stats ? (
              <div className="qr-loading" style={{ height: '50vh' }}>
                <div className="qr-loading__spinner" />
                <p style={{ marginTop: 20 }}>Calculando clústeres de métricas...</p>
              </div>
            ) : (
              <>
                <div className="dashboard-grid">
                  <div className="dash-card">
                    <h3 className="detail-row__label">📋 Total Atenciones</h3>
                    <p style={{ fontSize: '48px', fontWeight: '800', fontFamily: 'Outfit', color: '#00f0ff' }}>{stats.total}</p>
                  </div>
                  
                  <div className="dash-card">
                    <h3 className="detail-row__label">🔥 Casos Activos</h3>
                    <p style={{ fontSize: '48px', fontWeight: '800', fontFamily: 'Outfit', color: '#ffb142' }}>{stats.open}</p>
                  </div>
                  
                  <div className="dash-card">
                    <h3 className="detail-row__label">✅ Casos Cerrados</h3>
                    <p style={{ fontSize: '48px', fontWeight: '800', fontFamily: 'Outfit', color: '#00fa9a' }}>{stats.closed}</p>
                  </div>
                  
                  <div className="dash-card">
                    <h3 className="detail-row__label">⏱️ Tiempo Medio Atención</h3>
                    <p style={{ fontSize: '48px', fontWeight: '800', fontFamily: 'Outfit', color: '#9d4edd' }}>{stats.tmaMins} <span style={{fontSize: '20px', fontWeight: 'normal', opacity: 0.5}}>min</span></p>
                    <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', marginTop: '8px' }}>Desde apertura hasta derivación/cierre</p>
                  </div>
                </div>
                
                <h2 className="empty-state__title" style={{ textAlign: 'left', margin: '48px 0 24px 0' }}>📡 Diagnóstico del Gateway</h2>
                <div className="system-status-panel">
                  {systemInfo ? (
                    <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '24px' }}>
                      <DetailRow label="Número Vinculado" value={`+${systemInfo.user}`} mono />
                      <DetailRow label="Nombre Dispositivo" value={systemInfo.pushname} />
                      <DetailRow label="Plataforma Cliente" value={systemInfo.platform?.toUpperCase() || 'WHATSAPP WEB'} />
                      <DetailRow label="Uptime de Sesión" value={systemInfo.connectedAt ? Math.floor((Date.now() - systemInfo.connectedAt) / 60000) + ' Minutos en línea' : 'Conectando...'} mono colorClass="text-success" />
                      <DetailRow label="Estado de Nodo" value={botStatus === 'ready' ? 'ÓPTIMO / EN LÍNEA' : 'DESCONECTADO'} colorClass={botStatus === 'ready' ? 'text-success' : 'text-danger'} />
                      <DetailRow label="Motor IA Automática" value={botActivo ? 'A LA ESCUCHA (ACTIVO)' : 'APAGADO'} colorClass={botActivo ? 'text-success' : 'text-danger'} />
                    </div>
                  ) : (
                    <p style={{ color: 'var(--text-secondary)' }}>Obteniendo datos del ecosistema base...</p>
                  )}
                </div>
              </>
            )}
          </main>
        ) : (
          <>
            {/* ── Chat principal ─────────────────────── */}
            <main className="chat-area">
              {selectedContact ? (
                <>
                  {/* ... Todo el interior del chat-area tal cual estaba ... */}
                  {/* Para no perder código y no reemplazar 200 líneas, insertaré el cierre más abajo */}

              {/* Chat header */}
              <div className="chat-header">
                <div className="chat-header__left">
                  <Avatar name={headerName} size="md" />
                  <div>
                    <h2 className="chat-header__name">
                      {headerName}
                    </h2>
                    <p className="chat-header__sub">
                      {selectedContact.nombre_empresa || selectedContact.chatId?.replace(/@c\.us|@lid/g, '')}
                    </p>
                  </div>
                  {selectedContact.prioridad && <PriorityBadge priority={selectedContact.prioridad} />}
                </div>
                <div className="chat-header__actions">
                  <div className="contact-tag-selector">
                    <button onClick={() => handleSetTag('proveedor')} className={`tag-btn ${tag === 'proveedor' ? 'tag-btn--active-prov' : ''}`} title="Proveedor (Ignora Bot)">🛡️ PROV</button>
                    <button onClick={() => handleSetTag('cliente_vip')} className={`tag-btn ${tag === 'cliente_vip' ? 'tag-btn--active-vip' : ''}`} title="Cliente VIP (Ignora Bot)">⭐ VIP</button>
                  </div>
                  
                  <button 
                    onClick={() => {
                      if(window.confirm('¿Deseas despertar e iniciar el bot conversacional de forma forzada para este cliente?')) {
                        socket.emit('force-bot', selectedChatId);
                      }
                    }} 
                    className="action-btn action-btn--icon" 
                    style={{ background: 'linear-gradient(135deg, var(--neon-cyan), var(--blue))', color: '#000', borderColor: 'transparent' }} 
                    title="Forzar inicio del Bot para este chat"
                  >
                    <Bot size={18} />
                  </button>

                  {/* Salesforce: Gestionar Caso */}
                  {selectedContact?.id && (
                    <button
                      onClick={() => setSfModal({ open: true, ticket: selectedContact })}
                      className="action-btn action-btn--icon"
                      style={{ background: 'linear-gradient(135deg, #1a9ef6, #0070d2)', color: '#fff', borderColor: 'transparent' }}
                      title="Gestionar en Salesforce"
                    >
                      ☁️
                    </button>
                  )}

                  <button onClick={() => setIsDetailOpen(p => !p)} className={`action-btn action-btn--icon ${isDetailOpen ? 'action-btn--primary' : 'action-btn--glass'}`} title="Ver Detalles del Perfil">
                    <Info size={18} />
                  </button>

                  <ModeToggle mode={chatModes[selectedChatId]} onToggle={() => toggleMode(selectedId)} />
                  
                  <button onClick={() => redirectSupport(selectedId)} className="action-btn action-btn--icon action-btn--warning" title="Derivar a soporte">
                    <CornerUpRight size={18} />
                  </button>

                  <button onClick={() => socket.emit(isSilenced ? 'unsilence-chat' : 'silence-chat', selectedChatId)} className="action-btn action-btn--icon action-btn--glass" title={isSilenced ? 'Activar notificaciones' : 'Silenciar chat'}>
                    {isSilenced ? <BellRing size={18} /> : <BellOff size={18} />}
                  </button>

                  {selectedContact.id && (
                    <button onClick={() => closeTicket(selectedContact.id)} className="action-btn action-btn--icon action-btn--success" title="Cerrar ticket">
                      <CheckCircle size={18} />
                    </button>
                  )}

                  <button onClick={() => deleteChat(selectedId)} className="action-btn action-btn--icon action-btn--danger" title="Eliminar registro">
                    <Trash2 size={18} />
                  </button>
                </div>
              </div>

              {/* Banner bot inactivo */}
              {!botActivo && (
                <div className="bot-inactive-banner">
                  <Bot size={18} />
                  Bot desactivado — los mensajes llegan pero no son contestados
                </div>
              )}

              {/* Mensajes */}
              <div className="messages-area">
                {selectedMessages.length === 0 && (
                  <div className="messages-area__empty">Sin mensajes aún</div>
                )}
                {selectedMessages.map((msg, i) => (
                  <MessageBubble key={msg.waMessageId || i} msg={msg} contactName={headerName} onReact={sendReaction} />
                ))}
                <div ref={messagesEndRef} />
              </div>

              {/* Input */}
              <div className="message-input-area">
                {isSilenced && (
                  <div className="input-notice input-notice--danger">
                    Chat silenciado — el bot no responderá automáticamente
                  </div>
                )}
                {!isManual && !isSilenced && (
                  <div className="input-notice input-notice--info">
                    Modo automático activo — activa Manual para responder
                  </div>
                )}

                {/* Preview de archivo pendiente */}
                {pendingMedia && (
                  <div className="pending-media-preview">
                    {pendingMedia.preview
                      ? <img src={pendingMedia.preview} className="pending-media-preview__img" alt="" />
                      : <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="28" height="28">
                          <path strokeLinecap="round" strokeLinejoin="round"
                            d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                        </svg>
                    }
                    <span className="pending-media-preview__name">{pendingMedia.filename}</span>
                    <button className="pending-media-remove" onClick={() => setPendingMedia(null)}>✕</button>
                  </div>
                )}

                <div className="message-input-row" style={{ position: 'relative' }}>
                  {/* Input de archivo oculto */}
                  <input
                    type="file"
                    ref={fileInputRef}
                    onChange={handleFileSelect}
                    accept="image/*,video/*,audio/*,.pdf,.doc,.docx,.xls,.xlsx,.zip,.txt"
                    style={{ display: 'none' }}
                  />

                  {/* Botón adjuntar */}
                  <button
                    className="attach-btn"
                    onClick={() => fileInputRef.current?.click()}
                    disabled={!isManual}
                    title="Adjuntar archivo"
                  >
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="18" height="18">
                      <path strokeLinecap="round" strokeLinejoin="round"
                        d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                    </svg>
                  </button>

                  {/* Botón Mejorar Gramática IA */}
                  <button
                    onClick={improveGrammar}
                    disabled={!newMessage.trim() || !isManual || isImprovingText}
                    title="Mejorar ortografía y tono con Inteligencia Artificial"
                    style={{ fontSize: '18px', background: 'transparent', border: 'none', cursor: 'pointer', margin: '0 5px', opacity: (!newMessage.trim() || !isManual) ? 0.3 : 1 }}
                  >
                    {isImprovingText ? '⏳' : '✨'}
                  </button>

                  {/* Botón Respuestas Rápidas */}
                  <button
                    className="emoji-toggle-btn"
                    onClick={() => { setShowQuickReplies(p => !p); setShowEmojiPicker(false); }}
                    disabled={!isManual}
                    title="Plantillas y Respuestas Rápidas"
                    style={{ color: showQuickReplies ? 'var(--neon-cyan)' : 'inherit' }}
                  ><Zap size={17} strokeWidth={2} /></button>

                  {/* Botón emoji */}
                  <button
                    className="emoji-toggle-btn"
                    onClick={() => { setShowEmojiPicker(p => !p); setShowQuickReplies(false); }}
                    disabled={!isManual}
                    title="Emojis"
                  >😊</button>

                  <textarea
                    ref={inputRef}
                    value={newMessage}
                    onChange={e => {
                      setNewMessage(e.target.value);
                      e.target.style.height = 'auto';
                      e.target.style.height = Math.min(e.target.scrollHeight, 120) + 'px';
                    }}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault();
                        sendMessage();
                        e.target.style.height = 'auto';
                      }
                    }}
                    placeholder={isManual ? 'Escribe tu mensaje... (Usa Shift+Enter para saldo de línea)' : 'Activa el modo manual para responder'}
                    disabled={!isManual}
                    className="message-input"
                    rows={1}
                  />
                  <button
                    onClick={sendMessage}
                    disabled={(!newMessage.trim() && !pendingMedia) || !isManual}
                    className="send-btn"
                  >
                    <Send size={18} strokeWidth={2.5} />
                  </button>

                  {/* Emoji picker flotante */}
                  {showEmojiPicker && isManual && (
                    <div className="emoji-picker-wrap">
                      <QuickEmojiGrid onSelect={insertEmoji} />
                    </div>
                  )}

                  {/* Quick Replies picker flotante */}
                  {showQuickReplies && isManual && (
                    <div className="quick-replies-wrap">
                      <QuickRepliesMenu
                        replies={quickReplies}
                        onSelect={insertQuickReply}
                        onAdd={handleAddQuickReply}
                        onDelete={handleDeleteQuickReply}
                      />
                    </div>
                  )}
                </div>
              </div>
            </>
          ) : (
            <EmptyState />
          )}
        </main>

        {/* ── Panel derecho — detalles ────────────── */}
        {selectedContact && (
          <aside className={`detail-panel ${isDetailOpen ? 'detail-panel--open' : ''}`}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 28 }}>
              <h3 className="detail-panel__title" style={{ margin: 0, padding: 0 }}>Detalles del Perfil</h3>
              <button onClick={() => setIsDetailOpen(false)} style={{ background: 'transparent', border: 'none', color: 'white', cursor: 'pointer', padding: '8px', borderRadius: '50%', backgroundColor: 'rgba(255,255,255,0.05)' }} title="Cerrar Panel">
                <svg viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none"><path d="M18 6L6 18M6 6l12 12"/></svg>
              </button>
            </div>
            <div className="detail-panel__body">
              {selectedContact.id && (
                <DetailRow label="Ticket ID" value={`#${String(selectedContact.id).slice(0,8).toUpperCase()}`} mono />
              )}
              <DetailRow 
                label="Nombre Contacto" 
                value={headerName} 
                onEdit={() => {
                  const newName = window.prompt('Introduce el alias o nombre real completo del usuario:', customNames[selectedId] || '');
                  if (newName !== null) setCustomName(selectedId, newName.trim());
                }}
              />
              <DetailRow label="Empresa" value={selectedContact.nombre_empresa} />
              <DetailRow label="Correo"  value={selectedContact.correo} />
              <DetailRow label="Número Tel / ID" value={(selectedChatId || '').replace(/@c\.us|@lid/g, '')} mono />
              {selectedContact.prioridad && (
                <div className="detail-row">
                  <p className="detail-row__label">Prioridad</p>
                  <PriorityBadge priority={selectedContact.prioridad} />
                </div>
              )}
              <DetailRow label="Área" value={selectedContact.area?.name || (selectedContact.area_id ? `Área #${selectedContact.area_id}` : 'Sin área asignada')} />
              <DetailRow label="Asignación" value={assignmentLabel(selectedContact)} />
              <DetailRow
                label="SLA"
                value={selectedContact.sla ? `${slaLabel(selectedContact.sla)} · ${selectedContact.sla.age_minutes} min · vence ${formatTime(selectedContact.sla.due_at)}` : 'Sin SLA calculado'}
                colorClass={selectedContact.sla?.state === 'breached' ? 'text-danger' : selectedContact.sla?.state === 'warning' ? 'text-warning' : 'text-success'}
              />
              <DetailRow
                label="Estado"
                value={selectedContact.status === 'closed' ? 'Cerrado' : 'Abierto'}
                colorClass={selectedContact.status === 'closed' ? 'text-muted' : 'text-green'}
              />
              {selectedContact.created_at && (
                <DetailRow
                  label="Creado"
                  value={new Date(selectedContact.created_at).toLocaleString('es-CO')}
                />
              )}
              {selectedContact.situacion && (
                <div className="detail-row">
                  <p className="detail-row__label">Descripción</p>
                  <div className="detail-panel__desc">{selectedContact.situacion}</div>
                </div>
              )}
              <DetailRow label="Mensajes" value={String(selectedMessages.length)} mono />

              {/* Sección AI Copilot Resumen */}
              {selectedContact.id && (
                <div className="detail-row" style={{ marginTop: 15, borderTop: '1px solid rgba(255,255,255,0.1)', paddingTop: 15 }}>
                  <button 
                    disabled={isSummarizing || chatSummaries[selectedContact.id]}
                    onClick={() => requestSummary(selectedContact.id)}
                    style={{ background: 'linear-gradient(135deg, #7c3aed, #4f46e5)', color: '#fff', border: 'none', padding: '10px 12px', borderRadius: '6px', cursor: (isSummarizing || chatSummaries[selectedContact.id]) ? 'not-allowed' : 'pointer', width: '100%', fontWeight: 'bold', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', opacity: (isSummarizing || chatSummaries[selectedContact.id]) ? 0.6 : 1 }}
                  >
                    {isSummarizing ? '⏳ Procesando...' : '🤖 Resumir Chat con IA'}
                  </button>
                  {chatSummaries[selectedContact.id] && (
                    <div style={{ marginTop: 12, padding: '12px', background: 'rgba(124, 58, 237, 0.1)', border: '1px solid rgba(124, 58, 237, 0.3)', borderRadius: 8, fontSize: 13, color: '#e2e8f0', whiteSpace: 'pre-line', lineHeight: '1.5' }}>
                      <strong style={{ color: '#a78bfa', display: 'block', marginBottom: 6 }}>✨ Resumen Ejecutivo:</strong>
                      {chatSummaries[selectedContact.id]}
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="export-actions">
              <p className="detail-panel__title" style={{ marginBottom: 10 }}>Exportar</p>
              <button className="export-btn export-btn--copy" onClick={copyToClipboard}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/>
                </svg>
                Copiar al portapapeles
              </button>
              <button className="export-btn export-btn--download" onClick={downloadTxt}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3M3 17v3a1 1 0 001 1h16a1 1 0 001-1v-3"/>
                </svg>
                Descargar .txt
              </button>
            </div>
          </aside>
        )}
        </>
      )}

      </div>

      {/* ── QR / Auth Modal ────────────────────── */}
      {showQR && (
        <div className="qr-overlay" onClick={(e) => e.target === e.currentTarget && setShowQR(false)}>
          <div className="qr-modal">

            {/* Header */}
            <div className="qr-modal__toprow">
              <div className="qr-modal__heading">
                <div className="topbar__logo" style={{ width: 36, height: 36, fontSize: 16 }}>N</div>
                <div>
                  <h2 className="qr-panel__title">Conectar WhatsApp</h2>
                  <p className="qr-panel__sub">Elige cómo vincular tu cuenta</p>
                </div>
              </div>
              <button className="qr-modal__close" onClick={() => setShowQR(false)}>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>

            {/* Pestañas */}
            <div className="auth-tabs">
              <button
                className={`auth-tab ${authMode === 'qr' ? 'auth-tab--active' : ''}`}
                onClick={() => { setAuthMode('qr'); setPairingCode(null); setPairingError(null); }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
                  <rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>
                  <rect x="3" y="14" width="7" height="7" rx="1"/>
                </svg>
                Código QR
              </button>
              <button
                className={`auth-tab ${authMode === 'code' ? 'auth-tab--active' : ''}`}
                onClick={() => { setAuthMode('code'); setPairingCode(null); setPairingError(null); setPairingLoading(false); }}
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="15" height="15">
                  <rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>
                </svg>
                Código numérico
              </button>
            </div>

            {/* Panel QR */}
            {authMode === 'qr' && (
              <>
                {qrDataUrl ? (
                  <div className="qr-panel__image-wrap">
                    <img src={qrDataUrl} alt="QR Code" className="qr-modal__image" />
                  </div>
                ) : (
                  <div className="qr-loading">
                    <div className="qr-loading__spinner" />
                    <p>Generando código QR...</p>
                  </div>
                )}

                {qrDataUrl && (
                  <div className="qr-countdown">
                    <div
                      className="qr-countdown__bar"
                      style={{ width: `${(qrCountdown / 20) * 100}%`, background: qrCountdown <= 5 ? 'var(--red)' : 'var(--blue)' }}
                    />
                    <span className="qr-countdown__text">
                      {qrCountdown > 0 ? `Válido por ${qrCountdown}s` : 'QR expirado'}
                    </span>
                  </div>
                )}

                {qrCountdown === 0 && qrDataUrl && (
                  <button className="qr-refresh-btn" onClick={() => socket.emit('request-qr')}>
                    Solicitar nuevo QR
                  </button>
                )}

                <div className="qr-panel__steps">
                  <p>1. Abre WhatsApp en tu teléfono</p>
                  <p>2. Toca <strong>Dispositivos vinculados</strong></p>
                  <p>3. Toca <strong>Vincular un dispositivo</strong> y escanea</p>
                </div>
              </>
            )}

            {/* Panel código numérico */}
            {authMode === 'code' && (
              <div className="pairing-panel">
                <p className="pairing-panel__desc">
                  Ingresa el número de WhatsApp que quieres vincular (con código de país, sin espacios ni guiones).
                </p>
                <div className="pairing-input-row">
                  <input
                    type="tel"
                    className="pairing-input"
                    placeholder="Ej: 573001234567"
                    value={pairingPhone}
                    onChange={e => { setPairingPhone(e.target.value); setPairingCode(null); setPairingError(null); }}
                  />
                  <button
                    className="pairing-request-btn"
                    disabled={pairingPhone.replace(/\D/g, '').length < 7 || pairingLoading}
                    onClick={() => {
                      setPairingCode(null);
                      setPairingError(null);
                      setPairingLoading(true);
                      socket.emit('request-pairing-code', { phone: pairingPhone });
                    }}
                  >
                    {pairingLoading ? 'Generando...' : 'Obtener código'}
                  </button>
                </div>

                {pairingLoading && !pairingCode && (
                  <div className="pairing-loading">
                    <div className="qr-loading__spinner" />
                    <p>Reiniciando sesión y solicitando código...<br/><small>Puede tardar 15-30 segundos</small></p>
                  </div>
                )}

                {pairingCode && (
                  <div className="pairing-code-display">
                    <p className="pairing-code-display__label">Ingresa este código en WhatsApp:</p>
                    <div className="pairing-code">{pairingCode}</div>
                    <p className="pairing-code-display__hint">
                      WhatsApp → Dispositivos vinculados → Vincular con número de teléfono
                    </p>
                  </div>
                )}

                {pairingError && (
                  <div className="pairing-error">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16">
                      <circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/>
                    </svg>
                    {pairingError}
                  </div>
                )}

                <div className="qr-panel__steps" style={{ marginTop: 16 }}>
                  <p>1. Ingresa el número y toca <strong>Obtener código</strong></p>
                  <p>2. Abre WhatsApp → Dispositivos vinculados</p>
                  <p>3. Toca <strong>Vincular con número de teléfono</strong></p>
                  <p>4. Ingresa el código de 8 dígitos</p>
                </div>
              </div>
            )}

          </div>
        </div>
      )}

      {/* ── Salesforce Case Modal ──── */}
      {sfModal.open && (
        <SalesforceCaseModal
          ticket={sfModal.ticket}
          onClose={() => setSfModal({ open: false, ticket: null })}
          onCaseCreated={(sfData) => {
            // Update contact in store with sf_case_id and sf_case_number
            if (sfData?.sf_case_id && sfModal.ticket?.contactKey) {
              setContacts(prev => ({
                ...prev,
                [sfModal.ticket.contactKey]: {
                  ...prev[sfModal.ticket.contactKey],
                  sf_case_id: sfData.sf_case_id,
                  sf_case_number: sfData.sf_case_number,
                }
              }));
            }
          }}
        />
      )}
    </div>
  );
}
