import { useEffect } from 'react';
import QRCode from 'qrcode';
import { socket as nexoSocket } from '../lib/nexoSocket';

export function registerNexoSocketHandlers(socket, options) {
  const {
    qrTimerRef,
    selectedIdRef,
    setAuthError,
    setAuthMode,
    setBotActivo,
    setBotStatus,
    setChatMessages,
    setChatModes,
    setChatSummaries,
    setContacts,
    setIsAuthenticated,
    setIsImprovingText,
    setIsSummarizing,
    setNewMessage,
    setPairingCode,
    setPairingError,
    setPairingLoading,
    setPrincipal,
    setQrCountdown,
    setQrDataUrl,
    setSelectedId,
    setSilenced,
    setStats,
    setSystemInfo,
    setUnread,
  } = options;

  let active = true;
  let requestedInitialTickets = false;

  const cleanupQrTimer = () => {
    clearInterval(qrTimerRef.current);
    qrTimerRef.current = null;
  };

  const emitIfActive = (event, ...args) => {
    if (!active) return;
    socket.emit(event, ...args);
  };

  const requestInitialTickets = () => {
    if (requestedInitialTickets) return;
    requestedInitialTickets = true;
    emitIfActive('get-tickets');
  };

  const logoutFromSocketError = () => {
    localStorage.removeItem('nexo_token');
    setIsAuthenticated(false);
    setSystemInfo(null);
    socket.disconnect();
  };

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

  const listeners = [
    ['connect', () => {
      setBotStatus('connected');
      requestInitialTickets();
    }],
    ['disconnect', () => setBotStatus('disconnected')],
    ['connect_error', (err) => {
      console.error('Socket connection error:', err.message);
      setAuthError('Acceso denegado: Token inválido o revocado.');
      logoutFromSocketError();
    }],
    ['bot-status', ({ status }) => {
      setBotStatus(status);
      if (status === 'ready') {
        setQrDataUrl(null);
        cleanupQrTimer();
      }
    }],
    ['qr', async ({ qr, expiresIn }) => {
      const url = await QRCode.toDataURL(qr, { width: 280, margin: 2, color: { dark: '#ffffff', light: '#0d0d17' } });
      if (!active) return;

      setQrDataUrl(url);
      setQrCountdown(expiresIn);

      cleanupQrTimer();
      qrTimerRef.current = setInterval(() => {
        setQrCountdown(prev => {
          if (prev <= 1) {
            cleanupQrTimer();
            return 0;
          }
          return prev - 1;
        });
      }, 1000);
    }],
    ['bot-activo', (valor) => setBotActivo(valor)],
    ['principal-info', (info) => setPrincipal(info)],
    ['qr-cleared', () => {
      setQrDataUrl(null);
      setQrCountdown(0);
      setPairingCode(null);
      setPairingError(null);
      setPairingLoading(false);
      setAuthMode('qr');
      cleanupQrTimer();
    }],
    ['pairing-code', ({ code }) => {
      setPairingCode(code);
      setPairingError(null);
      setPairingLoading(false);
    }],
    ['pairing-code-error', ({ message }) => {
      setPairingError(message);
      setPairingCode(null);
      setPairingLoading(false);
    }],
    ['tickets-list', (list) => {
      setContacts(prev => {
        const next = { ...prev };
        list.forEach(t => {
          if (!t.telefono) return;
          const key = String(t.id);
          next[key] = {
            ...t,
            chatId: t.telefono,
            contactKey: key,
            lastMessage: prev[key]?.lastMessage || t.situacion || '',
            lastTimestamp: prev[key]?.lastTimestamp || t.created_at,
          };
        });
        return next;
      });

      const savedId = localStorage.getItem('nexo_selected_id');
      if (savedId) {
        const ticket = list.find(t => String(t.id) === savedId);
        if (ticket) {
          emitIfActive('get-messages', ticket.id);
        }
      }
    }],
    ['system-info', (info) => setSystemInfo(info)],
    ['ticket-created', (ticket) => {
      const key = String(ticket.id);
      setContacts(prev => {
        const next = { ...prev };
        const old = next[ticket.telefono] || {};
        delete next[ticket.telefono];
        next[key] = {
          ...ticket,
          chatId: ticket.telefono,
          contactKey: key,
          lastTimestamp: ticket.created_at || old.lastTimestamp,
          lastMessage: old.lastMessage || ticket.situacion || '',
        };
        return next;
      });
      setChatMessages(prev => {
        const old = prev[ticket.telefono] || [];
        if (!old.length && !prev[key]) return prev;
        const next = { ...prev };
        delete next[ticket.telefono];
        next[key] = [...old, ...(next[key] || [])];
        return next;
      });
      setSelectedId(prev => prev === ticket.telefono ? key : prev);
    }],
    ['new-message', ({ chatId, message, from_user, is_bot, timestamp, ticketId, media, waMessageId }) => {
      const newMsg = { body: message, from_user, is_bot, timestamp, media: media || null, waMessageId: waMessageId || null };
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
          lastMessage: message,
          lastTimestamp: timestamp,
        }
      }));

      if (from_user) {
        setUnread(prev => {
          if (contactKey === selectedIdRef.current) return prev;
          return { ...prev, [contactKey]: (prev[contactKey] || 0) + 1 };
        });
      }
    }],
    ['messages-list', (msgs) => {
      const id = selectedIdRef.current;
      if (id) setChatMessages(prev => ({ ...prev, [id]: Array.isArray(msgs) ? msgs : [] }));
    }],
    ['message-reaction', ({ waMessageId, emoji }) => {
      setChatMessages(prev => {
        const next = { ...prev };
        for (const id of Object.keys(next)) {
          next[id] = next[id].map(m => m.waMessageId === waMessageId ? { ...m, reaction: emoji } : m);
        }
        return next;
      });
    }],
    ['ticket-assigned', mergeTicket],
    ['queue-updated', ({ ticket }) => mergeTicket(ticket)],
    ['sla-alert', ({ ticketId, sla }) => {
      const key = String(ticketId);
      setContacts(prev => prev[key] ? { ...prev, [key]: { ...prev[key], sla } } : prev);
    }],
    ['mode-changed', ({ chatId, mode }) => setChatModes(prev => ({ ...prev, [chatId]: mode }))],
    ['chat-silenced', ({ chatId }) => setSilenced(prev => ({ ...prev, [chatId]: true }))],
    ['chat-unsilenced', ({ chatId }) => setSilenced(prev => { const next = { ...prev }; delete next[chatId]; return next; })],
    ['ticket-closed', ({ ticketId }) => {
      const key = String(ticketId);
      setContacts(prev => {
        if (!prev[key]) return prev;
        return { ...prev, [key]: { ...prev[key], status: 'closed' } };
      });
    }],
    ['summary-ready', ({ ticketId, resumen }) => {
      setChatSummaries(prev => ({ ...prev, [ticketId]: resumen }));
      setIsSummarizing(false);
    }],
    ['summary-error', () => {
      setIsSummarizing(false);
      alert('Error al generar resumen con IA.');
    }],
    ['grammar-ready', ({ improved }) => {
      setNewMessage(improved);
      setIsImprovingText(false);
    }],
    ['chat-deleted', ({ contactKey }) => {
      setContacts(prev => { const next = { ...prev }; delete next[contactKey]; return next; });
      setChatMessages(prev => { const next = { ...prev }; delete next[contactKey]; return next; });
      setSelectedId(prev => prev === contactKey ? null : prev);
    }],
    ['sf-case-created', ({ contactKey, sf_case_id, sf_case_number }) => {
      setContacts(prev => ({
        ...prev,
        [contactKey]: {
          ...prev[contactKey],
          sf_case_id,
          sf_case_number,
        }
      }));
    }],
    ['stats-data', (data) => setStats(data)],
  ];

  const registeredListeners = listeners.map(([event, handler]) => {
    const guardedHandler = (...args) => {
      if (!active) return undefined;
      return handler(...args);
    };
    socket.on(event, guardedHandler);
    return [event, guardedHandler];
  });

  if (socket.connected) {
    requestInitialTickets();
  }

  return () => {
    active = false;
    registeredListeners.forEach(([event, handler]) => socket.off(event, handler));
    cleanupQrTimer();
  };
}

export function useNexoSocket({ isAuthenticated, socket = nexoSocket, options }) {
  useEffect(() => {
    if (!isAuthenticated) {
      socket.disconnect();
      return undefined;
    }

    socket.connect();
    const cleanupHandlers = registerNexoSocketHandlers(socket, options);

    return () => {
      cleanupHandlers();
      socket.disconnect();
    };
  }, [isAuthenticated, socket, options]);

  return socket;
}
