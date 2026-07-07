require('dotenv').config({ path: './.env' });
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function test() {
  const payload = {
    telefono: '1234567890@c.us',
    nombre_analista: 'William Zapata',
    nombre_empresa: 'Empresa Test',
    correo: 'william@test.com',
    situacion: 'Prueba de error',
    prioridad: 'Media'
  };

  const { data: ticket, error } = await supabase
    .from('tickets')
    .insert(payload)
    .select()
    .single();

  if (error) {
    console.error('ERROR:', JSON.stringify(error, null, 2));
  } else {
    console.log('SUCCESS:', ticket);
  }
}

test();
