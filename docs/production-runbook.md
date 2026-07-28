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

### Runtime soportado

Los manifiestos declaran compatibilidad **Node.js >=22.12 <23** y **npm >=10 <12**, pero CI y la verificación de release están fijados exactamente en **Node.js 22.23.1 LTS** mediante el workflow, `.nvmrc`, `.node-version` y `runtime:check`. Otra versión de Node hace fallar `verify` aunque pertenezca al rango general de engines.

Antes de instalar dependencias, verificar el binario que ejecutará tanto npm como PM2:

```bash
node --version
npm --version
npm run runtime:check
pm2 report | grep -E "Node.js version|node.js version"
```

El resultado esperado para release es Node `v22.23.1`. `runtime:check` exige esa versión exacta y npm `>=10 <12`. `verify:unsafe-runtime` existe solo para diagnóstico local y NUNCA debe usarse en CI, producción ni despliegues.

### Contrato de dependencias y auditoría

Los runtimes Node raíz y backend se instalan exclusivamente con `npm ci --omit=dev --omit=optional`. NEXO soporta únicamente `LocalAuth`; `WHATSAPP_AUTH_STRATEGY` puede omitirse o ser `local`, y cualquier otro valor bloquea el arranque. La dependencia opcional `archiver`, usada por la capacidad RemoteAuth que NEXO no soporta, y sus cadenas `brace-expansion` vulnerables permanecen registradas en los lockfiles para reproducibilidad, pero NO forman parte de `node_modules` ni de la auditoría desplegada.

```bash
npm ci --omit=dev --omit=optional
npm run audit:production
npm run verify:production-deps
npm --prefix backend ci --omit=dev --omit=optional
npm --prefix backend run audit:production
npm --prefix backend run verify:production-deps
```

El verificador examina recursivamente el JSON completo de `npm ls --all --json --omit=dev --omit=optional`, contrasta las dependencias instaladas únicamente con `dependencies` de cada `package.json`, falla ante salida inválida, dependencias de producción faltantes/inválidas/extraneous o cualquier error del comando y además intenta resolver cada paquete excluido desde los directorios runtime reales raíz/backend. La ausencia intencional de `devDependencies` y `optionalDependencies` no es un error. Cada entrypoint inspecciona ambos árboles antes de inicializar la aplicación, por lo que también bloquea paquetes excluidos anidados que no sean resolubles desde la raíz. Usa el CLI npm ubicado junto al binario Node activo (incluido el layout portable de Node 22) y solo recurre a `npm_execpath` si apunta a un CLI JavaScript existente; si no puede localizarlo, el arranque de producción falla cerrado.

Esta inspección agrega dos ejecuciones completas de `npm ls` al arranque (una por árbol runtime). La latencia depende del tamaño y del almacenamiento de `node_modules` y puede ser de varios segundos en discos lentos; debe presupuestarse en los timeouts del supervisor. En desarrollo, cualquier topología insegura o fallo del inspector conserva la política de advertencia y permite continuar para diagnóstico.

El frontend se instala con todas sus dependencias solo en el entorno de build, donde se ejecutan `npm --prefix frontend run audit:build` y `npm --prefix frontend run build`. El artefacto estático `frontend/dist` no ejecuta `npm install`; `audit:production` documenta por separado la topología npm de producción del manifiesto frontend. No usar el audit completo del lockfile como sustituto del gate desplegado ni ocultarlo: reportar ambos resultados por separado.

PM2 debe iniciarse desde una shell donde `node --version` ya devuelva `v22.23.1`. Después de instalar/activar Node 22.23.1, reinstalar PM2 con ese mismo npm y recrear el daemon antes de iniciar NEXO:

```bash
nvm install 22.23.1
nvm use 22.23.1
node --version
npm --version
npm install --global pm2@6.0.14
pm2 kill
node "$(npm root --global)/pm2/bin/pm2" startOrRestart ecosystem.config.js --env production --update-env
node "$(npm root --global)/pm2/bin/pm2" report | grep -E "node version|node path|argv0"
```

No ejecutar `pm2 kill` ni reiniciar aplicaciones fuera de una ventana de despliegue aprobada. Tanto el daemon como cada aplicación deben reportar Node `22.23.1` antes del go-live.

En Windows, conservar el runtime portable en la ruta durable e ignorada del repositorio. Resolver siempre las rutas desde `$RepoRoot` y el perfil del usuario actual:

```powershell
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path # desde scripts/; o resolver el checkout explícitamente
$withNode22 = Join-Path $RepoRoot 'scripts\with-node22.ps1'
$node22 = Join-Path $RepoRoot '.runtime\node-v22.23.1-win-x64\node.exe'
$localPm2 = Join-Path $RepoRoot 'node_modules\pm2\bin\pm2'
$globalPm2 = Join-Path $env:APPDATA 'npm\node_modules\pm2\bin\pm2'
$pm2 = if (Test-Path $localPm2) { $localPm2 } elseif (Test-Path $globalPm2) { $globalPm2 } else { throw 'PM2 CLI not found' }

& $withNode22 node --version
& $withNode22 npm --version
& $withNode22 npm run runtime:check

# SOLO durante la ventana aprobada: termina el daemon antiguo de Node 25 y recrea todo con Node 22.
& $withNode22 node $pm2 kill
$env:NODE_ENV = 'production'
$env:PM2_WATCH_BACKEND = 'false'
$env:PM2_USE_SYSTEM_CA = 'false'
# Configurar antes los secretos y la topología requerida en el entorno del usuario/proceso.
& $withNode22 node $pm2 startOrRestart (Join-Path $RepoRoot 'ecosystem.config.js') --env production --update-env --interpreter $node22
& $withNode22 node $pm2 report
& $withNode22 node $pm2 jlist
```

Si Node 22.23.1 se instala de forma nativa, usar el mismo procedimiento sustituyendo únicamente `$node22`:

```powershell
$node22 = 'C:\Program Files\nodejs\node.exe'
```

En `pm2 report`, `Daemon / node version`, `CLI / node version` y `argv0` deben resolver al runtime 22.23.1; en `pm2 jlist`, cada `pm2_env.node_version` debe ser `22.23.1` y `exec_interpreter` debe corresponder al Node 22 solicitado. `.runtime/` está ignorado: nunca agregar sus binarios al commit.

Antes de la ventana, ejecutar el preflight sin secretos impresos ni acciones de despliegue:

```powershell
& (Join-Path $RepoRoot 'scripts\with-node22.ps1') npm run runtime:check
& (Join-Path $PSHOME 'powershell.exe') -NoProfile -File (Join-Path $RepoRoot 'scripts\deployment-preflight.ps1') `
   -RepoRoot $RepoRoot -Phase PreSwitch -Topology LocalLoopback `
   -EnvironmentFile (Join-Path $RepoRoot 'backend\.env') `
   -NoRollbackAcceptanceEvidence '<reference to recorded operator acceptance>'

# Validación no mutante del contrato del script (también ejecutada por CI):
& (Join-Path $PSHOME 'powershell.exe') -NoProfile -File (Join-Path $RepoRoot 'scripts\deployment-preflight.ps1') `
  -RepoRoot $RepoRoot -Phase PreSwitch -Topology LocalLoopback -CheckOnly
```

`-CheckOnly` valida estáticamente scripts, configuración, topología y artefactos; no consulta PM2 ni exige evidencia de rollback. `-Phase PreSwitch` sin `-CheckOnly` inventaría en modo lectura el daemon, las apps y todos los listeners. Acepta únicamente el predecesor exacto Node 25.6.1, exige evidencia explícita de aceptación de no rollback, las dos apps esperadas online y ningún listener desconocido. Ningún modo instala, compila, escribe archivos, reinicia o despliega.

Después del cambio, ejecutar `-Phase PostSwitch` (o el alias `-RequirePm2Node22`) con la misma topología y `-ReleaseValidationToken` (el valor no se registra). Ese modo exige daemon y apps Node 22.23.1, atribución exclusiva de listeners y ejecuta salud exacta, hash del frontend y validación real de creación/restauración/limpieza de sesión y conexión Socket.IO. Node 25 es siempre un fallo en PostSwitch.

La topología nunca se toma del entorno ambiente del caller. `-Topology LocalLoopback` lee `env_production` de `ecosystem.config.js` y exige exactamente `HOST=127.0.0.1`, `ALLOWED_ORIGINS=http://localhost:5173`, `ALLOW_INSECURE_LOCAL_COOKIE=true`, `SESSION_COOKIE_SECURE=false` y `TRUST_PROXY_CIDRS` vacío. `-Topology ReverseProxyHttps` exige parámetros externos explícitos: `-AllowedOrigins`, `-SessionCookieSecure true` y `-TrustedProxyCidrs`; no reutiliza valores ambiente.

El arranque aprobado (`iniciar.bat`) propaga cualquier código de fallo de Node, npm, PM2 o validación. Después de `startOrRestart`, `validate-running-release.ps1` enumera TODOS los listeners IPv4/IPv6 de 3001/5173 con dirección, PID, proceso y comando; no termina ninguno. Exige que cada listener pertenezca al PID exacto de la aplicación PM2 o al PID verificado del PM2 cluster daemon en Windows, daemon y apps en Node 22.23.1, el cuerpo exacto `{"status":"ready","ready":true}` desde el `HOST` loopback configurado y el hash de `frontend/dist` del último manifiesto. Un listener desconocido, duplicado o una respuesta stale es no-go.

`with-node22.ps1` valida Node `22.23.1`, npm `10.9.8` y el checksum del binario antes de anteponer el runtime portable a `PATH`. Ejecutar npm mediante `node npm-cli.js` sin cambiar `PATH` NO es suficiente: los scripts lifecycle resolverían el `node` global del host.

> Usar placeholders en notas y tickets. No pegar tokens, claves privadas, credenciales ni datos personales.

- [ ] `.env`/variables inyectadas existen en el ambiente correcto.
- [ ] `SUPABASE_URL` configurado.
- [ ] Clave backend de Supabase configurada; preferir `SUPABASE_SERVICE_ROLE_KEY` server-side.
- [ ] Configuración Salesforce presente: `SALESFORCE_CLIENT_ID`, usuario/credenciales JWT o mecanismo vigente.
- [ ] `SALESFORCE_PRIVATE_KEY` o `SALESFORCE_PRIVATE_KEY_PATH` configurado sin registrar el contenido.
- [ ] `FRONTEND_URL` apunta al origen público esperado.
- [ ] `FRONTEND_URL` o `ALLOWED_ORIGINS` contiene cada origen web exacto autorizado (sin comodines).
- [ ] `SESSION_COOKIE_SECURE=true` en producción HTTPS.
- [ ] `SESSION_MAX_AGE_SECONDS` coincide con la vigencia operativa del token (300–86400; 28800 por defecto).
- [ ] `TRUST_PROXY_CIDRS` contiene únicamente proxies conocidos cuando TLS termina antes de Node.
- [ ] Tokens de dashboard creados y con roles correctos (`admin`, `agent`).
- [ ] SQL de Supabase aplicado manualmente por el operador y revisado.
- [ ] WhatsApp Web autorizado para la cuenta operacional correcta.
- [ ] TLS no está deshabilitado globalmente (`NODE_TLS_REJECT_UNAUTHORIZED=0` no debe usarse en producción).

## PM2: local vs producción

## Migración de sesión HttpOnly

1. Configurar los orígenes exactos, cookie segura y proxy confiable antes de reiniciar.
2. Desplegar backend y frontend en la misma ventana: el frontend nuevo no envía Bearer desde JavaScript.
3. Validar `POST/GET/DELETE /api/session`, restauración tras recarga y reconexión Socket.IO.
4. Confirmar que una mutación con origen ausente/foráneo devuelve `403 CSRF_REJECTED` y que un cliente API Bearer sigue funcionando con cabeceras de deprecación.
5. Informar a usuarios que deberán ingresar el token una vez; instalaciones previas eliminan `nexo_token` al iniciar.

Rollback: restaurar ambos artefactos juntos. No conservar un frontend cookie-only contra un backend anterior.

### Topologías permitidas

- **HTTPS/reverse proxy:** definir orígenes HTTPS exactos, `SESSION_COOKIE_SECURE=true`, `HOST` según la interfaz privada requerida y `TRUST_PROXY_CIDRS` solo para el proxy TLS. Sin `VITE_API_BASE_URL`, una página HTTPS usa API same-origin.
- **Desktop local excepcional:** la configuración PM2 incluida usa únicamente `http://localhost:5173`, `HOST=127.0.0.1` y `ALLOW_INSECURE_LOCAL_COOKIE=true`. Esta combinación falla al iniciar si el bind o algún origen no es loopback. **Nunca usar esta excepción en LAN, una interfaz de red o detrás de reverse proxy.**
- **Backend separado:** compilar el frontend con `VITE_API_BASE_URL` explícita. Ese valor siempre prevalece.

En producción no existen orígenes localhost implícitos. La ausencia de orígenes o `HOST` explícitos bloquea el arranque, y las cookies son `Secure` por defecto salvo la excepción loopback completa.

### Ventana de revocación Socket.IO

Cada socket autenticado revalida pasivamente su sesión aunque no envíe eventos. `SOCKET_AUTH_REVALIDATE_MS` acepta únicamente 15000–30000 ms y usa 20000 ms por defecto. Por lo tanto, la ventana máxima configurada para retirar salas protegidas y desconectar una sesión revocada inactiva es 30 segundos. Una indisponibilidad del validador también retira las salas y desconecta de forma fail-closed; el cliente aplica su backoff de reconexión.

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
NEXO_NODE22=/ruta/node-v22.23.1/bin/node node "$(npm root --global)/pm2/bin/pm2" startOrRestart ecosystem.config.js --only nexo-backend --env production --update-env
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

En Windows, el backend fija `--test-concurrency=1` porque el aislamiento concurrente del test runner de Node 22 produjo errores intermitentes de deserialización/clonado entre procesos. La serialización reduce throughput, pero evita falsos negativos de infraestructura sin reintentar ni ocultar fallos reales.

### Salud pública y validación de autenticación

- `GET /health` no requiere autenticación y responde únicamente `status` y `ready`; no expone diagnósticos, capacidad, carga, reintentos ni tiempos internos.
- Cada nueva petición REST y cada nuevo handshake de socket vuelven a validar el token contra Supabase. No existe una ventana de caché positiva: una revocación confirmada se rechaza en la siguiente validación.
- Solo las validaciones simultáneas del mismo token comparten la operación activa. Los reintentos continúan limitados, cancelables y sujetos al límite global de validaciones en curso.
- Para investigar degradación, usar los logs protegidos del backend; no ampliar la respuesta pública de `/health` con metadatos operativos.

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

### Phase 10: baseline de áreas y enrutamiento

La línea base productiva confirmada antes de Phase 10 contiene exactamente un área activa: `Soporte Integraciones` (`id=1`). No existe un área Magneto. Phase 10 reutiliza esa fila sin renombrarla y crea `Soporte Magneto` con los defaults reales de `public.areas`.

1. Volver a ejecutar manualmente `backend/supabase/phase10_area_routing_preflight.sql`.
2. Continuar solo si devuelve `status=PASS` y el detalle indica: `Reuse active Soporte Integraciones; create active Soporte Magneto using schema defaults.`
3. Si informa aliases duplicados/inactivos o columnas `NOT NULL` sin default, detenerse y corregir la línea base con un cambio revisado; no inventar valores.
4. Aplicar manualmente `backend/supabase/phase10_area_routing.sql`. Es reejecutable: reutiliza ambas áreas y reestablece los cuatro mappings estables. Un advisory transaction lock serializa la creación de `Soporte Magneto` entre ejecuciones de Phase 10.
5. Ejecutar `backend/supabase/phase10_area_routing_postflight.sql`. Es una única sentencia de solo lectura y debe devolver un único resultado `check_name/status/detail`; cada fila debe ser `PASS`. No crea objetos, no modifica datos, no depende de estado de sesión y no muestra ACLs crudos. Las comprobaciones canónicas consultan directamente `public.areas` y `public.category_area_mappings`, porque este postflight se ejecuta únicamente después de una migración exitosa. Si falta una de esas relaciones centrales, PostgreSQL puede producir un error de resolución durante el análisis de la sentencia; los demás objetos opcionales se resuelven mediante `to_regclass` o `to_regprocedure` y generan filas `FAIL` cuando faltan.

Si Phase 10 ya fue aplicada, ejecutar en este orden: `phase10_area_routing_preflight.sql`, `phase10_area_routing_acl_fix.sql` y el `phase10_area_routing_postflight.sql` actualizado. Detenerse ante cualquier `FAIL`. El fix es transaccional, habilita RLS sin forzarlo, elimina privilegios de tablas/secuencias de `PUBLIC`, `anon` y `authenticated`, conserva los roles de plataforma permitidos por Phase 9 y restaura únicamente los privilegios exactos de `service_role`.

No se ejecutó SQL real de PostgreSQL como parte de la verificación estática local; preflight, migración y postflight siguen siendo pasos manuales del operador.

## Rollback y recuperación básica

### Restricción del primer cutover

El backend que hoy está ejecutando PM2 proviene de un árbol previamente no confirmado y mantenido en memoria por el proceso. Ese runtime anterior **no es recuperable de forma reproducible** desde este checkout: no existe un artefacto fuente/build versionado que permita reconstruirlo con certeza. Antes del primer cutover se requiere aceptación explícita y registrada de este riesgo; sin esa aceptación, el resultado es **no-go**. No llamar “rollback” a reiniciar un artefacto que no existe.

Para cada release futura, antes de reiniciar, preservar una versión identificada del código fuente y del build (`frontend/dist`), su checksum, configuración no secreta y manifiesto de despliegue. Solo entonces la restauración conjunta de backend/frontend puede considerarse un rollback reproducible.

- [ ] Identificar versión anterior conocida como estable.
- [ ] Detener tráfico o activar página/estado de mantenimiento si aplica.
- [ ] Confirmar que el build/código anterior versionado existe y coincide con su checksum; si no existe, detenerse y declarar que no hay rollback reproducible.
- [ ] Validar que el manifiesto de rollback contiene `gitCommit`, `frontendDistSha256` y `expectedNodeVersion=v22.23.1` antes de tocar procesos: `& $preflight -RepoRoot $RepoRoot -CheckOnly` para contrato y `& $preflight -RepoRoot $RepoRoot -EnvironmentFile $envFile -RollbackManifestPath $rollbackManifest` dentro de la preparación aprobada.
- [ ] Restaurar juntos backend y frontend desde ese artefacto preservado y reiniciar el proceso.
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

Equivalente portable en PowerShell (sin asumir el directorio actual):

```powershell
$RepoRoot = (Resolve-Path '<checkout-nexo>').Path
$withNode22 = Join-Path $RepoRoot 'scripts\with-node22.ps1'
& $withNode22 npm run diagnose
& $withNode22 node (Join-Path $env:APPDATA 'npm\node_modules\pm2\bin\pm2') status
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
