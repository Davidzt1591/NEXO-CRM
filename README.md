# NEXO - Plataforma Omnicanal de Gestion de Chats WhatsApp con IA

**Version:** 1.0.0  |  **Empresa:** Magneto 365  |  **Stack:** Node.js 22+ / Express 5 / React 19 / Supabase / Salesforce / WhatsApp Web JS

---

## Indice

1. [Descripcion General](#1-descripcion-general)
2. [Arquitectura del Sistema](#2-arquitectura-del-sistema)
3. [Backend - Modulo API (Express + Socket.IO)](#3-backend-modulo-api)
4. [Frontend - Dashboard React + Vite](#4-frontend-dashboard-react)
5. [Base de Datos - Supabase (PostgreSQL)](#5-base-de-datos-supabase)
6. [Integracion con WhatsApp](#6-integracion-con-whatsapp)
7. [Integracion con Salesforce](#7-integracion-con-salesforce)
8. [Sistema de Tickets y Flujo de Trabajo](#8-sistema-de-tickets)
9. [Seguridad Implementada](#9-seguridad-implementada)
10. [Modelo de Autenticacion y Autorizacion](#10-modelo-de-autenticacion)
11. [Variables de Entorno y Secretos](#11-variables-de-entorno)
12. [Instalacion y Configuracion](#12-instalacion)
13. [Pruebas](#13-pruebas)
14. [Estructura del Repositorio](#14-estructura-del-repositorio)
15. [Consideraciones de Ciberseguridad](#15-ciberseguridad)

---

## 1. Descripcion General

**NEXO** es una plataforma omnicanal disenada para que agentes de soporte de **Magneto 365** gestionen conversaciones de WhatsApp con candidatos, analistas y empresas desde un dashboard web unificado.

### Proposito

- Centralizar la atencion de soporte por WhatsApp en un solo lugar
- Automatizar respuestas mediante un bot inteligente con IA (Google Gemini)
- Clasificar contactos como candidatos, analistas o empresas
- Gestionar tickets de soporte con enrutamiento por areas
- Sincronizar casos con Salesforce (bidireccional)
- Mantener SLA por area y prioridad
- Operar con WebSocket en tiempo real

### Flujo de Alto Nivel

WhatsApp >> Backend (whatsapp-web.js) >> Procesamiento >> Supabase DB
                                            >> Dashboard Web (React + Socket.IO)
                                            >> Salesforce (outbox bidireccional)


## 2. Arquitectura del Sistema

### Stack Tecnologico Completo

| Capa | Tecnologia | Version |
|------|-----------|---------|
| Runtime | Node.js | >=22.12 <23 |
| Backend HTTP | Express | 5.x |
| Backend Tiempo Real | Socket.IO | 4.x |
| Frontend | React | 19.x |
| Build Frontend | Vite + Vitest | 8.x |
| Base de Datos | Supabase (PostgreSQL) | -- |
| Cliente DB | @supabase/supabase-js | 2.x |
| WhatsApp | whatsapp-web.js | (GitHub) |
| IA | Google Generative AI (Gemini) | 0.24.x |
| CRM | Salesforce REST API | v60.0 |
| Estado Frontend | Zustand | 5.x |
| Autenticacion | jsonwebtoken (JWT custom) | 9.x |
| Rate Limiting | express-rate-limit | 8.x |
| Seguridad HTTP | helmet, cors, xss, csrf | -- |
| Node Spec | CommonJS (backend) / ESM (frontend) | -- |

### Diagrama de Componentes

+---------------------------------------------------------------+
|                      FRONTEND (React 19)                        |
|  Dashboard Web --- Socket.IO Client --- Zustand Store          |
+-----------------------------+----------------------------------+
                              | HTTP REST + WebSocket
                              v
+---------------------------------------------------------------+
|                      BACKEND (Express 5)                        |
|  +----------+  +----------+  +----------+  +----------------+  |
|  |  Routes  |  |Middleware|  | Services |  |   Database     |  |
|  |  REST    |  |  Auth    |  |  Negocio |  |   Supabase     |  |
|  +----------+  +----------+  +----------+  +----------------+  |
|  +--------------------------------------------------------+   |
|  |              Socket.IO (Tiempo Real)                     |   |
|  +--------------------------------------------------------+   |
+-----------------------------+----------------------------------+
       +----------------------+----------------------+
       v                      v                      v
+----------+          +----------+           +----------+
| Supabase |          | WhatsApp |           |Salesforce|
|PostgreSQL|          |(wweb.js) |           | REST API |
| - Tickets|          | - Puppeteer|          | - Cases  |
| - Sessions|         | - QR Auth |           | - Media  |
| - Outbox |          | - Msgs   |           | - Attach |
+----------+          +----------+           +----------+


## 3. Backend - Modulo API (Express + Socket.IO)

### Estructura de Directorios

backend/
  server.js                    # Punto de entrada principal (boot sequence)
  src/
    database/
      db.js                    # Capa de acceso a Supabase (100+ funciones)
      cleanup.js               # Limpieza programada (node-cron, TTL)
    middleware/
      apiAuth.js               # Autenticacion JWT en rutas REST
      adminOnly.js             # Middleware de privilegio admin
      csrf.js                  # Proteccion CSRF personalizada
      rateLimits.js            # Rate limiting pre y post-autenticacion
      socketAuth.js            # Autenticacion JWT + revalidacion en WebSocket
    routes/
      session.js               # Login via token (rate-limited)
      salesforce.js            # Proxy REST a Salesforce
      candidates.js            # CRUD de clasificaciones de candidatos
      conversations.js         # Consultas de conversaciones
      admin.js                 # Panel admin: areas, analistas, tokens, SLA, flujos
    security/
      securityConfig.js        # Validacion de configuracion al arranque
      origins.js               # Validacion de origenes CORS dinamicos
      sessionCookie.js         # Configuracion segura de cookies
    services/
      whatsapp/                # Adaptador WhatsApp (index, wwebjs, authPolicy)
      ai.js                    # Servicio Gemini (resumen, gramatica, clasificacion)
      salesforce.js            # Cliente REST Salesforce (JWT Bearer auth)
      salesforceOutbox.js      # Outbox pattern para sincronizacion bidireccional
      salesforceMedia.js       # Subida de archivos a Salesforce
      supabase.js              # Cliente Supabase secundario
      botFlow*.js              # Motor de flujos del bot conversacional
      routing.js               # Enrutamiento de tickets por area
      slaClock.js              # Reloj de SLA (business calendar)
      ticketClose.js           # Cierre de tickets con despedida
      ticketPostProcessing.js  # Post-procesamiento post-cierre
      chatPreferences.js       # Persistencia de preferencias de chat
      conversationWorkflow.js  # Workflow engine de conversaciones
      candidateQuarantine.js   # Cuarentena de candidatos
      classificationReliability.js  # Fiabilidad de clasificacion IA
      mediaValidation.js       # Validacion de archivos multimedia
      authValidation.js        # Validacion de tokens con cache + fallback
    realtime/
      operational.js           # Logica de eventos en tiempo real
    socket.js                  # Definicion de eventos WebSocket (30+ eventos)
    store.js                   # Estado en memoria (sesiones, modos, silenciados)
    utils/
      validate.js              # Validacion de entrada compartida
      redact.js                # Sanitizacion de logs (secrets, PII)
  supabase/                    # Migraciones SQL (schema puro)
  certs/                       # Certificados publicos (salesforce.crt)
  test/                        # Tests (node --test, 405+ casos)

### Secuencia de Arranque (server.js)

1. enforceStartupDependencyTopology() - verifica topologia de dependencias
2. dotenv.config() - carga variables de entorno
3. Configura Express con: helmet, cors (origenes dinamicos), express.json
4. Crea health endpoint (/health)
5. Monta rutas con middleware de seguridad
6. Crea servidor HTTP + Socket.IO con CORS
7. Boot sequence async:
   a. initDb() - verifica conexion real a Supabase
   b. startCleanupCron() - limpieza programada por TTL
   c. restorePreferences() - restaura preferencias de chat
   d. server.listen(PORT) - expone servidor
   e. hydrateThenStart() - hidrata sesiones WhatsApp + inicia cliente Puppeteer

### API REST - Endpoints

| Metodo | Ruta | Auth | Descripcion |
|--------|------|------|-------------|
| POST | /api/session/login | No (rate-limited) | Autenticacion via token |
| POST | /api/session/validate | No (rate-limited) | Validar token activo |
| GET | /api/session/settings | Sesion activa | Configuracion del dashboard |
| GET | /health | No | Health check (liveness + readiness) |
| GET | /api/candidates | JWT | Listar clasificaciones de candidatos |
| POST | /api/candidates | JWT | Clasificar contacto como candidato |
| DELETE | /api/candidates/:chatId | JWT | Remover clasificacion |
| GET | /api/conversations | JWT | Listar conversaciones |
| GET | /api/sf/* | JWT | Proxy a Salesforce |
| GET/POST/PUT | /api/admin/* | Admin | CRUD areas, analistas, tokens, SLA, flujos, auditoria |

### WebSocket - Eventos Socket.IO

**Eventos cliente -> servidor (seleccion):**

| Evento | Descripcion | Requiere |
|--------|-------------|----------|
| get-system-info | Diagnostico del sistema | Admin |
| request-qr | Solicitar QR de WhatsApp | Admin |
| logout | Cerrar sesion de WhatsApp | Admin |
| request-pairing-code | Codigo numerico de emparejamiento | Admin |
| set-bot-activo | Activar/desactivar bot global | Admin |
| toggle-mode | Cambiar modo auto/manual de un chat | Admin |
| silence-chat / unsilence-chat | Silenciar/reactivar chat | Admin |
| force-bot | Forzar inicio del bot en un chat | Admin |
| send-message | Enviar mensaje manual (XSS sanitized, rate-limited) | JWT |
| react-message | Reaccionar a mensaje | Admin |
| get-tickets | Obtener lista de tickets | JWT (filtrado por rol) |
| assign-ticket / transfer-ticket | Asignar/transferir ticket | JWT |
| get-messages | Obtener mensajes de un ticket | JWT (autorizado) |
| close-ticket | Cerrar ticket con despedida | JWT (autorizado) |
| delete-chat | Eliminar ticket y datos del chat | JWT |
| request-summary | Resumen IA de conversacion | JWT |
| request-grammar | Correccion gramatical IA | JWT |
| redirect-support | Derivar chat a soporte general | Admin |
| get-stats | Estadisticas del sistema | Admin |

**Eventos servidor -> cliente:**

QR, bot-status, mode-changed, new-message, tickets-list, assignment-success,
summary-ready, grammar-ready, stats-data, auth-error, queue-updated,
sla-alert, ticket-assigned, ticket-removed, ticket-closed, chat-deleted,
pairing-code, principal-info, system-info
## 4. Frontend - Dashboard React + Vite

### Estructura

frontend/
  index.html
  vite.config.js
  tailwind.config.js
  src/
    main.jsx                     # Punto de entrada React
    App.jsx                      # Componente raiz (AppCoordinator)
    features/
      app/AppCoordinator.jsx     # Orquestador de la aplicacion
      session/                   # Login, autenticacion
      connection/                # Estado de conexion WhatsApp
      conversations/             # Panel de conversaciones y tickets
      agent-workspace/           # Espacio de trabajo del analista
      admin-sla/                 # Panel de administracion SLA
    components/
      AdminPanel.jsx             # Panel de administracion
      AgentTokenManagement.jsx   # Gestion de tokens de dashboard
      ChatFilters.jsx            # Filtros de chats
      bot-flow-studio/           # Editor visual de flujos del bot
      design-system/             # Componentes de diseno reutilizables
      SalesforceCaseModal.jsx    # Modal de casos Salesforce
    hooks/                       # Custom hooks React
    lib/                         # Utilidades y clientes HTTP
    store/useAppStore.js         # Estado global (Zustand)
    assets/                      # Recursos estaticos
    test/                        # Tests de integracion visual

### Dependencias Principales

| Paquete | Proposito |
|---------|-----------|
| react 19 | UI framework |
| zustand | Estado global |
| @xyflow/react | Editor visual de flujos del bot |
| socket.io-client | Comunicacion en tiempo real |
| vite | Build tool y dev server |
| vitest | Testing unitario |
| tailwindcss | Estilos utilitarios |
| lucide-react | Iconografia |
| @testing-library/react | Testing de componentes |

### Store Global (Zustand)

El estado global incluye:
- Estado de conexion del dashboard
- Estado del bot WhatsApp
- Lista de tickets y chats
- Analistas y areas
- Preferencias de sesion
- Modo de visualizacion (admin/analista)

---

## 5. Base de Datos - Supabase (PostgreSQL)

### Esquema

El proyecto utiliza Supabase como base de datos PostgreSQL. NO se utiliza Supabase Auth - la autenticacion es mediante JWT propios almacenados en dashboard_tokens.

### Tablas Principales

| Tabla | Proposito |
|-------|-----------|
| tickets | Tickets de soporte (chat_id, estado, prioridad, area, fechas) |
| messages | Mensajes asociados a tickets |
| bot_sessions | Sesiones del bot conversacional por chat |
| contact_classifications | Clasificaciones de contactos (candidato, etc.) |
| dashboard_tokens | Tokens JWT para autenticacion del dashboard |
| analysts | Analistas de soporte vinculados a tokens |
| areas | Areas de soporte (Integraciones, Plataforma, etc.) |
| ticket_assignments | Asignaciones ticket - analista |
| category_area_mappings | Enrutamiento por categoria - area |
| development_escalations | Escalaciones a desarrollo |
| salesforce_outbox | Outbox pattern para sincronizacion con Salesforce |
| sf_attachments | Metadatos de adjuntos subidos a Salesforce |
| audit_log | Registro de auditoria de operaciones administrativas |
| sla_policies | Politicas de SLA por area y prioridad |
| business_calendars | Calendarios de negocio para calculo de SLA |
| business_calendar_windows | Ventanas de atencion por calendario |
| business_calendar_exceptions | Excepciones de calendario |
| sla_snapshots | Instantaneas de SLA por ticket |
| sla_clock_segments | Segmentos del reloj SLA |
| bot_flows | Definicion de pasos del bot conversacional |
| bot_flow_studio_layouts | Layouts del editor visual de flujos |
| chat_preferences | Preferencias de chat (modo auto/manual, silenciado) |
| workflow_events | Eventos del workflow de conversaciones |
| ticket_post_processing | Post-procesamiento de tickets cerrados |
| app_settings | Configuracion global de la aplicacion |

### Patron de Acceso a Datos

- Todas las operaciones usan SUPABASE_SERVICE_ROLE_KEY (rol service_role)
- Las tablas tienen RLS (Row Level Security) con politicas que solo permiten acceso a service_role
- No se usa SUPABASE_ANON_KEY en produccion
- Implementa outbox pattern para sincronizacion con Salesforce (tabla salesforce_outbox)
- Las migraciones SQL estan versionadas en backend/supabase/ y docs/supabase-migrations/

## 6. Integracion con WhatsApp

### Mecanismo

Utiliza la libreria whatsapp-web.js, que automatiza WhatsApp Web mediante Puppeteer (Chromium headless). No usa la API oficial de WhatsApp Business Cloud - es una automatizacion del cliente web.

### Autenticacion

1. QR Code: Escaneo manual desde el dashboard (expira en 20 segundos)
2. Pairing Code: Codigo numerico ingresado en WhatsApp (alternativa al QR)

### Flujo de Mensajes

1. Llega un mensaje de WhatsApp
2. El bot verifica si el chat esta silenciado
3. Si modo manual: notifica al dashboard, no responde automaticamente
4. Si modo auto: procesa con el bot conversacional (flujo configurable por area)
5. El bot usa Gemini IA para clasificar intencion (candidato, soporte, etc.)
6. Las sesiones del bot se persisten en Supabase
7. Los mensajes se guardan en la tabla messages

### Capacidades

- Envio y recepcion de mensajes de texto
- Envio y recepcion de archivos multimedia (imagenes, documentos, audio, video)
- Reacciones a mensajes
- Estado del bot en tiempo real (conectado/desconectado/QR)
- Sesiones persistentes entre reinicios del servidor


## 7. Integracion con Salesforce

### Autenticacion

- JWT Bearer Flow: usa un certificado RSA (par: salesforce.key privado + salesforce.crt publico)
- Claves y secretos configurados via variables de entorno
- Las claves privadas NUNCA se commitean (gitignored)

### Operaciones

- Creacion de casos (Cases) desde tickets de soporte
- Subida de archivos adjuntos a registros de Salesforce
- Sincronizacion bidireccional via outbox pattern
- Sondeo periodico de estados pendientes
- Reintentos con backoff para fallos transitorios

### Outbox Pattern

La tabla salesforce_outbox funciona como cola de eventos:
1. Un cambio en el sistema local crea un job en la tabla
2. Un procesador reclama jobs pendientes (claim-based)
3. Ejecuta la operacion en Salesforce
4. Marca el job como synced, retrying o failed
5. Los jobs fallidos se reintentan automaticamente
6. Los jobs synced se limpian por TTL

## 8. Sistema de Tickets y Flujo de Trabajo

### Ciclo de Vida de un Ticket

1. Un contacto de WhatsApp inicia una conversacion
2. El bot clasifica la intencion (soporte, candidato, etc.)
3. Si es soporte: crea un ticket y lo enruta al area correspondiente
4. El ticket aparece en la cola del dashboard en tiempo real
5. Un analista toma/recibe el ticket (asignacion manual o automatica)
6. El analista atiende al cliente via el dashboard
7. Al cerrar el ticket, el bot envia un mensaje de despedida
8. Post-procesamiento: outbox Salesforce, limpieza de sesion, ACK de WhatsApp

### Enrutamiento

- Por categoria (platform, tests, requests, integrations)
- Cada categoria mapea a un area de soporte
- Los analistas pertenecen a areas especificas
- Las colas de tickets son filtradas por area
- Un admin puede transferir tickets entre areas

### SLA

- Politicas configurables por area y prioridad
- Reloj de negocio con calendarios, ventanas y excepciones
- Estados: ok, warning, breached
- Alertas en tiempo real via WebSocket
- Calculo basado en tiempo calendario o tiempo laboral


## 9. Seguridad Implementada

### Capa de Transporte

- Helmet: headers de seguridad HTTP (CSP, HSTS, X-Frame-Options, etc.)
- CORS: origenes permitidos configurados dinamicamente desde variables de entorno
- Trust proxy: configuracion explicita de CIDR, no confianza numerica
- Cookies de sesion configuradas con httpOnly, secure, sameSite

### Capa de Autenticacion

- Autenticacion por token propio (JWT almacenado en Supabase)
- Hash SHA-256 de tokens antes de almacenar (no se guardan en texto plano)
- Revalidacion periodica de tokens en sesiones WebSocket
- Roles: admin y agent
- Las rutas admin requieren doble middleware (apiAuth + adminOnly)
- Revocacion de tokens con auditoria atomica (RPC en PostgreSQL)

### Capa de Rate Limiting

- Pre-autenticacion: limite estricto en endpoint de login
- Post-autenticacion: limites por sesion, por token, y globales
- Rate limiting en eventos WebSocket (send-message: max 5 por 2 segundos)
- Configuracion via variables de entorno

### Capa de Validacion

- XSS: sanitizacion de entrada con libreria xss
- Validacion de tipos y formatos en todos los endpoints
- Validacion de WhatsApp Chat IDs (formato regex estricto)
- Validacion de archivos multimedia (tipo MIME, tamano)

### Capa de Datos

- RLS en todas las tablas de Supabase (solo service_role)
- La clave de servicio (SUPABASE_SERVICE_ROLE_KEY) solo existe en backend/.env
- Logs del servidor sanitizados (redact.js: oculta tokens, passwords, secrets en logs)
- Hash de tokens antes de almacenar (nunca texto plano)

## 10. Modelo de Autenticacion y Autorizacion

### Flujo de Autenticacion

1. El administrador genera un token desde el panel admin (/api/admin/tokens/pending)
2. El token se activa manualmente (activacion en dos pasos)
3. El usuario ingresa el token en la pantalla de login
4. El backend valida el token contra la tabla dashboard_tokens (hash SHA-256)
5. Si es valido y activo, la sesion se establece via cookie JWT
6. Las conexiones WebSocket se autentican con el mismo token
7. Revalidacion periodica pasiva cada cierto intervalo

### Modelo de Roles

| Rol | Acceso |
|-----|--------|
| admin | Todo el panel, gestion de tokens, areas, analistas, flujos, SLA |
| agent | Tickets asignados, cola de su area, mensajes, cierre de tickets |

### Almacenamiento de Tokens

- Los tokens se almacenan como hash SHA-256 (nunca texto plano)
- El token raw se muestra UNA VEZ al crearlo, luego no es recuperable
- Los tokens tienen estado: pending, active, revoked
- La revocacion usa una funcion atomica RPC con auditoria
- Al revocar, se desconectan todas las sesiones WebSocket activas del token


## 11. Variables de Entorno y Secretos

### Gestion de Secretos

| Archivo | Contenido | Git |
|---------|-----------|-----|
| .env | Placeholders de configuracion general | IGNORADO |
| .env.example | Documentacion de variables necesarias | COMMITEADO |
| backend/.env | CREDENCIALES REALES (Supabase, Salesforce, Gemini) | IGNORADO |
| backend/.env.example | Documentacion de variables del backend | COMMITEADO |
| backend/certs/salesforce.key | Clave privada RSA para Salesforce JWT | IGNORADO |
| backend/certs/salesforce.crt | Certificado publico | COMMITEADO |

### Variables de Entorno Criticas

| Variable | Propósito | Clasificacion |
|----------|-----------|---------------|
| SUPABASE_URL | URL del proyecto Supabase | Publica (en URL) |
| SUPABASE_ANON_KEY | Key anonima de Supabase | Baja (RLS restringe) |
| SUPABASE_SERVICE_ROLE_KEY | Key de servicio (acceso total a DB) | CRITICA |
| GOOGLE_GEMINI_API_KEY | API key de Google Gemini | ALTA |
| SALESFORCE_CLIENT_ID | Client ID de Connected App | Media |
| SALESFORCE_CLIENT_SECRET | Client Secret de Connected App | ALTA |
| DASHBOARD_SECRET | Secreto compartido del dashboard | ALTA |
| PORT | Puerto del servidor | Publica |
| ALLOWED_ORIGINS | Origenes CORS permitidos | Media |
| TRUST_PROXY_CIDRS | CIDR de proxies confiables | Media |
| RATE_LIMIT_KEY_SECRET | Secreto para firmar keys de rate limit | Media |

### Politica de Git

- Los archivos .env estan en .gitignore desde el inicio del proyecto
- Ningun archivo .env ha sido commiteado JAMAS (verificado en todo el historial)
- Las claves privadas (*.key, *.pem, *.p8, *.p12) estan gitignored
- Solo certificados publicos (.crt) se commitean
- Los SQL de migracion contienen SOLO schema, sin datos ni secretos

## 12. Instalacion y Configuracion

### Requisitos

- Node.js >=22.12 <23
- npm >=10 <12
- Una cuenta de Supabase (plan gratis suficiente)
- Una API key de Google Gemini
- Una cuenta de Salesforce con Connected App configurada
- Un telefono con WhatsApp para autenticar

### Instalacion Local

1. Clonar el repositorio
2. Crear backend/.env con las credenciales reales (usar backend/.env.example como guia)
3. npm install (desde la raiz)
4. npm --prefix backend install
5. npm --prefix frontend install
6. Aplicar migraciones SQL de Supabase (backend/supabase/ o docs/supabase-migrations/)
7. npm run dev:backend
8. npm run dev:frontend (en otra terminal)

### Scripts Disponibles

| Script | Descripcion |
|--------|-------------|
| npm run start | Iniciar servidor de produccion (frontend servido por Express) |
| npm run dev:backend | Iniciar backend en modo desarrollo con nodemon |
| npm run test:backend | Ejecutar tests del backend (405+ tests) |
| npm run test:frontend | Ejecutar tests del frontend (Vitest) |
| npm run verify | Suite completa de verificacion |
| npm run diagnose | Diagnosticos del sistema |
| npm run audit:production | Auditoria de seguridad de dependencias |

### Orden de Arranque

1. Aplicar migraciones SQL en Supabase
2. Iniciar backend: npm run dev:backend (puerto 3001)
3. Iniciar frontend: npm run dev (puerto 5173)
4. Abrir http://localhost:5173 en el navegador
5. Autenticar WhatsApp escaneando el QR desde el dashboard
6. El bot comienza a procesar mensajes automaticamente


## 13. Pruebas

### Backend (405+ tests)

Framework: Node.js test runner (node --test)

Cobertura:
- Pruebas unitarias de servicios
- Pruebas de integracion con base de datos
- Pruebas de rutas API
- Pruebas de middleware de seguridad
- Pruebas de WebSocket
- Pruebas de outbox Salesforce
- Pruebas de validacion y sanitizacion

Ejecucion: npm run test:backend

### Frontend

Framework: Vitest + @testing-library/react

Cobertura:
- Pruebas de componentes
- Pruebas de integracion visual
- Pruebas de flujos de autenticacion

Ejecucion: npm run test:frontend


## 14. Estructura del Repositorio

NEXO/
  .env                         # Variables de entorno (IGNORADO)
  .env.example                 # Documentacion de variables
  package.json                 # Scripts raiz
  server.js                    # Entry point original (MOVED to legacy/)
  index.js                     # Entry point original (MOVED to legacy/)
  legacy/                      # Entry points legacy
  backend/                     # API Express + Socket.IO + Servicios
    server.js                  # Servidor principal
    src/                       # Codigo fuente del backend
    supabase/                  # Migraciones SQL versionadas
    certs/                     # Certificados publicos
    test/                      # 405+ tests unitarios/integracion
    scripts/                   # Utilidades CLI
  frontend/                    # Dashboard React + Vite
    src/                       # Codigo fuente del frontend
    public/                    # Archivos estaticos
    scripts/                   # Scripts de build externo
  docs/                        # Documentacion
    supabase-migrations/       # Migraciones adicionales
  scripts/                     # Scripts de automatizacion (CI, diagnostico, deploy)
  .github/                     # Workflows y templates
  .gitignore                   # Exclusiones de seguridad

## 15. Consideraciones de Ciberseguridad

### Resumen de Riesgos y Mitigaciones

| Riesgo | Impacto | Mitigacion Implementada |
|--------|---------|------------------------|
| Filtracion de SUPABASE_SERVICE_ROLE_KEY | Acceso total a la base de datos | - Solo en backend/.env (gitignored, nunca commiteado)<br>- Rotacion periodica recomendada |
| Filtracion de GOOGLE_GEMINI_API_KEY | Uso no autorizado de IA | - Solo en backend/.env<br>- Se puede rotar desde Google AI Studio |
| Filtracion de SALESFORCE_CLIENT_SECRET | Acceso a CRM | - Solo en backend/.env |
| Clave privada RSA de Salesforce | Suplantacion de identidad ante Salesforce | - gitignored (*.key)<br>- Generada localmente con generate-certs.js |
| Inyeccion XSS en mensajes | Ejecucion de scripts en dashboard | - Sanitizacion con libreria xss en todos los inputs |
| CSRF en API | Ejecucion de acciones no autorizadas | - Middleware CSRF personalizado |
| Ataque de fuerza bruta a login | Obtencion de tokens | - Rate limiting estricto en /api/session/* |
| Fuga de informacion en logs | Exposicion de tokens o PII | - Sistema de redaccion automatica (redact.js)<br>- Codigos de pairing redactados en logs |
| Acceso no autorizado a WebSocket | Escucha de conversaciones | - Autenticacion JWT en conexion<br>- Revalidacion periodica pasiva<br>- Filtrado de eventos por rol y asignacion |
| whatsapp-web.js/Puppeteer | Carga de Chromium, consumo de recursos | - Aislado en el servidor backend<br>- Sesiones persistentes en disco |
| Dependencias con vulnerabilidades | Varios segun CVE | - npm audit en CI<br>- Overrides para versiones vulnerables conocidas |
| Suplantacion de origen CORS | Robo de sesiones | - Lista blanca de origenes configurable<br>- Validacion en cada request |

### Puntos de Atencion para Auditoria

1. **SUPABASE_SERVICE_ROLE_KEY**: Es la llave mas critica. Da acceso completo a todas las tablas. Debe tratarse como secreto de maxima clasificacion. Rotar inmediatamente si se sospecha filtracion.

2. **whatsapp-web.js**: No es una API oficial de WhatsApp. Depende de ingenieria inversa del protocolo Web de WhatsApp. Puede dejar de funcionar con actualizaciones de WhatsApp. Considerar migrar a WhatsApp Business Cloud API para produccion.

3. **Autenticacion Custom**: No se usa Supabase Auth ni OAuth. La autenticacion es mediante tokens JWT propios. Esto evita dependencias externas pero pone la responsabilidad de la seguridad en el codigo propio.

4. **HTTPS**: El servidor Express sirve en HTTP plano en desarrollo. En produccion, debe configurarse un reverse proxy (nginx, Caddy) con TLS.

5. **No hay WAF**: No hay Web Application Firewall ni proteccion contra DDoS. Depende del rate limiting interno y del reverse proxy.

6. **Certificados de Salesforce**: La clave privada RSA se genera localmente. Si se pierde, hay que reconfigurar la Connected App en Salesforce.

7. **Chromium (Puppeteer)**: whatsapp-web.js descarga Chromium (~300MB). Considerar recursos del servidor.

8. **Logs**: Aunque hay redaccion automatica, revisar que ningun dato sensible se filtre en logs ante nuevos desarrollos.

9. **CORS**: Los origenes permitidos se configuran en variable de entorno. Verificar que la configuracion de produccion sea restrictiva.

10. **Sesiones de WhatsApp**: Las sesiones autenticadas se persisten en backend/.wwebjs_auth/. Si alguien accede a esos archivos, puede suplantar la cuenta de WhatsApp.

### Buenas Practicas Recomendadas

- Rotar SUPABASE_SERVICE_ROLE_KEY y SALESFORCE_CLIENT_SECRET periodicamente
- Usar un secret manager (HashiCorp Vault, AWS Secrets Manager, 1Password Connect) para produccion
- Implementar WAF si el sistema se expone a internet
- Configurar fail2ban o similar para bloqueo por IP ante multiples intentos fallidos
- Monitorear el audit_log para detectar actividad sospechosa
- Hacer backup periodico de la base de datos Supabase
- Mantener actualizadas las dependencias (npm audit regular)
- Revisar periodicamente los logs de acceso del reverse proxy
- Considerar migracion a WhatsApp Business Cloud API para produccion oficial

---

*Documento generado el 30 de julio de 2026. Para uso del equipo de desarrollo y auditoria de ciberseguridad.*
