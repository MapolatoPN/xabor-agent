# Integración con Meta (WhatsApp): Xabor como Tech Provider

Documento técnico de la integración de Xabor con WhatsApp Cloud API, Embedded
Signup, Coexistencia y WhatsApp Flows, y del camino para operar como **Tech
Provider**: una app central de Meta en el portafolio de Xabor, con muchos
restaurantes conectando cada uno su propia cuenta de WhatsApp Business.

- Fecha de la auditoría: 27-nov-2026. Base: commit de producción `e64c2349`.
- Documentación de Meta consultada ese mismo día (fuentes al final). Donde la
  documentación no lo dice, aquí se marca como **por confirmar**.
- Esta entrega **no despliega nada** y **no crea migraciones**. Todo lo nuevo
  nace apagado o es de solo lectura (ver «Interruptores»).

> Los hallazgos de seguridad de la auditoría NO están en este archivo (el
> repositorio es público). Se entregaron aparte al dueño.

---

## 0. Resumen

**Qué hay hoy.** Xabor ya conecta restaurantes por Embedded Signup. Cubre
número nuevo y coexistencia con la app de WhatsApp Business. Guarda la
credencial de cada negocio cifrada (AES-256-GCM) y enruta los mensajes
entrantes por `phone_number_id`. Atiende los formularios (Flows) con un
endpoint cifrado y precios validados en el servidor.

**Qué agrega esta entrega** (sin tocar archivos protegidos):

1. `metaGraph.js`: un solo punto de salida a la Graph API para los módulos
   nuevos, con versión vigente explícita (v25.0), validación de rutas y
   redacción de errores.
2. Verificación de activos en el callback de Embedded Signup. Confirma con
   Meta (`/debug_token` + `/{waba}/phone_numbers`) qué cuenta y qué número
   concedió el negocio. Tiene tres modos: `apagado` (por omisión, idéntico a
   hoy), `observar` y `exigir`. En `exigir` además descubre la cuenta cuando
   el navegador no la manda (Embedded Signup v5 ya no manda `waba_id`).
3. Desconexión ordenada de WhatsApp:
   - retira la suscripción de la app a la cuenta (`DELETE /{waba}/subscribed_apps`);
   - borra la credencial;
   - **libera el número** para reconectarlo;
   - deja rastro en la auditoría.

   Nunca llama a `/deregister`. Desde Superadmin está disponible ya; desde el
   propio negocio, detrás de un interruptor apagado.
4. Pestaña **Meta / WhatsApp** en Superadmin, con todos los negocios a la vista:
   - estado, número, nombre aprobado y vencimiento de la credencial;
   - formularios configurados y último mensaje recibido;
   - alertas;
   - diagnóstico de formularios contra Meta (estado y errores de cada Flow,
     llave de cifrado del número);
   - botón Desconectar.
5. La bitácora de Superadmin ahora muestra también las acciones del
   administrador del propio negocio (antes las ocultaba un `JOIN`).
6. Dos suites nuevas (39 + 30 casos) y las mordidas correspondientes.

**Lo urgente (no depende de código):**

| Qué | Cuándo | Quién |
|---|---|---|
| La versión `v20.0` escrita en el código ya caducó (24-sep-2026). Meta la atiende como la más antigua vigente: hoy v21.0 y, desde el 21-ene-2027, v22.0. No se cae, pero cambia de versión sin aviso. | Antes del 21-ene-2027 | Desarrollo, con aprobación (toca `whatsapp-meta.js`) |
| Las credenciales de los negocios vencen (~60 días) aunque Meta documenta que el token de negocio «por omisión no vence». Revisar la configuración de Facebook Login for Business. | Ya: el tablero muestra cuál vence primero | Dueño de la app en Meta |
| Embedded Signup v2/v3 se retiraron (15-oct-2026); hoy se atiende como v4. Pasar a v5 exige leer `messaging_account_ids` en vez de `waba_id`. | Antes de cambiar la configuración de FBL4B a v5 | Desarrollo + dueño |
| No hay URL ni callback de eliminación de datos: la app de Meta los pide. | Antes del App Review | Dueño + desarrollo |

---

## 1. Diagnóstico de la arquitectura actual

### 1.1 Stack y despliegue
- Node.js 22+ con Express (ESM), PostgreSQL vía `pg`, WebSocket `ws`, Railway.
- Producción no despliega desde `main`. La rama que sirve producción cambia
  con cada entrega; ver CLAUDE.md, «Desplegar a producción».
- Las migraciones solo llegan a producción por el runner del Pre-Deploy
  (`scripts/predeploy-run-032-033.mjs`, arreglo `SCRIPTS`).

### 1.2 Modelo multiempresa
- La unidad es el **negocio** (`negocios`). Cada sucursal es un negocio con
  su propia configuración, menú, usuarios y WhatsApp. No hay una entidad
  «organización» que agrupe sucursales.
- Membresía: usuarios ↔ negocios con rol (admin / staff / operador). El
  negocio de cada petición sale de la sesión, nunca del cuerpo.
- Módulos contratados por negocio en `negocio_modulos` (`whatsapp`,
  `tienda_online`, `repartidores`…). Planes existentes: `prueba`, `basico`,
  `pro`, `personalizado`. **Esta entrega no crea ni cambia planes ni precios.**

### 1.3 WhatsApp: tablas
| Tabla | Para qué |
|---|---|
| `integraciones_canal` | Una fila por negocio, canal y proveedor. `identificador` = `phone_number_id` (UNIQUE por canal), `waba_id`, `business_id`, `display_phone_number`, `verified_name`, `estado_nombre`, `estado`, `activo`, `connection_mode` (`cloud_api` / `coexistence`), `numero_registrado_cloud_api`, `app_suscrita_waba`, `configuracion` (JSONB) y el último error/prueba. |
| `integraciones_canal_credenciales` | Token cifrado (AES-256-GCM, `INTEGRATIONS_ENCRYPTION_KEY`), IV, tag, versión de formato y `token_expira_at`. |
| `webhook_entrante` (077) | Buzón durable de webhooks. |
| `whatsapp_entradas` (078) | Mensajes entrantes por negocio, idempotentes por `UNIQUE(negocio_id, wamid)`. |
| `configuracion` | Clave/valor por negocio. Ahí viven los ids de los formularios (`whatsapp_flow_<tipo>_id`) y las banderas. |
| `auditoria_plataforma` | Bitácora: actor Superadmin (`superadmin_id`) o del negocio (`actor_usuario_id`). |

Estados de la integración: `no_configurado`, `pendiente_configuracion`,
`pendiente_activacion`, `activo`, `suspendido`, `desconectado`, `error`.
Invariante: `activo = (estado = 'activo')` para WhatsApp/Meta. Solo una
integración activa enruta y envía.

### 1.4 Embedded Signup (como está hoy)
1. El panel (`panel/index.html`) pide `GET /api/integraciones/whatsapp/config`
   (App ID y `config_id`, públicos) y `POST /api/integraciones/whatsapp/iniciar`,
   que devuelve un `state` firmado (HMAC, 10 min, uso único) con el negocio y
   el actor.
2. Abre `FB.login` con `config_id`, `response_type: 'code'`,
   `override_default_response_type: true` y
   `extras: { setup: {}, sessionInfoVersion: 3 }`. En coexistencia agrega
   `featureType: 'whatsapp_business_app_onboarding'`.
3. El navegador recibe el evento `WA_EMBEDDED_SIGNUP` (`FINISH` o
   `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) con `phone_number_id`,
   `waba_id` y `business_id`.
4. `POST /api/integraciones/whatsapp/meta/callback` con `state`, `code` y los
   ids:
   - valida el `state` y que el intento siga vigente;
   - intercambia el código por el token de negocio (sin `redirect_uri`);
   - guarda cifrado (`pendiente_activacion`);
   - intenta la activación:
     - `POST /{pnid}/register` con PIN, que se omite en coexistencia;
     - `POST /{waba}/subscribed_apps`;
     - en coexistencia, comprueba `is_on_biz_app`;
   - queda en `activo`.
5. Superadmin hace lo mismo desde su consola y puede reintentar la activación
   sin repetir el Embedded Signup.

### 1.5 Webhooks y enrutamiento
- `/webhook/whatsapp`: firma `X-Hub-Signature-256` con `META_APP_SECRET`
  (obligatorio en producción), buzón durable y procesamiento asíncrono.
- El negocio se resuelve por `metadata.phone_number_id` →
  `integraciones_canal` activa. Un número sin integración activa no enruta.
- `account_update` con `PARTNER_REMOVED` marca la integración como
  desconectada por `waba_id`.

### 1.6 Envío
`obtenerCredencialesWhatsappNegocio(negocioId)` resuelve en este orden:
1. la credencial cifrada (solo si la integración está activa);
2. una credencial heredada en `configuracion`;
3. el puente legado de variables de entorno, solo para un negocio con fila
   legada que sea dueño de ese número.

En producción hoy solo se usa la (1).

### 1.7 Vigilancia de la credencial
`vigilanciaCredencialWhatsapp.js` corre cada 10 minutos y consulta
`/debug_token` cada 6 horas. Guarda `token_expira_at`, avisa 7, 3 y 1 días
antes y marca la credencial como «rechazada» si Meta la deja de aceptar
(código 190/102/401) sin cortar la recepción.

### 1.8 Formularios (WhatsApp Flows)
- Endpoint `/webhook/flows/pedido`:
  - cifrado RSA-OAEP-SHA256 + AES-128-GCM con el IV invertido en la respuesta;
  - códigos 421/432/427;
  - una sola llave para todos los negocios (`WHATSAPP_FLOW_PRIVATE_KEY`).
- El negocio sale del `flow_token` (`xb1:`, 128 bits, en `agente_botones`),
  nunca del cuerpo. El menú y los precios se inyectan en tiempo de ejecución
  y se validan en el servidor.
- Los ids de cada Flow viven en `configuracion` (`whatsapp_flow_<tipo>_id`).
  Se crean y publican con scripts manuales (`scripts/*flow*`). Flow JSON 7.3
  y `data_api_version` 3.0.

### 1.9 Versión de la Graph API
`v20.0` está escrita a mano en unos 15 lugares, entre ellos
`whatsapp-meta.js` (protegido), `metaEmbeddedSignup.js`,
`metaEnvioDocumentos.js`, `campanasWa.js`, `otpProveedores.js`,
`clientesSaneamiento.js` y varios scripts. El SDK del navegador se inicializa
con esa misma versión.

---

## 2. Problemas encontrados

Solo los que se pueden publicar. Severidad: **A** alta, **M** media, **B** baja.

| # | Sev. | Problema | Estado en esta entrega |
|---|---|---|---|
| 1 | A | `v20.0` caducó el 24-sep-2026. Meta atiende las llamadas con la versión vigente más antigua (v21.0 → v22.0 desde el 21-ene-2027 → …). No es una caída, pero la versión efectiva cambia sin que nadie la elija. | Los módulos nuevos usan v25.0 explícita (`META_GRAPH_VERSION` la puede cambiar). Falta migrar los viejos: §15. |
| 2 | A | Credenciales con vencimiento de ~60 días, cuando el token de negocio de Facebook Login for Business «por omisión no vence» según Meta. Al vencer, el bot queda mudo hasta que el negocio reconecta. | El tablero las ordena por vencimiento y alerta a 15 días (crítico a 3). La causa probable es la configuración de FBL4B: **por confirmar** en el panel de Meta (§9). |
| 3 | A | No existía la desconexión. «Suspender» y «Eliminar credenciales» conservan el número en la fila, y un número que quedó en la fila de otro negocio no se puede volver a conectar (409). | **Resuelto**: desconexión que libera el número (§5.3). |
| 4 | M | El frontend usa el estilo de Embedded Signup v3 (retirado; hoy se atiende como v4). En v5 el evento ya no trae `waba_id` sino `messaging_account_ids`. | El modo `exigir` descubre la cuenta con el token. El cambio del frontend queda en §15 (archivo protegido). |
| 5 | M | El número visible y el nombre aprobado nunca se llenaban al conectar: la tarjeta del negocio mostraba «sin número». | En `observar`/`exigir` se guardan los que confirma Meta, sin marcado. |
| 6 | M | Un número por negocio; no hay nivel «organización». Un grupo con varias sucursales administra cada una por separado. | Sin cambio: decisión de producto (§3). |
| 7 | M | Formularios: provisionamiento manual por scripts, una llave para todos y textos de la marca original en el código compartido. No había dónde ver si un Flow sigue publicado. | El diagnóstico (§5.4) los muestra. El ciclo de vida completo es la fase F3 (§4). |
| 8 | M | No hay creación de plantillas desde Xabor; los nombres de plantilla de la plataforma están fijos en el código. | Fase F4. |
| 9 | M | Coexistencia: nunca se llama a `smb_app_data` (historial y contactos). Meta da **24 horas** desde el alta y cada sincronización corre **una vez**. | Fase F2 (necesita decisión del dueño sobre qué importar). |
| 10 | M | No hay URL ni callback de eliminación de datos para la app de Meta. | Bloqueo de App Review (§10). |
| 11 | B | El estado del intento de Embedded Signup vive en memoria: un reinicio a media conexión obliga a repetirla. | Sin cambio (se reintenta). |
| 12 | B | No hay retención en las tablas del buzón. | Sin cambio. |
| 13 | B | La bitácora de Superadmin no mostraba las acciones del administrador del negocio. | **Resuelto**. |
| 14 | B | Facebook, Messenger e Instagram no están integrados. | La UI no debe mostrarlos como conectados: hoy no lo hace. |

---

## 3. Arquitectura objetivo

```
                    Portafolio comercial de Xabor (verificado)
                    └── App de Meta de Xabor (Tech Provider, una sola)
                         ├── Facebook Login for Business → configuración «Embedded Signup»
                         ├── Webhook único:  /webhook/whatsapp   (firma con el secreto de la app)
                         └── Endpoint de Flows: /webhook/flows/...
                                         │
   ┌─────────────────────────────────────┼─────────────────────────────────────┐
   │ Negocio A (su portafolio)           │ Negocio B (su portafolio)           │
   │  WABA A ── número A1 (coexistencia) │  WABA B ── número B1 (Cloud API)    │
   │  método de pago propio en Meta      │  método de pago propio en Meta      │
   └─────────────────────────────────────┴─────────────────────────────────────┘
                                         │
                       Xabor (una base, aislamiento por negocio)
   integraciones_canal: phone_number_id → negocio  (UNIQUE: un número, un negocio)
   credenciales cifradas por integración; nunca salen al navegador
   configuracion: formularios, banderas, textos por negocio
```

Principios:
- **Los activos son del negocio.** WABA, número, portafolio y página siguen
  siendo suyos. Xabor recibe acceso concedido y revocable, nunca la propiedad,
  nunca una contraseña.
- **Cada negocio paga a Meta su mensajería.** Un Tech Provider no tiene línea
  de crédito: el negocio agrega su método de pago en WhatsApp Manager. La
  suscripción de Xabor y el costo de Meta son cosas separadas.
- **Enrutamiento central por `phone_number_id`**, con el `waba_id` como
  respaldo para los eventos de cuenta (`account_update`).
- **Credencial por negocio**, cifrada, descifrada solo en el servidor y solo
  para una integración activa.
- **Una sola app**, sin crear otra.
- **Formularios por negocio**, con contenido dinámico por el endpoint de datos
  para no republicar al cambiar el menú. Meta recomienda a los proveedores un
  endpoint y una llave por cliente: es la fase F3.

---

## 4. Plan de implementación

| Fase | Contenido | Estado |
|---|---|---|
| **F0** | Graph centralizado para lo nuevo, verificación de activos con interruptor, desconexión con liberación del número, tablero y diagnóstico en Superadmin, bitácora completa, pruebas. | **Esta entrega** (rama, sin desplegar) |
| F1 | Migrar todo el código a `metaGraph.versionGraph()`, incluidos los archivos protegidos con su aprobación. Pasar el frontend de Embedded Signup a v4 explícita y después a v5 (`messaging_account_ids`). Botón «Desconectar» en la tarjeta del negocio. Protección de `PARTNER_REMOVED` contra reintentos viejos (§15). | Necesita aprobación |
| F2 | Coexistencia: sincronización de contactos e historial (`smb_app_data`, dentro de las 24 h) con consentimiento explícito del negocio, y webhooks `history` / `smb_app_state_sync` / `smb_message_echoes`. | Necesita decisión |
| F3 | Formularios como producto: crear, subir el JSON, validar, publicar, versionar y retirar desde Xabor (Flows API). Plantillas de formulario por negocio, `data_api_version` 4.0, llave por número (`/whatsapp_business_encryption`). Procesar `flows` y su estado de salud. | Diseño |
| F4 | Plantillas de mensaje por negocio desde Xabor (crear y ver su estado). | Diseño |
| F5 | Eliminación de datos (callback de Meta + flujo interno), retención del buzón y del historial. | Necesita decisión legal |

El flujo de autoservicio que se busca (de punta a punta):

1. El administrador del negocio entra a **Configuración → Integraciones**.
2. Pulsa **Conectar WhatsApp**: Xabor crea el `state` firmado.
3. Se abre la ventana de Meta. El negocio entra con **su** cuenta de Facebook.
4. Elige o crea su portafolio comercial.
5. Elige o crea su cuenta de WhatsApp Business.
6. Elige el número. Si es número nuevo, Cloud API; si es el de su app de
   WhatsApp Business, coexistencia.
7. Verifica el número (código por SMS o llamada), si Meta lo pide.
8. Revisa y acepta los permisos que pide Xabor (los dos de WhatsApp).
9. Meta devuelve al navegador el resultado y un `code` de un solo uso (5 min).
10. Xabor intercambia el código por la credencial, verifica los activos
    (`exigir`), la guarda cifrada, registra el número (excepto en
    coexistencia) y suscribe la app.
11. La tarjeta muestra **Conectado**, con el número y el nombre aprobado.
12. **Configurar pedidos** (formularios) y **Probar**. El negocio agrega su
    método de pago en WhatsApp Manager si aún no lo tiene.

No se pide página de Facebook: la documentación de Embedded Signup no la exige
para conectar solo WhatsApp.

---

## 5. Lo implementado en esta entrega

### 5.1 Archivos

| Archivo | Qué es |
|---|---|
| `src/services/metaGraph.js` | Salida única a la Graph API para los módulos nuevos. `versionGraph()` (v25.0 por omisión; `META_GRAPH_VERSION` solo con forma `vNN.0`) y `baseGraph()` (en producción siempre `graph.facebook.com`). `llamarGraph()`: rutas validadas (sin `..`, `?`, `#`, espacios), solo GET/POST/DELETE; nunca lanza por un rechazo de Meta. `listarGraph()` sigue la paginación. `redactar()` quita tokens, secretos y teléfonos de los mensajes de error. |
| `src/services/metaActivos.js` | `leerConcesion()` (`/debug_token` con la credencial de la app): validez, app, permisos, cuentas concedidas y vencimiento. `leerNumerosWaba()`. `verificarActivosConcedidos()`. Motivos cerrados con su mensaje al cliente. `resolverModoVerificacion()`. Limpieza del nombre y del número visibles. |
| `src/services/metaVerificacionCallback.js` | La decisión del callback según el modo, separada de la ruta para poder probarla. |
| `src/services/metaDesconexion.js` | `retirarSuscripcionWaba()` y `desconectarWhatsappNegocio()`. |
| `src/services/metaPanelPlataforma.js` | Resumen de todos los negocios para Superadmin, con alertas. |
| `src/services/metaFormularios.js` | Diagnóstico de los formularios de un negocio contra Meta (solo lectura). |
| `src/services/integracionesService.js` | `guardarCredencialesCifradas()` acepta, opcionales, `verifiedName`, `estadoNombre` y `tokenExpiraAt`. Sin ellos, todo queda igual. |
| `src/services/database.js` | Las dos consultas de la bitácora incluyen al actor del negocio (`actor_nombre`, `actor_tipo`). |
| `src/server.js` | Rutas nuevas (§5.5) y la verificación en el callback. No se tocan las rutas `/pedidos`. |
| `panel/superadmin.html` | Pestaña **Meta / WhatsApp**; la bitácora muestra «Nombre (negocio)». |

No se tocó ninguno de los archivos protegidos (`brain.js`,
`whatsapp-meta.js`, `orderManager.js`, `panel/index.html`, rutas `/pedidos`).

### 5.2 Verificación de activos en el callback

Para qué: con la credencial recién intercambiada se le pregunta a Meta qué
concedió el negocio. Así se guardan el número visible, el nombre aprobado y
el vencimiento de la credencial, y se descubre la cuenta cuando el navegador
no la manda (Embedded Signup v5):

- `GET /debug_token?input_token=<token del negocio>&access_token=<APP_ID>|<APP_SECRET>`
  - `is_valid`, `app_id` (tiene que ser la de Xabor), `scopes` (tienen que
    estar los dos de WhatsApp) y `expires_at` (0 = no vence).
  - `granular_scopes[scope=whatsapp_business_management].target_ids`: las
    cuentas concedidas. La guía oficial indica tomar la **primera**, que es
    la más reciente.
- `GET /{waba}/phone_numbers?fields=id,display_phone_number,verified_name,name_status,quality_rating,code_verification_status,platform_type`.

Qué hace cada modo:

| Modo | Llamadas a Meta | Si la verificación falla | Si pasa |
|---|---|---|---|
| `apagado` (por omisión) | Ninguna | — | — (igual que antes) |
| `observar` | 2 lecturas | Conecta igual y lo anota en `integracion_activos_verificados` | Si confirma el **mismo** número que el navegador, guarda el número visible, el nombre aprobado, su estado y el vencimiento de la credencial |
| `exigir` | 2 lecturas | Rechaza **antes de guardar nada**, con un mensaje claro y sin degradar la integración que el negocio ya tuviera | Guarda los ids que confirmó Meta (aunque el navegador no los mande) y revisa que ese número no sea de otro negocio |

Cómo se resuelve el modo: gana el más estricto entre la variable
`META_VERIFICAR_ACTIVOS` (toda la plataforma) y la clave
`meta_verificar_activos` del negocio en `configuracion`. La clave del negocio
solo puede **endurecer** el modo (probar en un negocio antes que en todos),
nunca relajar el de la plataforma.

Encendido recomendado:
1. `observar` en un negocio de prueba y conectar. Revisar la auditoría
   `integracion_activos_verificados`: `ok`, `descubierto`,
   `numeroDistintoAlNavegador`, `tipoToken`, `venceAt`.
2. `META_VERIFICAR_ACTIVOS=observar` en toda la plataforma durante algunas
   conexiones reales.
3. `exigir` cuando todas las observaciones salgan `ok`. Si Meta devolviera
   `target_ids` vacío (la referencia dice que se omite cuando el permiso
   aplica a todo), `exigir` rechazaría la conexión. Eso lo enseña `observar`
   antes de que afecte a nadie.

### 5.3 Desconexión

`desconectarWhatsappNegocio(negocioId, actor, { motivo })`:
1. Descifra la credencial y llama a `DELETE /{waba}/subscribed_apps`. Meta
   deja de mandarle a Xabor los webhooks de esa cuenta. Si Meta no responde o
   no confirma `success: true`, se sigue y se informa: la desconexión en
   Xabor no depende de la red.
2. En **una** transacción:
   - borra la credencial cifrada y, si existiera, la credencial heredada en
     `configuracion`;
   - deja la integración en `desconectado` con `activo = false`;
   - cambia `identificador` a `liberado:<id de la integración>`, lo que
     **libera el número**;
   - guarda en `configuracion.desconexion` la fecha, el id anterior, la cuenta,
     el modo, si se retiró la suscripción y el motivo.
3. Auditoría `integracion_whatsapp_desconectada`, sin token ni PIN.

Es idempotente: la segunda vez responde `yaEstabaDesconectado` sin llamar a
Meta.

**No** llama a `/deregister` (en coexistencia Meta no permite dar de baja el
número, y en Cloud API afectaría al número del negocio). **No** apaga el bot,
**no** toca pedidos ni conversaciones y **no** borra la fila. Para retirar
por completo el acceso de Xabor, el negocio quita a Xabor como socio desde la
configuración de su portafolio en Meta; Xabor no tiene una API para
renunciar a ese acceso.

Reconexión: el número liberado se conecta con Embedded Signup, en el mismo
negocio o en otro, sin el 409.

### 5.4 Tablero y diagnóstico (Superadmin → Meta / WhatsApp)

- Totales: negocios, conectados, en coexistencia, pendientes, desconectados,
  sin WhatsApp, con formularios, credenciales por vencer y alertas críticas.
- Por negocio:
  - estado y modo, número visible, nombre aprobado y su estado;
  - ids **enmascarados** (últimos 4);
  - si está suscrita y si el bot está encendido;
  - vencimiento de la credencial;
  - formularios configurados y último mensaje recibido;
  - alertas.
- Alertas: credencial rechazada, vencida, por vencer (aviso a 15 días,
  crítico a 3), vencimiento desconocido, activación pendiente, error,
  desconectado, sin suscripción y nombre rechazado.
- **Diagnosticar formularios**:
  - por cada `whatsapp_flow_<tipo>_id`, si existe en la cuenta del negocio, su
    estado (`PUBLISHED`, `DRAFT`, `DEPRECATED`, `BLOCKED`, `THROTTLED`) y sus
    errores de validación;
  - cuántos Flows publicados no usa Xabor;
  - si el número tiene registrada la llave pública de cifrado
    (`GET /{pnid}/whatsapp_business_encryption`).

  Solo lectura, con la credencial que el propio negocio concedió: nadie tiene
  que dar su contraseña de Facebook.
- **Desconectar** pide escribir `DESCONECTAR` y un motivo.

El tablero no muestra el uso de mensajería ni el costo: lo cobra Meta a cada
negocio y se ve en su WhatsApp Manager.

### 5.5 Rutas nuevas

| Ruta | Guarda | Límite |
|---|---|---|
| `GET /api/superadmin/meta/resumen` | Superadmin con segundo factor | 30/min |
| `GET /api/superadmin/negocios/:negocioId/meta/formularios` | Superadmin con segundo factor | 10/min |
| `POST /api/superadmin/negocios/:negocioId/integraciones/whatsapp/desconectar` `{ confirmar: 'DESCONECTAR', motivo }` | Superadmin con segundo factor | 10/min |
| `POST /api/integraciones/whatsapp/desconectar` `{ confirmar: 'DESCONECTAR', motivo }` | Sesión + administrador del negocio. El negocio sale de la sesión. Responde 404 mientras `XABOR_WHATSAPP_DESCONEXION_AUTOSERVICIO` no sea `true` | 5/min |

La confirmación viaja en JSON: un formulario de otro sitio no puede mandarla.
Ninguna respuesta contiene un token, el secreto de la app ni un PIN (las
pruebas lo revisan).

### 5.6 Interruptores

| Interruptor | Dónde | Por omisión | Efecto |
|---|---|---|---|
| `META_VERIFICAR_ACTIVOS` | Variable de Railway | vacío = `apagado` | Modo mínimo de verificación para toda la plataforma |
| `meta_verificar_activos` | `configuracion` del negocio | sin fila | Solo endurece el modo para ese negocio |
| `XABOR_WHATSAPP_DESCONEXION_AUTOSERVICIO` | Variable de Railway | apagado | Habilita la ruta de desconexión del propio negocio (el botón en su panel es la fase F1) |
| `META_GRAPH_VERSION` | Variable de Railway | `v25.0` | Versión de la Graph API de los módulos nuevos |

---

## 6. Base de datos y migraciones

**Ninguna migración nueva.** Se usan columnas que ya existen:
- `verified_name` y `estado_nombre` (045);
- `token_expira_at` (018);
- `integraciones_canal.configuracion` (JSONB, para `desconexion`);
- `configuracion` (clave `meta_verificar_activos`).

Convención nueva: `identificador = 'liberado:<uuid>'` marca un número
liberado. Cumple con el `UNIQUE(canal, identificador)` existente, no coincide
con ningún `phone_number_id` (todos son numéricos) y por eso no enruta ni
bloquea a nadie. El id anterior queda en `configuracion.desconexion`.

Campos por integración que pide el programa, y dónde viven:

| Campo | Dónde |
|---|---|
| negocio | `integraciones_canal.negocio_id` |
| portafolio del negocio | `business_id` |
| cuenta de WhatsApp | `waba_id` |
| número (id) / visible / nombre | `identificador` / `display_phone_number` / `verified_name`, `estado_nombre` |
| modo | `connection_mode` |
| credencial y vencimiento | `integraciones_canal_credenciales` (cifrada) / `token_expira_at` |
| permisos concedidos | auditoría `integracion_activos_verificados` (modos `observar`/`exigir`) |
| estado, registro, suscripción | `estado`, `numero_registrado_cloud_api`, `app_suscrita_waba` |
| último error / última prueba | `ultimo_error_*`, `ultima_prueba_*` |
| formularios | `configuracion.whatsapp_flow_<tipo>_id` |
| historial de cambios | `auditoria_plataforma` |
| desconexión | `integraciones_canal.configuracion.desconexion` |

---

## 7. Variables de entorno

Solo nombres; los valores viven en Railway.

| Variable | Uso |
|---|---|
| `META_APP_ID`, `META_APP_SECRET` | App de Meta. El secreto firma los webhooks, intercambia el código y arma la credencial de app de `/debug_token`. Nunca sale al navegador. |
| `META_CONFIG_ID` | `config_id` de Facebook Login for Business (Embedded Signup). Público. |
| `META_VERIFY_TOKEN` | Verificación del webhook. |
| `INTEGRATIONS_ENCRYPTION_KEY` | Base64 de 32 bytes: cifra las credenciales. |
| `SESSION_SECRET` | Sesiones y `state` de Embedded Signup. |
| `WHATSAPP_FLOW_ENDPOINT`, `WHATSAPP_FLOW_PRIVATE_KEY` | Endpoint de formularios y su llave privada. |
| `WHATSAPP_PHONE_ID` / `WHATSAPP_TOKEN` (y alias `META_*`) | Puente legado, solo para filas legadas. |
| `META_EMBEDDED_SIGNUP_MOCK` | Solo pruebas: simula a Meta. Nunca en producción. |
| `META_GRAPH_BASE_URL` | Solo pruebas: Graph falso. Los módulos nuevos lo ignoran en producción. |
| `META_GRAPH_VERSION`, `META_VERIFICAR_ACTIVOS`, `XABOR_WHATSAPP_DESCONEXION_AUTOSERVICIO` | Nuevas (§5.6). |

---

## 8. Pruebas

| Suite | Qué cubre |
|---|---|
| `test/fase-meta-tech-provider-unidad.mjs` (39) | Sin servidor ni red; Meta simulado con un `fetch` inyectado. Rutas Graph inválidas, Bearer y no URL, redacción de errores, producción solo con `graph.facebook.com`, paginación. Interruptor (lo más estricto gana). Concesión: otra app, token inválido, sin permisos, cuentas solo del permiso de administración, «no vence». Activos: WABA no concedida, número ajeno, descubrimiento, primera cuenta, números ambiguos, ids con forma rara. Limpieza de nombre y número. Modos del callback. Alertas del tablero. Diagnóstico de formularios. Retiro de suscripción. |
| `test/fase-meta-tech-provider.mjs` (30) | Servidor real, base propia y Graph de Meta falso en el proceso de la prueba. Callback en `apagado` (sin llamadas a Meta, igual que antes), `observar` y `exigir`. Aislamiento: número de otro negocio (409, nada se guarda). Desconexión: confirmación, retiro en Meta, credencial borrada, número liberado, sin `/deregister`, idempotencia, reconexión en otro negocio, Meta que no confirma. Autoservicio: 401/403, negocio de la sesión, credencial heredada retirada, interruptor apagado = 404. Bitácora con actor del negocio. Tablero: guardas, ids enmascarados, alertas. Diagnóstico de formularios. Ninguna fuga de token o secreto en respuestas, bitácora ni salida del servidor. |

Cómo correrlas (receta de CLAUDE.md, «Entorno local de pruebas»), con una base
de pruebas propia:

```powershell
node test/fase-meta-tech-provider-unidad.mjs
node test/fase-meta-tech-provider.mjs
```

Puertos: `TEST_PORT_META_TP` (4791, y +10 para el segundo servidor) y
`TEST_PORT_META_FALSO` (4792). La suite de integración crea sus propios
negocios con ids únicos por corrida, así que se puede repetir sobre la misma
base.

Las mordidas (cada garantía desactivada a propósito y vista fallar) y la
comparación contra la base `e64c2349` de las suites existentes relacionadas se
reportan en el PR.

---

## 9. Configuración manual en Meta (lo que no se programa)

En el panel de desarrolladores de Meta, con la cuenta dueña de la app de Xabor:

1. **App de Meta** (la existente, no crear otra): tipo Business, caso de uso
   WhatsApp.
2. **Facebook Login for Business → Configuraciones**. La configuración de
   Embedded Signup (variación de inicio de sesión «Embedded Signup») da el
   `config_id` (`META_CONFIG_ID`). Revisar:
   - **Vencimiento de la credencial**: Meta documenta que el token de
     integración de negocio «por omisión no vence», y en Xabor vencen a ~60
     días. Ver qué opción está elegida y, si la hay, elegir que no venza.
     **Por confirmar en el panel**: no se encontró en la documentación el
     nombre exacto de esa opción.
   - Los permisos de la configuración: `whatsapp_business_management` y
     `whatsapp_business_messaging`. **No** hace falta `business_management`:
     Meta lo pide solo para administrar por programa el portafolio propio.
   - La versión de Embedded Signup (v4 hoy). No pasar a v5 hasta que el
     frontend lea `messaging_account_ids` (§15) o `exigir` esté encendido.
3. **Webhooks** (producto WhatsApp): URL `https://<dominio>/webhook/whatsapp`
   con certificado válido, token de verificación y campos `messages` y
   `account_update` (más `history`, `smb_app_state_sync` y
   `smb_message_echoes` para la fase F2).
4. **Configuración básica**: ícono, categoría, **URL de política de
   privacidad**, **URL de condiciones** y **URL o callback de eliminación de
   datos** (hoy falta: §10).
5. **Verificación del negocio** del portafolio de Xabor (documentos de la
   empresa).
6. **App Review** (§11).
7. En cada negocio (lo hace el negocio, no Xabor): **método de pago** en
   WhatsApp Manager y, si aplica, el nombre visible aprobado.

---

## 10. Guía Tech Provider

Estado del programa según Meta (27-nov-2026):
- Requisitos: **verificación del negocio** y **App Review con acceso
  avanzado** a `whatsapp_business_messaging` y `whatsapp_business_management`.
  Sin acceso avanzado, las llamadas a cuentas que no son tuyas fallan con
  error 200.
- **La verificación de acceso (Access Verification) se retiró el
  9-oct-2026.** Algunas páginas todavía la mencionan; el anuncio de Meta y su
  propia página dicen que ya no se pide.
- **Tech Provider ≠ Solution Partner**: el Tech Provider no tiene línea de
  crédito. Cada cliente agrega su método de pago y Meta le cobra
  directamente.
- **Límite de altas**: 10 cuentas nuevas por 7 días móviles. Sube solo a 200
  tras la verificación y la revisión.
- **Token**: Meta recomienda que el Tech Provider use el token de usuario de
  sistema de integración de negocio (el que devuelve el intercambio del
  código de Embedded Signup), no un token de usuario de sistema común.
- **Coexistencia**: la piden la app de WhatsApp Business 2.24.17 o posterior,
  un webhook funcionando y el registro de sesión (session logging). Tiene un
  tope fijo de 20 mensajes por segundo. Los mensajes enviados desde la app
  siguen sin costo y los de la API se cobran a tarifa de Cloud API. No se
  sincronizan grupos. Algunas funciones de la app se desactivan (ver la
  página de Meta).

| Paso | ¿Manual o programable? |
|---|---|
| Verificación del negocio de Xabor | Manual (Meta) |
| Configuración de la app, FBL4B, webhooks, URLs legales | Manual (panel de Meta) |
| App Review y videos | Manual |
| Conexión de cada negocio (Embedded Signup) | Programable, ya existe |
| Verificación de activos, registro, suscripción | Programable, ya existe (verificación con interruptor) |
| Método de pago del negocio | Manual (lo hace el negocio en WhatsApp Manager) |
| Formularios y plantillas por negocio | Programable (fases F3/F4) |
| Diagnóstico y desconexión | Programable, esta entrega |

---

## 11. App Review

Meta pide un video de pantalla por permiso, además de ícono, política de
privacidad y categoría. Propuesta de contenido (grabado en un negocio de
prueba propio de Xabor, nunca en un cliente):

**`whatsapp_business_management`**: Xabor administra la cuenta de WhatsApp
que el restaurante le conecta.
1. Configuración → Integraciones → Conectar WhatsApp.
2. Ventana de Meta: elegir el portafolio, la cuenta y el número, y aceptar
   permisos.
3. La tarjeta pasa a «Conectado» con el número y el nombre aprobado.
4. Superadmin → Meta / WhatsApp: estado, formularios y su diagnóstico.

**`whatsapp_business_messaging`**: Xabor recibe y contesta los mensajes de
los clientes del restaurante.
1. Un cliente escribe al número de prueba.
2. El mensaje aparece en Chats y el bot responde.
3. Se toma un pedido con el formulario y llega a Comandas.

Descripción de uso (para el formulario de Meta): «Xabor es un sistema de
pedidos para restaurantes. Cada restaurante conecta su propia cuenta de
WhatsApp Business por Embedded Signup para recibir pedidos y contestar a sus
clientes. Xabor nunca pide contraseñas y los activos siguen siendo del
restaurante; el restaurante paga su mensajería directamente a Meta».

Bloqueos antes de enviarla:
- URL o callback de **eliminación de datos** (fase F5): Meta pide una de las
  dos.
- Política de privacidad pública que mencione WhatsApp y qué datos se
  guardan.

---

## 12. Alta de clientes

### 12.1 Autoservicio
El flujo de §4 desde el panel del negocio (rol admin, módulo `whatsapp`
contratado).

Antes de empezar, el negocio necesita:
- una cuenta de Facebook propia con acceso a su portafolio comercial (o crear
  uno en la ventana de Meta);
- el número:
  - nuevo, sin WhatsApp: Cloud API;
  - o el de su app de WhatsApp Business actualizada: coexistencia;
- poder recibir el código de verificación en ese número.

Después de conectar:
- agregar el método de pago en WhatsApp Manager;
- configurar pedidos;
- probar.

### 12.2 Asistido por Xabor
Superadmin abre la ficha del negocio → WhatsApp → **Iniciar conexión**. El
`state` lleva al actor Superadmin y todo queda auditado. Se hace **con el
dueño del negocio presente** (en llamada o en persona): él inicia sesión en
la ventana de Meta con su propia cuenta. Xabor nunca pide su contraseña ni le
pide transferir activos al portafolio de Xabor.

Si la conexión queda a medias (`pendiente_activacion`), «Completar
activación» la reintenta sin repetir el Embedded Signup.

---

## 13. Recuperación y soporte

| Situación | Qué se ve | Qué hacer |
|---|---|---|
| Credencial por vencer o vencida | Alerta en el tablero; la tarjeta del negocio dice «Requiere reconexión» | El negocio reconecta (mismo flujo). La recepción no se corta mientras tanto. |
| Meta rechaza la credencial (190/102) | Alerta crítica `credencial_rechazada` | Reconectar. Revisar si el negocio quitó a Xabor de sus apps conectadas. |
| «Este número ya está asociado a otro negocio» (409) | El callback responde 409 | Si el otro negocio ya no lo usa, **Desconectar** allí: libera el número. Después, conectar donde va. |
| Activación pendiente | `activacion_pendiente` | «Completar activación» (Superadmin) o «Reintentar» (negocio). |
| Sin suscripción | `sin_suscripcion` | Reintentar la activación (`subscribed_apps`). |
| Formulario en borrador, retirado o bloqueado | Diagnóstico de formularios | Publicar o reemplazar el Flow; actualizar `whatsapp_flow_<tipo>_id`. |
| El número no tiene llave de cifrado | Diagnóstico de formularios | Subir la llave pública: `POST /{pnid}/whatsapp_business_encryption` (fase F3, hoy por script). |
| El negocio quiere irse o cambiar de número | — | **Desconectar** y, si quiere, quitar a Xabor como socio en su portafolio. |
| Meta no confirmó el retiro de la suscripción | `avisoMeta` en la respuesta | Xabor ya no enruta ni envía por ese número. El negocio puede quitar a Xabor como socio. |

---

## 14. Despliegue, reversa y lista de verificación

**Despliegue** (solo con la autorización del dueño):
1. Rebasar la rama sobre lo que corra producción en ese momento y correr
   `node scripts/predeploy-check-incidentes.mjs` y las dos suites nuevas.
2. Publicar como de costumbre (CLAUDE.md, «Desplegar a producción»). No hay
   migraciones.
3. Verificar que llegó: la pestaña «Meta / WhatsApp» aparece en
   `/superadmin` (huella del panel) y `GET /api/superadmin/meta/resumen`
   responde 200 con sesión de Superadmin.
4. No encender nada el primer día. El tablero y el diagnóstico solo leen.

**Encendido gradual**: `meta_verificar_activos=observar` en un negocio de
prueba → `META_VERIFICAR_ACTIVOS=observar` → `exigir`. La desconexión del
propio negocio se enciende cuando exista el botón en su panel (F1).

**Reversa**:
- Las banderas se apagan sin desplegar: borrar la variable o la clave.
- El código se revierte con `git revert` del commit; no hay esquema que
  deshacer.
- Una desconexión hecha por error se revierte reconectando con Embedded
  Signup: la credencial borrada no se recupera, y eso es a propósito.

**Lista de verificación**
- [ ] Suites nuevas en verde y mordidas que muerden.
- [ ] Suites relacionadas sin diferencias contra la base.
- [ ] `predeploy-check-incidentes` en verde.
- [ ] Ningún archivo protegido en el diff.
- [ ] Sin secretos, teléfonos ni ids en el diff.
- [ ] Autorización del dueño para publicar.
- [ ] Tras publicar: pestaña visible, resumen 200, conexión de prueba en `apagado` igual que antes.

---

## 15. Pendientes que necesitan aprobación o terceros

**En archivos protegidos (necesitan aprobación del dueño):**
1. **Versión de la Graph API**: cambiar `v20.0` por `versionGraph()` en
   `whatsapp-meta.js`, y en el mismo cambio en `metaEmbeddedSignup.js`,
   `metaEnvioDocumentos.js`, `campanasWa.js`, `otpProveedores.js`,
   `clientesSaneamiento.js` y los scripts. Riesgo: bajo para los endpoints que
   se usan (mensajes, medios, registro, suscripción), pero toca el envío de
   todos los negocios. Hay que probarlo con una conversación real. Fecha
   límite práctica: 21-ene-2027.
2. **`PARTNER_REMOVED`**: que un evento de cuenta no desconecte una
   integración que se volvió a conectar **después** de la fecha del evento
   (Meta reintenta los webhooks hasta 7 días).
3. **`panel/index.html`**:
   - botón «Desconectar» en la tarjeta de WhatsApp, que llama a
     `POST /api/integraciones/whatsapp/desconectar`, y encender
     `XABOR_WHATSAPP_DESCONEXION_AUTOSERVICIO`;
   - Embedded Signup v4 explícito y, después, v5 (`messaging_account_ids`,
     coexistencia activada por omisión);
   - mostrar el número y el nombre que ahora sí se guardan.
4. Recibir y procesar los eventos de estado de los formularios.

**Dependen de Meta o de terceros:**
- Verificación del negocio y App Review (§10, §11).
- Revisar el vencimiento de la credencial en la configuración de FBL4B (§9).
- URL o callback de eliminación de datos y política de privacidad (§11).

**Decisiones de producto:**
- ¿Importar historial y contactos en coexistencia (24 h, una sola vez)?
- ¿Nivel «organización» para grupos de sucursales?
- ¿Plantillas y formularios administrados por el negocio o solo por Xabor?

---

## Fuentes (Meta, consultadas el 27-nov-2026)

- Graph API, versiones y caducidad: https://developers.facebook.com/docs/graph-api/changelog/versions · https://developers.facebook.com/docs/graph-api/guides/versioning
- Embedded Signup, versiones (v5 vigente, v2/v3 retiradas): https://developers.facebook.com/docs/whatsapp/embedded-signup/versions · https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-5 · https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/version-4
- Embedded Signup, implementación y evento: https://developers.facebook.com/docs/whatsapp/embedded-signup/implementation
- Alta como Tech Provider (intercambio, registro, suscripción): https://developers.facebook.com/docs/whatsapp/embedded-signup/onboarding-customers-as-a-tech-provider
- Cuenta compartida con `debug_token` (`target_ids` de `whatsapp_business_management`): https://developers.facebook.com/docs/whatsapp/embedded-signup/manage-accounts · https://developers.facebook.com/docs/graph-api/reference/debug_token/
- Facebook Login for Business (token de negocio): https://developers.facebook.com/docs/facebook-login/facebook-login-for-business · https://developers.facebook.com/documentation/business-messaging/whatsapp/access-tokens.md
- Coexistencia: https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users
- Programa Tech Provider y App Review: https://developers.facebook.com/docs/whatsapp/solution-providers/get-started-for-tech-providers · https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/overview.md · https://developers.facebook.com/documentation/business-messaging/whatsapp/solution-providers/app-review.md
- Retiro de Access Verification: https://developers.facebook.com/blog/post/2026/10/09/retiring-access-verification-for-tech-provider-apps/
- Caso de uso WhatsApp (`business_management` no requerido): https://developers.facebook.com/documentation/development/create-an-app/whatsapp-use-case
- Webhooks (firma, reintentos, overrides, `account_update`): https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview.md · https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/override.md · https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/account_update.md
- Registro de números: https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/registration.md
- Flows API, endpoint, cifrado y salud: https://developers.facebook.com/docs/whatsapp/flows/reference/flowsapi · https://developers.facebook.com/docs/whatsapp/flows/guides/implementingyourflowendpoint · https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/whatsapp-business-encryption/ · https://developers.facebook.com/docs/whatsapp/flows/guides/healthmonitoring · https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/changelogs
- Eliminación de datos: https://developers.facebook.com/docs/development/create-an-app/app-dashboard/data-deletion-callback
