-- NEXO Admin Panel — Phase 3 bot flow seed artifact
-- Execute manually in Supabase SQL editor when ready. This file must not be run automatically.
-- Idempotent: inserts global version 1 fallback templates only when the step is missing.

-- Enforce one effective bot step per version, area scope, and runtime step key.
-- COALESCE makes global NULL area rows compare consistently for uniqueness.
CREATE UNIQUE INDEX IF NOT EXISTS bot_flows_effective_identity_uidx
ON bot_flows (version_id, COALESCE(area_id, 0), step_key);

INSERT INTO bot_flows (version_id, area_id, step_key, message, sort_order, active)
SELECT 1, NULL, seed.step_key, seed.message, seed.sort_order, true
FROM (VALUES
  ('out_of_office', 'Estimado usuario, gracias por contactar al área de Integraciones de *Magneto365*. 🌐

Le informamos que actualmente no nos encontramos en horario de atención. Una vez retomemos actividades, estaremos dando respuesta a su requerimiento. Gracias por su comprensión.', 10),
  ('initial_filter', 'Bienvenido al canal de soporte de Integraciones de *Magneto365*.

ℹ️ Este canal es exclusivo para atención a dudas y novedades técnicas sobre integraciones.

¿Su requerimiento está relacionado con alguna integración? (Responda *SI* o *NO*)', 20),
  ('ask_name', 'Entendido. Procederemos con el registro. Por favor, indíqueme su *Nombre Completo*:', 30),
  ('filter_no_menu', 'Para orientarlo correctamente, por favor indíquenos:

Escriba *1* si es *Analista*.
Escriba *2* si es *Candidato* o *Candidata*.', 40),
  ('filter_no_analyst', '👨‍💻 *ZONA DE ANALISTAS - MAGNETO365*

Para brindarte un soporte técnico seguro y garantizado, todas tus consultas y reportes deben registrarse mediante nuestro buzón oficial.

📧 *Envíanos un correo directamente a:*
soporte.mgt@magnetoglobal.com

Uno de nuestros asesores de soporte tomará tu caso y te contactará. ¡Feliz día! ✨', 50),
  ('filter_no_candidate', '👋 *Atención a Candidatos:*

Si requiere soporte o ayuda con su proceso, debe escalar su solicitud a través de nuestro canal oficial:

🔗 https://static.magneto365.com/widgets/help/index.html

¡Muchos éxitos en su búsqueda laboral! ✨', 60),
  ('filter_no_invalid', 'Por favor, responda *1* para Analista o *2* para Candidato.', 70),
  ('ask_company', 'Gracias, {{nombre}}. Indíqueme el nombre de la *Empresa o Cliente* afectado:', 80),
  ('ask_email', 'Proporcione su *Correo Electrónico Corporativo*:', 90),
  ('ask_issue', 'Describa detalladamente su *Requerimiento Técnico o Incidencia*:', 100),
  ('processing', '📋 *Procesando solicitud técnica en Magneto365...*', 110),
  ('confirmation', '✅ *SOLICITUD RECIBIDA*

El equipo técnico de Integraciones ha sido notificado sobre tu novedad.
{{radicado}}

Un asesor revisará tu caso y te contactará pronto por este medio. ¡Gracias!', 120),
  ('ticket_error', '⚠️ Ocurrió un error al registrar su solicitud. Por favor intente nuevamente o contacte a soporte.mgt@magnetoglobal.com', 130)
) AS seed(step_key, message, sort_order)
WHERE NOT EXISTS (
  SELECT 1
  FROM bot_flows existing
  WHERE existing.area_id IS NULL
    AND existing.version_id = 1
    AND existing.step_key = seed.step_key
);
