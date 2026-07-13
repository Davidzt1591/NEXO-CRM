# Checklist de QA manual — NEXO

Checklist de validación funcional para negocio antes de liberar NEXO. Capturar evidencia suficiente sin secretos, tokens ni datos personales reales.

## Reglas de evidencia

- [ ] Usar datos sintéticos o anonimizados.
- [ ] Capturar URL/ruta, rol usado, hora, `ticket_id` y resultado esperado/obtenido.
- [ ] Ocultar tokens, teléfonos reales, correos, claves, Authorization headers y mensajes sensibles.
- [ ] Preferir capturas recortadas y logs redactados.
- [ ] Registrar errores con código HTTP y mensaje seguro, no payloads completos con PII.

## Preparación

- [ ] Backend y frontend activos.
- [ ] SQL requerido aplicado en Supabase por operador.
- [ ] Usuario admin y al menos un agente disponibles.
- [ ] Áreas, analistas y flujos base creados.
- [ ] Token de diagnóstico/QA temporal disponible sin compartir su valor.
- [ ] Salesforce sandbox o entorno controlado definido para pruebas live.

## Admin: login y panel

- [ ] Admin inicia sesión y accede a `/admin`.
- [ ] Usuario agente no puede acceder a funciones admin.
- [ ] Token inválido o vencido recibe rechazo claro (`401`/`403`).
- [ ] Panel carga áreas, analistas, cola, flujos, reportes y auditoría sin errores críticos.
- [ ] Evidencia: rol, ruta, hora, resultado y captura sin token.

## Áreas y analistas

- [ ] Crear área con nombre, mensaje de bienvenida y SLA.
- [ ] Editar área y validar que los cambios se reflejan.
- [ ] Desactivar área y confirmar que no se usa para nuevo enrutamiento operativo.
- [ ] Crear analista asociado a token y área.
- [ ] Cambiar disponibilidad del analista.
- [ ] Validar que acciones admin generan entrada en auditoría.

## Gestión de flujos del bot

- [ ] Crear o editar paso de flujo por área/versionado.
- [ ] Validar que `step_key` soportado se guarda correctamente.
- [ ] Intentar duplicado de versión/área/paso y esperar conflicto controlado.
- [ ] Publicar/activar cambio y validar respuesta del bot en conversación de prueba.
- [ ] Confirmar que la caché no deja respuestas obsoletas después de la invalidación esperada.

## Cola, enrutamiento y SLA

- [ ] Crear ticket de prueba con área válida.
- [ ] Confirmar que aparece en cola admin/agente correspondiente.
- [ ] Asignar ticket manualmente a un analista disponible.
- [ ] Transferir o desasignar ticket y validar actualización en tiempo real.
- [ ] Confirmar que tickets fuera del área del agente no se exponen indebidamente.
- [ ] Forzar ticket con SLA vencido y validar indicador/alerta.

## Dashboard de agente y sockets

- [ ] Agente inicia sesión y ve solo tickets autorizados.
- [ ] Mensaje entrante aparece sin refrescar página.
- [ ] Mensaje saliente se refleja en conversación y cola.
- [ ] Cambio de asignación llega por socket al admin/agente correcto.
- [ ] Reconexión del navegador no duplica mensajes ni pierde selección de ticket.
- [ ] Cierre de sesión/desconexión actualiza presencia o disponibilidad esperada.

## Flujo candidato por WhatsApp

- [ ] Candidato inicia conversación desde número de prueba.
- [ ] Bot responde bienvenida y pasos configurados.
- [ ] Selección de área crea o actualiza ticket con `area_id` correcto.
- [ ] Mensaje posterior queda asociado al `ticket_id` correcto.
- [ ] Derivación a agente mantiene contexto visible.
- [ ] No usar teléfonos ni nombres reales en evidencia.

## Salesforce: Case con `ticket_id`

Usar solo entorno controlado. Cada operación debe incluir `ticket_id` autorizado.

- [ ] Crear Case desde ticket y confirmar vínculo local (`sf_case_id`/CaseNumber si aplica).
- [ ] Leer Case asociado al mismo `ticket_id`.
- [ ] Actualizar campos permitidos del Case.
- [ ] Asignar Case al analista actual.
- [ ] Cerrar Case con `resolucion` y campos requeridos.
- [ ] Validar que Case Id distinto al del ticket falla por mismatch.
- [ ] Validar que operación sin `ticket_id` falla antes de llamar Salesforce.
- [ ] Evidencia: `ticket_id`, Case Id/CaseNumber, operación, resultado; sin payload sensible.

## Medios y adjuntos

- [ ] Subir imagen JPEG/PNG/GIF/WebP válida dentro del límite.
- [ ] Subir PDF válido dentro del límite.
- [ ] Confirmar registro de metadatos de adjunto en Supabase sin guardar binario.
- [ ] Intentar audio (`audio/*`) y esperar bloqueo controlado.
- [ ] Intentar video (`video/*`) y esperar bloqueo controlado.
- [ ] Intentar archivo que no coincide con su mimetype y esperar rechazo.
- [ ] Intentar archivo mayor al límite y esperar rechazo.

## Reportes y auditoría

- [ ] Reporte resumen carga sin `404` ni `5xx`.
- [ ] Métricas reflejan tickets abiertos/cerrados, SLA y asignaciones esperadas.
- [ ] Auditoría registra creación/edición de áreas, analistas, flujos y asignaciones.
- [ ] Filtros de auditoría funcionan por acción, actor, target y fecha.
- [ ] No se muestran secretos ni datos sensibles en reportes/logs.

## Escenarios de falla

### Salesforce no disponible

- [ ] Simular indisponibilidad o usar ventana controlada.
- [ ] Operación falla con error seguro y sin filtrar credenciales.
- [ ] Ticket local no queda marcado como cerrado si Salesforce no confirmó cierre.
- [ ] Operador puede reintentar o escalar con IDs técnicos.

### Token no autorizado

- [ ] Request sin token recibe `401`/rechazo esperado.
- [ ] Token agente intenta acción admin y recibe `403`.
- [ ] Token de otra área no accede a ticket no autorizado.
- [ ] Logs no imprimen el token.

### Ticket sin área

- [ ] Ticket sin `area_id` no se enruta silenciosamente a un agente incorrecto.
- [ ] Admin puede identificarlo en cola o reporte operativo.
- [ ] Asignación manual exige corrección explícita o ruta controlada.

### SLA vencido

- [ ] Ticket supera `sla_minutes`.
- [ ] Cola/reportes muestran alerta o estado vencido.
- [ ] Asignar/cerrar ticket actualiza estado y evidencia operacional.

## Criterio de cierre QA

- [ ] Todos los escenarios críticos pasan.
- [ ] Fallas conocidas tienen severidad, responsable y decisión go/no-go.
- [ ] Evidencia guardada sin secretos ni PII.
- [ ] `npm run diagnose` no reporta `FAIL` inesperados.
- [ ] Responsable de negocio aprueba el go/no-go.
