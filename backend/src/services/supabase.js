require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

// Initialize Supabase Client
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function guardarMensaje(ticketId, body, fromUser, isBot = false, analysis = null) {
  try {
    const { data, error } = await supabase
      .from('messages')
      .insert({
        ticket_id: ticketId,
        body,
        from_user: fromUser,
        is_bot: isBot,
        ai_analysis: analysis,
        timestamp: new Date().toISOString()
      })
      .select()
      .single();

    if (error) {
      console.warn('⚠️ No se pudo guardar mensaje:', error.message);
    }
    return data;
  } catch (e) {
    console.warn('⚠️ Error guardando mensaje en Supabase:', e.message);
    return null;
  }
}

module.exports = {
  supabase,
  guardarMensaje
};
