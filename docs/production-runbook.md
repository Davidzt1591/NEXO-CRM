# Runbook de producción — NEXO

Guía operativa para preparar, validar y recuperar NEXO en ambientes productivos o preproductivos. No incluye valores secretos ni reemplaza la gestión formal de cambios.

## Alcance

- Backend Node.js, frontend React/Vite, Supabase, Salesforce, WhatsApp Web y PM2.
- Validaciones seguras antes/después de despliegue.
- Diagnóstico no destructivo y recuperación básica.

Fuera de alcance: ejecutar SQL remoto automáticamente, pruebas destructivas contra Salesforce, rotación real de secretos y cambios manuales no registrados.

## Ruta rápida go/no-go

1. **Congelar alcance**: confirmar versión, responsable, ventana de despliegue y rollback.
2. **Configurar sin exponer secretos**: validar presencia de variables, nunca imprimir valores.
3. **Validar base de datos**: confirmar que el operador aplicó manualmente el SQL requerido en Supabase.
4. **Arrancar servicios**: backend/frontend con PM2 o el orquestador definido.
5. **Ejecutar diagnóstico**:
   ```bash
   npm run diagnose
   ```
6. **Ejecutar verificación técnica si la ventana lo permite**:
   ```bash
   npm run verify
   ```
7. **Hacer smoke QA manual**: login, panel admin, cola, ticket, Salesforce seguro y cierre.
8. **Go** si no hay `FAIL`, no hay errores críticos en logs y el QA mínimo pasa.
9. **No-go** si hay fallos de autenticación, pérdida de cola/mensajes, errores 5xx persistentes, Salesforce no autorizado o SQL pendiente.

## Checklist de configuración requerida

> Usar placeholders en notas y tickets. No pegar tokens, claves privadas, credenciales ni datos personales.

- [ ] `.env`/variables inyectadas existen en el ambiente correcto.
- [ ] `SUPABASE_URL` configurado.
- [ ] Clave backend de Supabase configurada; preferir `SUPABASE_SERVICE_ROLE_KEY` server-side.
- [ ] Configuración Salesforce presente: `SALESFORCE_CLIENT_ID`, usuario/credenciales JWT o mecanismo vigente.
- [ ] `SALESFORCE_PRIVATE_KEY` o `SALESFORCE_PRIVATE_KEY_PATH` configurado sin registrar el contenido.
- [ ] `FRONTEND_URL` apunta al origen público esperado.
- [ ] Tokens de dashboard creados y con roles correctos (`admin`, `agent`).
- [ ] SQL de Supabase aplicado manualmente por el operador y revisado.
- [ ] WhatsApp Web autorizado para la cuenta operacional correcta.
- [ ] TLS no está deshabilitado globalmente (`NODE_TLS_REJECT_UNAUTHORIZED=0` no debe usarse en producción).

## PM2: local vs producción

### Local/desarrollo

Para refrescar el backend local con watch y CA del sistema:

```bash
PM2_WATCH_BACKEND=true PM2_USE_SYSTEM_CA=true pm2 startOrRestart ecosystem.config.js --only nexo-backend --env development --update-env
```

Uso esperado: desarrollo local cuando se necesita recarga por cambios de backend.

### Producción

- [ ] No habilitar `PM2_WATCH_BACKEND` por defecto.
- [ ] Usar `--env production` o variables administradas por el orquestador.
- [ ] Confirmar `PM2_WATCH_BACKEND=false`.
- [ ] Confirmar logs persistentes y rotación externa si aplica.
- [ ] Reiniciar solo dentro de ventana aprobada.

Ejemplo sin secretos:

```bash
pm2 startOrRestart ecosystem.config.js --only nexo-backend --env production --update-env
pm2 status
pm2 logs nexo-backend --lines 100
```

## Diagnóstico y verificación

### Diagnóstico seguro

```bash
npm run diagnose
```

Opcional con token temporal de diagnóstico en el entorno, sin imprimirlo:

```bash
NEXO_DIAG_BASE_URL=https://<backend-url> NEXO_DIAG_TOKEN=<token-temporal> npm run diagnose
```

Con pruebas backend incluidas:

```bash
npm run diagnose -- --with-tests
```

El diagnóstico es intencionalmente no destructivo: no ejecuta SQL remoto en Supabase y no crea/actualiza/cierra/sube archivos reales en Salesforce.

### Verificación técnica

```bash
npm run verify
```

Resultado esperado: sin pruebas enfocadas (`.only`), tests de diagnóstico/backend/frontend en verde.

## Límites de Salesforce y Supabase

### Salesforce

- [ ] Crear, leer, actualizar, asignar y cerrar Cases solo desde flujos QA controlados.
- [ ] Toda operación de Case debe incluir `ticket_id` autorizado.
- [ ] No usar payloads con tokens, Authorization, datos personales reales o secretos.
- [ ] El diagnóstico no ejecuta operaciones destructivas/live de Salesforce.
- [ ] Subidas permitidas: imágenes y PDF dentro del límite operativo.
- [ ] Audio/video permanecen bloqueados intencionalmente.

### Supabase

- [ ] SQL se aplica manualmente por operador/persona autorizada.
- [ ] No ejecutar SQL destructivo desde scripts de diagnóstico.
- [ ] Validar tablas, RLS/permisos y datos semilla con consultas de solo lectura.
- [ ] No copiar datos personales en tickets de soporte o evidencia.

## Rollback y recuperación básica

- [ ] Identificar versión anterior conocida como estable.
- [ ] Detener tráfico o activar página/estado de mantenimiento si aplica.
- [ ] Restaurar build/commit anterior y reiniciar proceso.
- [ ] Revertir cambios de configuración solo desde gestor seguro de secretos.
- [ ] Si hubo SQL manual, aplicar plan de reversa revisado; no improvisar en producción.
- [ ] Reejecutar `npm run diagnose` y smoke QA mínimo.
- [ ] Documentar causa, hora de inicio/fin, acciones y responsable.

Comandos útiles de observación:

```bash
pm2 status
pm2 logs nexo-backend --lines 200
npm run diagnose
```

Reinicio controlado, solo en ventana aprobada o durante recuperación:

```bash
pm2 restart nexo-backend --update-env
```

## Incidentes, logs y seguridad

Durante un incidente, registrar:

- [ ] Fecha/hora, ambiente, versión y responsable.
- [ ] Síntoma observable y alcance: admin, agentes, candidatos, Salesforce, Supabase o WhatsApp.
- [ ] Comandos ejecutados y resultado resumido.
- [ ] IDs técnicos permitidos: `ticket_id`, Case Id, CaseNumber, sin PII.
- [ ] Extractos de logs redacted; no pegar tokens, claves, Authorization headers ni mensajes con datos sensibles.
- [ ] Decisión: mitigado, rollback, escalado o pendiente.

Cautelas obligatorias:

- Nunca commitear `.env`, tokens, claves privadas o exports de datos reales.
- No deshabilitar TLS en producción.
- No subir audio/video a Salesforce hasta que exista soporte explícito.
- No ejecutar comandos destructivos sin plan aprobado y respaldo.
