const FALLBACK_MESSAGES = Object.freeze({
  out_of_office: 'Estimado usuario, gracias por contactar al canal de soporte de *Magneto365*. 🌐\n\nLe informamos que actualmente no nos encontramos en horario de atención. Una vez retomemos actividades, estaremos dando respuesta a su requerimiento. Gracias por su comprensión.',
  welcome_audience: 'Hola. Te damos la bienvenida al canal de soporte para analistas de *Magneto365*.\n\nPara orientarte, indícanos quién eres:\n*1.* Analista\n*2.* Candidato o candidata',
  legacy_migration_audience: 'Actualizamos nuestro flujo de soporte. Para continuar, indícanos quién eres:\n*1.* Analista\n*2.* Candidato o candidata',
  audience_invalid: 'Por favor, responde *1* si eres analista o *2* si eres candidato o candidata.',
  candidate_exit: 'Gracias por escribirnos. Este canal atiende únicamente solicitudes de analistas.\n\nSi eres candidato o candidata, comunícate con la empresa responsable de tu proceso o utiliza los canales de ayuda disponibles en la plataforma donde realizaste tu postulación. No compartas datos personales adicionales por este chat.',
  ask_category: '¿Con qué tema necesitas ayuda?\n\n*1.* Plataforma\n*2.* Resultados de pruebas\n*3.* Solicitudes\n*4.* Integraciones\n*5.* Otro',
  category_invalid: 'Por favor, responde *1*, *2*, *3*, *4* o *5*, o escribe el nombre de una de las opciones.',
  other_email_exit: 'No pudimos identificar claramente tu solicitud dentro de las opciones disponibles. Si necesitas soporte, comunícate con nosotros a través de nuestro correo oficial: soporte.mgt@magnetoglobal.com. Nuestro equipo revisará tu caso y te orientará.',
  data_notice_and_ask_name: 'Seleccionaste: *{{categoria}}*.\n\nA continuación te pediremos algunos datos para brindarte una atención más cercana y precisa.\n\n¿Cuál es tu nombre completo?',
  ask_company: 'Gracias, {{nombre}}. ¿Cuál es el nombre de tu empresa?',
  ask_email: '¿Cuál es tu correo electrónico corporativo?',
  ask_issue: 'Cuéntanos brevemente qué sucede. Incluye el mensaje de error y el paso en el que se presenta, si aplica.',
  confirm_summary: 'Por favor, revisa la información antes de crear el ticket:\n\n*Categoría:* {{categoria}}\n*Nombre:* {{nombre}}\n*Empresa:* {{empresa}}\n*Correo:* {{correo}}\n*Descripción:* {{situacion}}\n\n*1.* Confirmar y crear ticket\n*2.* Corregir información',
  confirm_invalid: 'Por favor, responde *1* para confirmar y crear el ticket o *2* para corregir la información.',
  restart_data: 'De acuerdo. Volvamos a revisar tus datos.\n\n¿Cuál es tu nombre completo?',
  processing: 'Estamos creando tu ticket. Un momento, por favor.',
  confirmation: '✅ Tu solicitud fue registrada correctamente.\n\n{{radicado}}\n\nNuestro equipo revisará el caso y se pondrá en contacto contigo.',
  ticket_error: 'No pudimos crear tu ticket en este momento. Tu información no quedó registrada como un caso. Por favor, inténtalo nuevamente más tarde.',
  // Kept only for historical flow catalogs and terminal legacy cleanup.
  initial_filter: 'Bienvenido al canal de soporte de Integraciones de *Magneto365*.\n\nℹ️ Este canal es exclusivo para atención a dudas y novedades técnicas sobre integraciones.\n\n¿Su requerimiento está relacionado con alguna integración? (Responda *SI* o *NO*)',
  ask_name: 'Entendido. Procederemos con el registro. Por favor, indíqueme su *Nombre Completo*:',
  filter_no_menu: 'Hola. Te damos la bienvenida al canal de soporte para analistas de *Magneto365*.\n\nPara orientarte, indícanos quién eres:\n*1.* Analista\n*2.* Candidato o candidata',
  filter_no_analyst: '👨‍💻 *ZONA DE ANALISTAS - MAGNETO365*\n\nPara brindarte un soporte técnico seguro y garantizado, todas tus consultas y reportes deben registrarse mediante nuestro buzón oficial.\n\n📧 *Envíanos un correo directamente a:*\nsoporte.mgt@magnetoglobal.com\n\nUno de nuestros asesores de soporte tomará tu caso y te contactará. ¡Feliz día! ✨',
  filter_no_candidate: 'Gracias por escribirnos. Este canal atiende únicamente solicitudes de analistas.\n\nSi eres candidato o candidata, comunícate con la empresa responsable de tu proceso o utiliza los canales de ayuda disponibles en la plataforma donde realizaste tu postulación. No compartas datos personales adicionales por este chat.',
  filter_no_invalid: 'Por favor, responde *1* si eres analista o *2* si eres candidato o candidata.',
});

function interpolate(template, values = {}) {
  return String(template).replace(/{{\s*([\w.]+)\s*}}/g, (_, key) => {
    const value = values[key];
    return value === undefined || value === null ? '' : String(value);
  });
}

function escapeWhatsApp(value) {
  return String(value ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/([*_~`])/g, '\\$1').replace(/\s+/g, ' ').trim();
}

module.exports = { FALLBACK_MESSAGES, escapeWhatsApp, interpolate };
