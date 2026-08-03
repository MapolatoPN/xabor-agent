# Asistente Comercial de Cotizaciones por WhatsApp — Implementación (v1, solo texto)

> Rama: `feat/asistente-comercial-cotizaciones-whatsapp`, creada desde
> `release/pagos-documentos-cotizaciones-v1` (ya estabilizado y pusheado).
> No se tocó producción, no se hizo deploy, no se hizo push de esta rama
> todavía (pendiente de tu autorización). Flujo completo texto → borrador
> → aprobación humana → envío, probado de punta a punta.

## Resumen del flujo implementado

```
Cliente escribe por WhatsApp
        │
        ▼
IntentDetector (Claude Haiku, clasificación barata)
        │  solo si 'generador_cotizaciones' está habilitado
        ▼
Sesión comercial (sesiones_comerciales, durable, aislada por negocio+teléfono)
        │
        ▼
Conversación normal (brain.js + prompt de modo comercial) —
el modelo pregunta uno o dos campos a la vez, nunca todos de golpe
        │  <CAMPO_COMERCIAL_CAPTURADO> por cada dato nuevo
        ▼
Campos acumulados en la sesión (nombre, fecha, lugar, personas, items, presupuesto, observaciones)
        │  cuando hay información suficiente: <BORRADOR_LISTO>
        ▼
DraftBuilder — crea cotizacion(borrador, origen=whatsapp_ia)
consultando el catálogo real para precios (nunca inventa)
        │
        ▼
Notificación WS al panel + badge "🤖 IA" + resaltado de precio pendiente
        │
        ▼
Administrador revisa, edita si hace falta, y aprueba
        │  POST /api/cotizaciones/:id/enviar (ya admin-only, existente)
        ▼
PDF generado y enviado por WhatsApp — la sesión comercial se finaliza
```

**Contrato de seguridad cumplido** (verificado con pruebas, no solo por diseño):
negocio_id obligatorio en toda función nueva (`TenantContextRequiredError`
si falta); sin fallback a Nonna Maye; aislamiento cruzado entre negocios
verificado; la IA nunca puede llamar `POST /api/cotizaciones/:id/enviar`
por sí misma (verificado por análisis estático del código de `brain.js`
en la prueba end-to-end); ningún precio se genera por el modelo — todo
producto se busca en el catálogo real o queda marcado como pendiente de
revisión con precio 0; fail-closed ante información insuficiente (el
borrador nunca se crea si faltan campos obligatorios).

---

## Fase 1 — IntentDetector y máquina de estados

- **Migraciones**: `028_sesiones_comerciales.sql` (+`_down`+`_check`, renumerada
  de 027 para no colisionar con el hotfix `027_cotizaciones_iva_tasa.sql`) —
  `cotizaciones.origen` (`panel`|`whatsapp_ia`), tabla `sesiones_comerciales`
  (estado durable, índice único parcial: una sola sesión activa por
  negocio+teléfono), tabla `sesiones_comerciales_eventos` (auditoría
  append-only scoped por `negocio_id`).
- **Archivos**: `src/agent/intentDetector.js`, `src/services/sesionComercial.js`.
- **Endpoints**: ninguno nuevo (servicios internos).
- **Pruebas**: `test/fase-asistente-comercial-1-sesiones.mjs` — 27/27.
  Cubre: fail-closed sin `negocioId`, ciclo de vida completo, unicidad de
  sesión activa bajo llamadas concurrentes, aislamiento cruzado entre
  negocios, reglas de activación del clasificador (incluye el caso real
  de `ANTHROPIC_API_KEY` inválida → `ambiguo`, nunca lanza).
- **Criterios de aceptación**: cumplidos — el módulo debe estar
  habilitado antes de clasificar; `ambiguo` nunca activa el modo;
  aislamiento total por negocio.
- **Riesgos**: el clasificador es una llamada real a Claude por mensaje
  entrante con el módulo activo — costo pequeño pero no cero; mitigado
  porque solo se ejecuta si el negocio contrató el módulo.

## Fase 2 — Memoria conversacional y extracción de campos

- **Archivos**: `src/agent/prompts.js` (bloque aditivo
  `construirBloqueModoComercial`), `src/agent/comercialMarkers.js`
  (parsing puro de marcadores), `src/agent/brain.js` (integración
  aditiva en `procesarMensaje`).
- **Endpoints**: ninguno.
- **Pruebas**: `test/fase-asistente-comercial-2-extraccion.mjs` — 12/12.
  Extracción de campos múltiples por turno, marcadores inválidos
  ignorados sin descartar los demás, acumulación de items sin
  reemplazar, limpieza del texto visible al cliente.
- **Criterios de aceptación**: cumplidos — el cliente nunca ve un
  marcador interno; los campos ya capturados nunca se pierden entre
  turnos.
- **Riesgos**: el modelo podría "olvidar" emitir un marcador para un
  dato mencionado — mitigado porque el prompt inyecta de vuelta los
  campos ya capturados en cada turno, y porque el criterio de
  completitud vive en código (DraftBuilder), no en la honestidad del
  modelo.

## Fase 3 — Creación de borrador (DraftBuilder)

- **Archivos**: `src/services/draftBuilder.js`; `crearCotizacion`
  (database.js) ganó el parámetro `origen`.
- **Endpoints**: ninguno nuevo — reutiliza el módulo de cotizaciones ya
  existente y probado.
- **Pruebas**: `test/fase-asistente-comercial-3-draftbuilder.mjs` — 7/7.
  Información insuficiente → no crea nada; item con coincidencia real en
  el catálogo usa ese precio; item sin coincidencia → precio 0 marcado
  pendiente; idempotencia (nunca dos borradores para la misma sesión);
  aislamiento cruzado.
- **Criterios de aceptación**: cumplidos — nunca se inventa un precio ni
  un producto.
- **Riesgos**: la búsqueda en catálogo es por coincidencia de texto
  (`ILIKE`) — un nombre de producto mal escrito por el cliente no
  encontrará coincidencia y quedará con precio pendiente (comportamiento
  correcto y seguro, solo requiere revisión humana adicional).

## Fase 4 — Notificación y UI de revisión en panel

- **Archivos**: `panel/index.html` (badge, resaltado de precio
  pendiente, manejo del evento WS), `src/server.js` (export de
  `broadcastNegocio`, ya usado por `brain.js`).
- **Endpoints**: ninguno nuevo — `GET /api/cotizaciones`/`:id` ya
  devuelven `origen` (columna incluida automáticamente).
- **Pruebas**: `test/fase-asistente-comercial-4-panel.mjs` — 7/7 (HTTP +
  checks estáticos de HTML, mismo criterio que
  `fase-controles-atencion-frontend.mjs`). Validado también visualmente
  en el navegador real (badge y resaltado confirmados).
- **Criterios de aceptación**: cumplidos.
- **Riesgos**: ninguno nuevo — cambios puramente aditivos y de solo
  lectura sobre datos ya expuestos.

## Fase 5 — Aprobación humana y envío

- **Archivos**: `src/server.js` (hook de finalización de sesión en
  `POST /api/cotizaciones/:id/enviar`, ya existente y admin-only —
  ningún endpoint nuevo). Bugs preexistentes corregidos en
  `src/channels/whatsapp-meta.js` (ver abajo).
- **Endpoints**: ninguno nuevo.
- **Pruebas**: `test/fase-asistente-comercial-5-e2e.mjs` — 8/8, flujo
  real completo (2 mensajes de WhatsApp con debounce real de 6s,
  clasificación, sesión, extracción en 2 turnos, borrador con precio
  real del catálogo, aprobación admin, envío mockeado, finalización de
  sesión, y una nueva sesión limpia para la siguiente solicitud del
  mismo cliente). Usa `test/lib-anthropic-mock.mjs` (nuevo, mismo
  patrón que el mock de Meta) — nunca llama a la API real de Anthropic.
- **Criterios de aceptación**: cumplidos — la aprobación es
  exclusivamente humana (verificado por análisis estático del código,
  no solo por diseño).
- **Riesgos**: ninguno nuevo introducido; ver bugs corregidos abajo
  (existían antes de esta sesión, afectaban también a la memoria de
  cliente existente).

### Bugs preexistentes encontrados y corregidos (no introducidos por esta sesión)

1. `clienteCtx` nunca incluía `telefono` en el canal de WhatsApp — tanto
   la memoria de cliente existente como el Asistente Comercial nuevo
   dependían de ese campo y nunca se activaban desde un mensaje real.
   Corregido solo en la rama de "cliente ya existente" para no alterar
   el bloque "cliente recurrente" del prompt cuando el cliente es nuevo.
2. `enviarMensaje`/`enviarImagen`/`marcarLeido` tenían la URL de Meta
   hardcodeada (a diferencia de `enviarDocumento`, que ya respetaba
   `META_GRAPH_BASE_URL`) — sin efecto en producción, pero impedía
   probar el envío de texto normal contra un mock.

---

## Regresión completa (dos bases Docker frescas, release + asistente comercial)

**397/397 pruebas pasadas en ambas bases** (19 suites: 14 ya existentes
+ 5 nuevas de este bloque) — cero regresiones sobre WhatsApp, Rappi,
pagos, pedidos, u otro módulo existente.

## Fuera de alcance de esta v1 (explícito, confirmado con el encargo)

- Fotos/PDF/audio como entrada de la conversación comercial.
- Interpretación automática de la respuesta del cliente tras recibir el
  PDF (aceptar/objetar/pedir cambios) — el cliente puede responder por
  texto normal y un administrador lo atiende manualmente, igual que hoy.
- Conversión automática de una cotización aceptada en pedido/evento.
- Rechazo explícito de un borrador por el administrador (hoy: simplemente
  no se envía, o se edita antes de enviar).

## Pendiente de tu autorización

- Push de esta rama (no se ha hecho — el flujo completo ya está
  probado y verde, listo para tu decisión).
- Activar el módulo `generador_cotizaciones` para un negocio piloto real
  en producción — ninguna acción de este tipo se ejecuta sin tu
  autorización explícita, igual que el release anterior.
