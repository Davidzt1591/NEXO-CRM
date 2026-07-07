const store = require('./store');
const db    = require('./database/db');
const whatsappAdapter = require('./services/whatsapp');

function setupSockets(io, client, borrarSesion) {
  io.on('connection', (socket) => {
    console.log('🖥️  Dashboard conectado:', socket.id);

    // Enviar estado actual del bot al nuevo cliente
    socket.emit('bot-activo', store.botActivo);

    // Enviar el estado de autenticación real de WhatsApp
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

    // Diagnósticos del sistema para el Dashboard
    socket.on('get-system-info', () => {
      const info = whatsappAdapter.getSystemInfo();
      socket.emit('system-info', info);
    });

    // Solicitud manual de QR desde el dashboard
    socket.on('request-qr', () => {
      store.lastQRTime = 0;
      if (store.lastQR) socket.emit('qr', { qr: store.lastQR, expiresIn: 20 });
    });

    // Cerrar sesión y reconectar con otra cuenta
    socket.on('logout', async () => {
      console.log('🔓 Cerrando sesión de WhatsApp...');
      store.lastQR              = null;
      store.lastQRTime          = 0;
      store.pendingPairingPhone = null;
      io.emit('bot-status', { status: 'disconnected' });
      io.emit('qr-cleared');

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
      try {
        const cleanPhone = phone.replace(/\+/g, '').trim();
        console.log(`📱 Solicitando código de emparejamiento para: ${cleanPhone}`);
        const code = await client.requestPairingCode(cleanPhone);
        console.log(`🔑 Código generado: ${code}`);
        socket.emit('pairing-code', { code });
      } catch (err) {
        require('fs').writeFileSync('pairing_err.txt', err.stack);
        console.error('❌ Error generando código de emparejamiento:', err);
        socket.emit('pairing-code-error', {
          message: 'No se pudo generar el código numérico. Por favor revisa el número e intenta de nuevo o usa el QR.'
        });
      }
    });

    // Interruptor global del bot
    socket.on('set-bot-activo', (valor) => {
      store.botActivo = valor;
      console.log(`🤖 Bot ${store.botActivo ? 'ACTIVADO' : 'DESACTIVADO'} por el dashboard`);
      io.emit('bot-activo', store.botActivo);
    });

    // Cambiar modo auto/manual
    socket.on('toggle-mode', ({ chatId, mode }) => {
      store.chatModes.set(chatId, mode);
      io.emit('mode-changed', { chatId, mode });
      console.log(`🔄 Modo [${chatId}] → ${mode}`);
    });

    // Silenciar / activar
    socket.on('silence-chat', (chatId) => {
      store.silenciados.add(chatId);
      io.emit('chat-silenced', { chatId });
    });

    socket.on('unsilence-chat', (chatId) => {
      store.silenciados.delete(chatId);
      io.emit('chat-unsilenced', { chatId });
    });

    // Forzar activación del bot directo
    socket.on('force-bot', async (chatId) => {
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
        io.emit('mode-changed', { chatId, mode: 'auto' });
      } catch (e) {
        console.error('❌ Error forzando bot:', e.message);
      }
    });

    // Enviar mensaje manual desde dashboard
    socket.on('send-message', async ({ chatId, message, ticketId, media }) => {
      try {
        let sent;
        if (media?.data) {
          sent = await whatsappAdapter.sendMessage(chatId, message, { media });
        } else {
          sent = await whatsappAdapter.sendMessage(chatId, message);
        }

        const waMessageId = sent?.id?._serialized || null;
        const displayBody = message || `[${media?.mimetype?.split('/')[0] || 'media'}]`;
        const timestamp   = new Date().toISOString();
        const saved       = ticketId
          ? db.saveMessage({ ticket_id: ticketId, chat_id: chatId, body: displayBody, from_user: false, is_bot: false, wa_message_id: waMessageId })
          : null;

        io.emit('new-message', {
          chatId,
          ticketId:    ticketId || null,
          message:     displayBody,
          media:       media || null,
          waMessageId,
          from_user:   false,
          is_bot:      false,
          timestamp,
          id:          saved?.id
        });
      } catch (err) {
        console.error('Error enviando mensaje manual:', err);
        socket.emit('send-error', { message: 'No se pudo enviar el mensaje.' });
      }
    });

    // Reaccionar a mensaje de WhatsApp
    socket.on('react-message', async ({ waMessageId, emoji }) => {
      try {
        const msg = await client.getMessageById(waMessageId);
        await msg.react(emoji);
        io.emit('message-reaction', { waMessageId, emoji });
      } catch (e) {
        console.error('Error enviando reacción:', e.message);
      }
    });

    // Load tickets
    socket.on('get-tickets', () => {
      const tickets = db.getTickets();
      socket.emit('tickets-list', tickets);
    });

    // Load messages for a ticket
    socket.on('get-messages', (ticketId) => {
      const messages = db.getMessages(ticketId);
      socket.emit('messages-list', messages);
    });

    // Close ticket
    socket.on('close-ticket', async (ticketId) => {
      const ticketData = db.getTicketById(ticketId);
      db.closeTicket(ticketId);

      if (ticketData?.telefono) {
        const despedida =
          'Estimado usuario, su solicitud ha sido *atendida y el ticket cerrado exitosamente*. ✅\n\n' +
          'Ha sido un gusto poder ayudarle. Si en algún momento tiene un nuevo requerimiento, ' +
          'no dude en contactarnos nuevamente.\n\n' +
          '¡Hasta pronto! 👋 — *Equipo de Integraciones Magneto365*';
        try {
          await client.sendMessage(ticketData.telefono, despedida);
          const timestamp = new Date().toISOString();
          db.saveMessage({ ticket_id: ticketId, chat_id: ticketData.telefono, body: despedida, from_user: false, is_bot: true });
          io.emit('new-message', {
            chatId:    ticketData.telefono,
            ticketId,
            message:   despedida,
            from_user: false,
            is_bot:    true,
            timestamp,
          });
        } catch (e) {
          console.warn('⚠️  Error enviando mensaje de cierre:', e.message);
        }
      }

      io.emit('ticket-closed', { ticketId });
      Object.keys(store.sesiones).forEach(chatId => {
        if (store.sesiones[chatId]?.ticketId === ticketId) delete store.sesiones[chatId];
      });
    });

    // Delete ticket and chat permanently
    socket.on('delete-chat', ({ contactKey, ticketId }) => {
      console.log('🗑️ delete-chat recibido:', { contactKey, ticketId });
      if (ticketId) {
        db.deleteTicket(ticketId); // cascades to messages via ON DELETE CASCADE
      }
      io.emit('chat-deleted', { contactKey });
    });

    // AI Copilot Endpoints
    socket.on('request-summary', async (ticketId) => {
      const messages = db.getMessages(ticketId);
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

      if (!targetTicketId && telefonoDestino) {
        const ticket = db.createTicket({
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
          const t = db.getTicketById(targetTicketId);
          if (t?.telefono) telefonoDestino = t.telefono;
        }
        db.closeTicket(targetTicketId);
        db.saveMessage({ ticket_id: targetTicketId, chat_id: telefonoDestino || '', body: mensajeDerivacion, from_user: false, is_bot: true });
        io.emit('ticket-closed', { ticketId: targetTicketId });
      }

      if (telefonoDestino) {
        try {
          await client.sendMessage(telefonoDestino, mensajeDerivacion);
          io.emit('new-message', {
            chatId:    telefonoDestino,
            ticketId:  targetTicketId || null,
            message:   mensajeDerivacion,
            from_user: false,
            is_bot:    true,
            timestamp: new Date().toISOString(),
          });
        } catch (e) {
          console.warn('Error enviando mensaje de derivación:', e.message);
        }
        delete store.sesiones[telefonoDestino];
        store.chatModes.delete(telefonoDestino);
      }
    });

    socket.on('get-stats', () => {
      const stats = db.getStats();
      socket.emit('stats-data', {
        total:   stats.total,
        open:    stats.open,
        closed:  stats.closed,
        today:   stats.today,
        tmaMins: 0, // Extended stats can be added later
      });
    });

    socket.on('disconnect', () => {
      console.log('🖥️  Dashboard desconectado:', socket.id);
    });
  });
}

module.exports = { setupSockets };
