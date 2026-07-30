const store = require('./store');
const db    = require('./database/db');
const whatsappAdapter = require('./services/whatsapp');
const { canAccessTicket, analystCanSeeQueueCard, filterTicketsForPrincipal, isAdmin, emitClassified, emitTicketOperation, emitMinimalAreaOperation, toMinimalQueueCard } = require('./realtime/operational');
const routing = require('./services/routing');
const { validateWhatsAppMedia } = require('./services/mediaValidation');
const { uploadWhatsAppMediaForTicket } = require('./services/salesforceMedia');
const ticketClose = require('./services/ticketClose');
const { clearProtectedSocketState, createPassiveSocketRevalidator, createSocketAuthMiddleware, createSocketEventAuthMiddleware } = require('./middleware/socketAuth');

async function resolveTicketArea(ticketId) {
  if (!ticketId) return null;
  const ticket = await db.getTicketById(ticketId);
  return ticket?.area_id || null;
}

async function resolveChatTicket(chatId) {
  const ticketId = store.sesiones[chatId]?.ticketId;
  return ticketId ? db.getTicketWithAssignment(ticketId) : null;
}

function emitAdminOperation(io, event, payload) {
  io.to('admin').emit(event, payload);
}

async function disconnectSocketsForToken(io, tokenId) {
  let disconnected = 0;
  let failed = false;
  for (const socket of io?.sockets?.sockets?.values?.() || []) {
    if (String(socket.user?.id ?? '') !== String(tokenId)) continue;
    try {
      socket.emit('auth-error', { code: 'AUTH_REVOKED' });
    } catch (_error) {
      failed = true;
    }
    try {
      clearProtectedSocketState(socket);
      socket.disconnect(true);
      disconnected += 1;
    } catch (_error) {
      failed = true;
    }
  }
  if (failed) throw Object.assign(new Error('One or more local sockets could not be disconnected.'), { code: 'SOCKET_TEARDOWN_FAILED', disconnectedSockets: disconnected });
  return disconnected;
}

async function emitAdminChatOperation(io, event, payload, chatId) {
  try {
    const ticket = await resolveChatTicket(chatId);
    emitClassified(io, {
      event,
      adminPayload: payload,
      analystId: ticket?.assignment?.analyst_id || null,
      analystPayload: ticket?.assignment?.analyst_id ? payload : null,
    });
  } catch (err) {
    console.warn(`⚠️  No se pudo resolver área para ${event}:`, err.message);
    emitAdminOperation(io, event, payload, null);
  }
}

async function getAuthorizedTicket(socket, ticketId) {
  if (!ticketId) return null;

  const ticket = await db.getTicketWithAssignment(ticketId);
  if (!ticket) return null;
  if (canAccessTicket(socket.user, socket.analyst, ticket)) return ticket;

  return null;
}

async function requireAuthorizedTicket(socket, ticketId, errorEvent = 'auth-error') {
  const ticket = await getAuthorizedTicket(socket, ticketId);
  if (ticket) return ticket;

  socket.emit(errorEvent, { message: 'You are not authorized to access this ticket.' });
  return null;
}

function requireAdminSocket(socket, errorEvent = 'auth-error') {
  if (isAdmin(socket.user)) return true;
  socket.emit(errorEvent, { message: 'Administrator privileges are required.' });
  return false;
}

function emitRoutingUpdate(io, ticket, { previousAreaId = null } = {}) {
  if (!ticket) return;
  if (previousAreaId && String(previousAreaId) !== String(ticket.area_id || '')) {
    emitMinimalAreaOperation(io, 'ticket-removed', { ticketId: ticket.id, reason: 'area_transfer' }, previousAreaId);
  }
  const card = toMinimalQueueCard(ticket);
  emitTicketOperation(io, 'ticket-assigned', ticket, { areaPayload: card });
  emitClassified(io, { event: 'queue-updated', adminPayload: { ticket }, areaId: ticket.area_id, areaPayload: { ticket: card }, analystId: ticket.assignment?.analyst_id, analystPayload: { ticket } });
  if (ticket.sla?.state === 'warning' || ticket.sla?.state === 'breached') {
    emitMinimalAreaOperation(io, 'sla-alert', { ticketId: ticket.id, sla: ticket.sla }, ticket.area_id || null);
  }
}

function canSelfAssignTicket(socket, ticket) {
  const analystId = socket.analyst?.id;
  if (!analystId || !ticket) return false;
  const assignedAnalystId = ticket.assignment?.analyst_id;
  return !assignedAnalystId || String(assignedAnalystId) === String(analystId);
}

function safeClaimIdentifier(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const normalized = String(value).trim();
  return normalized && normalized.length <= 128 && /^[A-Za-z0-9_-]+$/.test(normalized) ? normalized : null;
}

function claimCorrelation(payload) {
  const ticketId = safeClaimIdentifier(payload?.ticketId);
  const correlationId = safeClaimIdentifier(payload?.correlationId);
  return { ...(ticketId ? { ticketId } : {}), ...(correlationId ? { correlationId } : {}) };
}

async function handleAssignTicket({ socket, io, payload }) {
  const correlation = claimCorrelation(payload);
  const reject = (event, message) => socket.emit(event, { ...correlation, message });
  const ticketId = safeClaimIdentifier(payload?.ticketId);
  const analystId = safeClaimIdentifier(payload?.analystId);
  if (!ticketId) return reject('assignment-error', 'El ticket solicitado no es válido.');
  if (!analystId) return reject('assignment-error', 'El analista solicitado no es válido.');
  try {
    let targetAnalystId = analystId;
    if (!isAdmin(socket.user)) {
      if (!socket.analyst?.id || String(analystId) !== String(socket.analyst.id)) return reject('auth-error', 'No tienes permisos para asignar tickets a otros analistas.');
      const candidate = await db.getTicketWithAssignment(ticketId);
      if (!candidate || (!canAccessTicket(socket.user, socket.analyst, candidate) && !analystCanSeeQueueCard(socket.analyst, candidate))) return reject('auth-error', 'You are not authorized to claim this ticket.');
      if (!canSelfAssignTicket(socket, candidate)) return reject('assignment-error', 'No puedes tomar un ticket asignado a otro analista.');
      targetAnalystId = socket.analyst.id;
    }
    const expectedRevision = Number(payload?.expectedRevision);
    const idempotencyKey = safeClaimIdentifier(payload?.idempotencyKey);
    if (!isAdmin(socket.user) && db.claimConversation && (!Number.isInteger(expectedRevision) || expectedRevision < 0 || !idempotencyKey)) return reject('assignment-error', 'expectedRevision and idempotencyKey are required to claim a conversation.');
    const result = !isAdmin(socket.user)
      ? db.claimConversation
        ? await db.claimConversation({ ticketId, analystId: targetAnalystId, analystAreaId: socket.analyst.area_id, expectedRevision, idempotencyKey, actorName: socket.user.name || 'analyst' })
        : await db.claimTicket(ticketId, targetAnalystId)
      : await routing.assignTicket(db, { ticketId, analystId: targetAnalystId, assignedBy: 'manual', actor: socket.user });
    const ticket = result?.workflow || result;
    if (!result?.mutation?.replayed) emitRoutingUpdate(io, ticket);
    socket.emit('assignment-success', { ...correlation, ticketId: safeClaimIdentifier(ticket.id) || ticketId });
  } catch (err) {
    console.error('Error asignando ticket:', err.message);
    reject('assignment-error', err.message || 'No se pudo asignar el ticket.');
  }
}

function emitInitialWhatsAppAuthState(socket) {
  if (!isAdmin(socket.user)) return;

  if (whatsappAdapter.isReady()) {
    socket.emit('bot-status', { status: 'ready' });
  } else if (store.lastQR) {
    const elapsed   = Math.floor((Date.now() - store.lastQRTime) / 1000);
    const remaining = Math.max(1, 20 - elapsed);
    socket.emit('qr', { qr: store.lastQR, expiresIn: remaining });
    socket.emit('bot-status', { status: 'qr' });
  } else {
    socket.emit('bot-status', { status: 'disconnected' });
  }
}

function setupSockets(io, client, borrarSesion) {
  io.use(createSocketAuthMiddleware(db.validateToken));

  io.on('connection', async (socket) => {
    console.log(`🖥️  Dashboard conectado: ${socket.id} (Usuario: ${socket.user.name}, Rol: ${socket.user.role})`);

    let analyst = null;
    const eventAuth = createSocketEventAuthMiddleware(db.validateToken, db.getAnalystByTokenId);
    socket.use((packet, next) => eventAuth(socket, packet, next));
    const stopPassiveAuth = createPassiveSocketRevalidator(socket, db.validateToken, db.getAnalystByTokenId);
    if (socket.user.role === 'admin') {
      socket.join('admin');
    }

    try {
      analyst = await db.getAnalystByTokenId(socket.user.id);
      if (analyst?.id) socket.join(`analyst:${analyst.id}`);
      if (analyst?.area_id) socket.join(`area:${analyst.area_id}`);
      socket.analyst = analyst;
      socket.emit('principal-info', { user: socket.user, analyst });
    } catch (err) {
      console.warn('⚠️  No se pudo resolver sala de analista:', err.message);
    }

    // Enviar estado actual del bot al nuevo cliente
    socket.emit('bot-activo', store.botActivo);

    // Enviar el estado de autenticación real de WhatsApp solo a administradores.
    emitInitialWhatsAppAuthState(socket);

    // Diagnósticos del sistema para el Dashboard
    socket.on('get-system-info', () => {
      if (!requireAdminSocket(socket)) return;
      const info = whatsappAdapter.getSystemInfo();
      socket.emit('system-info', info);
    });

    // Solicitud manual de QR desde el dashboard
    socket.on('request-qr', () => {
      if (!requireAdminSocket(socket)) return;
      store.lastQRTime = 0;
      if (store.lastQR) socket.emit('qr', { qr: store.lastQR, expiresIn: 20 });
    });

    // Cerrar sesión y reconectar con otra cuenta
    socket.on('logout', async () => {
      if (!requireAdminSocket(socket)) return;
      console.log('🔓 Cerrando sesión de WhatsApp...');
      store.lastQR              = null;
      store.lastQRTime          = 0;
      store.pendingPairingPhone = null;
      io.to('admin').emit('bot-status', { status: 'disconnected' });
      io.to('admin').emit('qr-cleared');

      try {
        await client.destroy();
        console.log('🔄 Browser cerrado');
      } catch (e) {
        console.warn('⚠️  Destroy error:', e.message);
      }

      await borrarSesion();

      setTimeout(async () => {
        try {
          console.log('🔄 Reiniciando cliente...');
          await client.initialize();
        } catch (e) {
          console.error('❌ Error al reiniciar:', e.message);
        }
      }, 1000);
    });

    // Código numérico
    socket.on('request-pairing-code', async ({ phone }) => {
      if (!requireAdminSocket(socket, 'pairing-code-error')) return;
      try {
        const cleanPhone = phone.replace(/\+/g, '').trim();
        console.log('📱 Solicitando código de emparejamiento de WhatsApp');
        const code = await client.requestPairingCode(cleanPhone);
        console.log('🔑 Código de emparejamiento generado');
        socket.emit('pairing-code', { code });
      } catch (err) {
        console.error('❌ Error generando código de emparejamiento:', err.message);
        socket.emit('pairing-code-error', {
          message: 'No se pudo generar el código numérico. Por favor revisa el número e intenta de nuevo o usa el QR.'
        });
      }
    });

    // Interruptor global del bot
    socket.on('set-bot-activo', (valor) => {
      if (!requireAdminSocket(socket)) return;
      store.botActivo = valor;
      console.log(`🤖 Bot ${store.botActivo ? 'ACTIVADO' : 'DESACTIVADO'} por el dashboard`);
      io.emit('bot-activo', store.botActivo);
    });

    // Cambiar modo auto/manual
    socket.on('toggle-mode', async ({ chatId, mode }) => {
      if (!requireAdminSocket(socket)) return;
      store.chatModes.set(chatId, mode);
      store.persistPreference(chatId, { mode }); // fire-and-forget, no await
      await emitAdminChatOperation(io, 'mode-changed', { chatId, mode }, chatId);
      console.log(`🔄 Modo [${chatId}] → ${mode}`);
    });

    // Silenciar / activar
    socket.on('silence-chat', async (chatId) => {
      if (!requireAdminSocket(socket)) return;
      store.silenciados.add(chatId);
      store.persistPreference(chatId, { silenced: true }); // fire-and-forget
      await emitAdminChatOperation(io, 'chat-silenced', { chatId }, chatId);
    });

    socket.on('unsilence-chat', async (chatId) => {
      if (!requireAdminSocket(socket)) return;
      store.silenciados.delete(chatId);
      store.persistPreference(chatId, { silenced: false }); // fire-and-forget
      await emitAdminChatOperation(io, 'chat-unsilenced', { chatId }, chatId);
    });

    // Forzar activación del bot directo
    socket.on('force-bot', async (chatId) => {
      if (!requireAdminSocket(socket)) return;
      console.log(`🚀 Forzando inicio del bot para: ${chatId}`);
      try {
        store.sesiones[chatId] = { paso: 0 };
        const msgStr = '¡Hola! Bienvenido al canal de soporte de Integraciones de *Magneto365*.\n\n' +
        'Para brindarte una atención más rápida, por favor responde con el número de tu perfil:\n' +
        '*1.* Analista / Empresa\n' +
        '*2.* Candidato\n' +
        '*3.* Proveedor';

        await client.sendMessage(chatId, msgStr);
        store.sesiones[chatId] = { paso: 'filtro_no' };
        store.chatModes.set(chatId, 'auto');
        await emitAdminChatOperation(io, 'mode-changed', { chatId, mode: 'auto' }, chatId);
      } catch (e) {
        console.error('❌ Error forzando bot:', e.message);
      }
    });

    // Socket Rate Limiting Map
    const messageRateLimit = [];

    // Enviar mensaje manual desde dashboard
    socket.on('send-message', async ({ chatId, message, ticketId, media }) => {
      // ── Rate Limiting Check (Max 5 messages per 2 seconds) ─────────
      const now = Date.now();
      // Filter out timestamps older than 2 seconds
      const recentAttempts = messageRateLimit.filter(t => now - t < 2000);
      if (recentAttempts.length >= 5) {
        return socket.emit('send-error', { message: 'Límite de velocidad excedido. Intenta de nuevo en unos segundos.' });
      }
      recentAttempts.push(now);
      // Clean array reference
      messageRateLimit.length = 0;
      messageRateLimit.push(...recentAttempts);

      // ── XSS Sanitization ──────────────────────────────────────────
      const xss = require('xss');
      const safeMessage = message ? xss(message) : '';

      try {
        const authorizedTicket = ticketId
          ? await requireAuthorizedTicket(socket, ticketId, 'send-error')
          : (requireAdminSocket(socket, 'send-error') ? null : false);
        if (authorizedTicket === false || (ticketId && !authorizedTicket)) return;

        let sent;
        let mediaMetadata = null;
        let mediaUpload = null;
        if (media?.data) {
          const validated = validateWhatsAppMedia(media);
          mediaMetadata = { filename: validated.filename, mimetype: validated.mimetype, sizeBytes: validated.sizeBytes };
          sent = await whatsappAdapter.sendMessage(chatId, safeMessage, { media: { ...media, data: validated.data, mimetype: validated.mimetype, filename: validated.filename } });
          if (ticketId) {
            try {
              mediaUpload = await uploadWhatsAppMediaForTicket({ ticketId, media: { ...media, data: validated.data, mimetype: validated.mimetype, filename: validated.filename } });
            } catch (err) {
              console.warn('⚠️  No se pudo subir adjunto saliente a Salesforce:', err.message);
              mediaUpload = { uploaded: false, reason: 'upload_failed', metadata: mediaMetadata };
            }
          }
        } else {
          sent = await whatsappAdapter.sendMessage(chatId, safeMessage);
        }

        const waMessageId = sent?.id?._serialized || null;
        const displayBody = safeMessage || `[${media?.mimetype?.split('/')[0] || 'media'}]`;
        const timestamp   = new Date().toISOString();
        const saved       = ticketId
          ? await db.saveMessage({ ticket_id: ticketId, chat_id: chatId, body: displayBody, from_user: false, is_bot: false, wa_message_id: waMessageId })
          : null;

        const areaId = authorizedTicket?.area_id || null;
        emitClassified(io, { event: 'new-message', adminPayload: {
          chatId,
          ticketId:    ticketId || null,
          message:     displayBody,
          media:       mediaMetadata,
          mediaUpload,
          waMessageId,
          from_user:   false,
          is_bot:      false,
          timestamp,
          id:          saved?.id
        }, analystId: authorizedTicket?.assignment?.analyst_id, analystPayload: {
          chatId, ticketId: ticketId || null, message: displayBody, media: mediaMetadata, mediaUpload,
          waMessageId, from_user: false, is_bot: false, timestamp, id: saved?.id,
        }});
      } catch (err) {
        console.error('Error enviando mensaje manual:', err);
        socket.emit('send-error', { message: 'No se pudo enviar el mensaje.' });
      }
    });

    // Reaccionar a mensaje de WhatsApp
    socket.on('react-message', async ({ waMessageId, emoji }) => {
      if (!requireAdminSocket(socket)) return;
      try {
        const msg = await client.getMessageById(waMessageId);
        await msg.react(emoji);
        emitAdminOperation(io, 'message-reaction', { waMessageId, emoji }, null);
      } catch (e) {
        console.error('Error enviando reacción:', e.message);
      }
    });

    // Load tickets
    socket.on('get-tickets', async () => {
      try {
        const tickets = routing.enrichTickets(await db.getTicketsWithRouting());
        if (isAdmin(socket.user)) {
          socket.emit('tickets-list', tickets);
          return;
        }

        socket.emit('tickets-list', filterTicketsForPrincipal(tickets, socket.user, socket.analyst));
      } catch (err) {
        console.error('Error cargando tickets:', err);
        socket.emit('tickets-error', { message: 'No se pudieron cargar los tickets.' });
      }
    });

    socket.on('assign-ticket', payload => handleAssignTicket({ socket, io, payload }));

    socket.on('transfer-ticket', async ({ ticketId, areaId, analystId }) => {
      if (!requireAdminSocket(socket, 'assignment-error')) return;
      try {
        const ticket = await routing.transferTicket(db, { ticketId, areaId, analystId, actor: socket.user });
        emitRoutingUpdate(io, ticket, { previousAreaId: ticket.previous_area_id || null });
      } catch (err) {
        console.error('Error transfiriendo ticket:', err.message);
        socket.emit('assignment-error', { ticketId, correlationId: String(ticketId), message: err.message || 'No se pudo transferir el ticket.' });
      }
    });

    socket.on('unassign-ticket', async ({ ticketId }) => {
      if (!requireAdminSocket(socket, 'assignment-error')) return;
      try {
        const ticket = await routing.unassignTicket(db, ticketId, { assignedBy: 'manual', actor: socket.user });
        emitRoutingUpdate(io, ticket);
      } catch (err) {
        console.error('Error desasignando ticket:', err.message);
        socket.emit('assignment-error', { ticketId, correlationId: String(ticketId), message: err.message || 'No se pudo desasignar el ticket.' });
      }
    });

    // Load messages for a ticket
    socket.on('get-messages', async (ticketId) => {
      const ticket = await requireAuthorizedTicket(socket, ticketId);
      if (!ticket) return;
      const messages = await db.getMessages(ticketId);
      socket.emit('messages-list', messages);
    });

    // Close ticket
    socket.on('close-ticket', async (ticketId) => {
      const ticketData = await requireAuthorizedTicket(socket, ticketId);
      if (!ticketData) return;
      const result = await ticketClose.closeTicket({ ticketId, actor: socket.user, sendFarewell: true, whatsappClient: client });

      if (result.farewellSent && ticketData?.telefono) {
        emitTicketOperation(io, 'new-message', {
          chatId:    ticketData.telefono,
          ticketId,
          message:   ticketClose.DEFAULT_FAREWELL,
          from_user: false,
          is_bot:    true,
          timestamp: new Date().toISOString(),
          area_id: ticketData?.area_id, assignment: ticketData?.assignment,
        });
      }

      emitMinimalAreaOperation(io, 'ticket-closed', { ticketId }, ticketData?.area_id || null);
      Object.keys(store.sesiones).forEach(chatId => {
        if (store.sesiones[chatId]?.ticketId === ticketId) delete store.sesiones[chatId];
      });
    });

    // Delete ticket and chat permanently
    socket.on('delete-chat', async ({ contactKey, ticketId }) => {
      console.log('🗑️ delete-chat recibido:', { contactKey, ticketId });
      const ticket = ticketId
        ? await requireAuthorizedTicket(socket, ticketId)
        : (requireAdminSocket(socket) ? null : false);
      if (ticket === false || (ticketId && !ticket)) return;
      const areaId = ticket?.area_id || null;
      if (ticketId) {
        await db.deleteTicket(ticketId);
      }
      store.deletePreference(contactKey); // fire-and-forget
      emitMinimalAreaOperation(io, 'chat-deleted', { ticketId }, areaId);
    });

    // AI Copilot Endpoints
    socket.on('request-summary', async (ticketId) => {
      const ticket = await requireAuthorizedTicket(socket, ticketId, 'summary-error');
      if (!ticket) return;
      const messages = await db.getMessages(ticketId);
      if (!messages || messages.length === 0) {
        socket.emit('summary-error', { message: 'No hay mensajes para resumir' });
        return;
      }
      const historial = messages.map(m => `[${m.from_user ? 'Cliente' : 'Agente'}]: ${m.body}`).join('\n');
      const { resumirConversacion } = require('./services/ai');
      const resumen = await resumirConversacion(historial);
      socket.emit('summary-ready', { ticketId, resumen });
    });

    socket.on('request-grammar', async ({ text, callbackId }) => {
      const xss = require('xss');
      const safeText = xss(text);
      const { mejorarGramatica } = require('./services/ai');
      const improved = await mejorarGramatica(safeText);
      socket.emit('grammar-ready', { improved, callbackId });
    });

    // Redirect to general support
    socket.on('redirect-support', async ({ contactKey, ticketId }) => {
      console.log(`✉️ Derivando chat a soporte general: ${contactKey}`);
      const chatId = contactKey.includes('@c.us') || contactKey.includes('@lid') ? contactKey : null;
      let telefonoDestino = chatId;

      const mensajeDerivacion = 'Tu solicitud no pertenece al área de integraciones. Te sugerimos escalar tu caso al correo *soporte.mgt@magnetoglobal.com* para que puedas recibir ayuda prontamente.';

      let targetTicketId = ticketId;

      if (targetTicketId) {
        const ticket = await requireAuthorizedTicket(socket, targetTicketId);
        if (!ticket) return;
      } else if (!requireAdminSocket(socket)) {
        return;
      }

      if (!targetTicketId && telefonoDestino) {
        const ticket = await db.createTicket({
          chat_id:        telefonoDestino,
          telefono:       telefonoDestino.replace(/@c\.us|@lid/g, ''),
          nombre_analista: store.sesiones[telefonoDestino]?.nombre || 'Usuario Derivado a Soporte',
          situacion:      'Chat derivado a soporte general automático (fuera de scope).',
          prioridad:      'Baja',
        });
        if (ticket) targetTicketId = ticket.id;
      }

      if (targetTicketId) {
        if (!telefonoDestino) {
          const t = await db.getTicketById(targetTicketId);
          if (t?.telefono) telefonoDestino = t.telefono;
        }
        await db.closeTicket(targetTicketId);
        await db.saveMessage({ ticket_id: targetTicketId, chat_id: telefonoDestino || '', body: mensajeDerivacion, from_user: false, is_bot: true });
        const areaId = await resolveTicketArea(targetTicketId);
        emitMinimalAreaOperation(io, 'ticket-closed', { ticketId: targetTicketId }, areaId);
      }

      if (telefonoDestino) {
        try {
          await client.sendMessage(telefonoDestino, mensajeDerivacion);
          const areaId = await resolveTicketArea(targetTicketId);
          emitClassified(io, { event: 'new-message', adminPayload: {
            chatId:    telefonoDestino,
            ticketId:  targetTicketId || null,
            message:   mensajeDerivacion,
            from_user: false,
            is_bot:    true,
            timestamp: new Date().toISOString(),
          }});
        } catch (e) {
          console.warn('Error enviando mensaje de derivación:', e.message);
        }
        delete store.sesiones[telefonoDestino];
        store.chatModes.delete(telefonoDestino);
      }
    });

    socket.on('get-stats', async () => {
      if (!requireAdminSocket(socket)) return;
      const stats = await db.getStats();
      socket.emit('stats-data', {
        total:   stats.total,
        open:    stats.open,
        closed:  stats.closed,
        today:   stats.today,
        tmaMins: 0,
      });
    });

    socket.on('disconnect', () => {
      stopPassiveAuth();
      console.log('🖥️  Dashboard desconectado:', socket.id);
    });
  });
}

module.exports = { setupSockets, canSelfAssignTicket, handleAssignTicket, safeClaimIdentifier, disconnectSocketsForToken, emitInitialWhatsAppAuthState, emitAdminOperation, emitAdminChatOperation, emitRoutingUpdate };
