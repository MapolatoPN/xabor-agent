# El bot de WhatsApp, tal como está hoy

Nota de campo previa al Mesero Digital. Describe el camino REAL de un mensaje,
no el que sugiere el diagrama de la arquitectura. Escrita leyendo el código de
`feat/whatsapp-mesero` (base `203b059`), no de memoria.

## El camino de un mensaje

```
POST /webhook/whatsapp                       whatsapp-meta.js:1666
  │  firma HMAC (firmaWebhookValida)
  │  200 inmediato a Meta
  ▼
continuidadWA.recibir(entradas, body)        services/whatsappContinuidad.js
  │  persiste en whatsapp_entradas
  │  AGRUPA 6 s por (negocio, teléfono)      ← el debounce
  ▼
continuidadWA.procesar(payloads, n, t)       whatsapp-meta.js:1929
  │
  ├─ solicitaAtencionHumana(texto)? → enviarARevision → PAUSA y RETORNA
  │
  ├─ por cada payload: prepararMensajePersistido()
  │     ├─ integración del número ≠ negocio → CANAL_CAMBIO_DE_NEGOCIO
  │     ├─ compras autorizadas (manejarCompraWhatsapp) → puede atender y RETORNAR
  │     ├─ document → manejarDocumentoEntrante → RETORNA
  │     ├─ image → manejarImagenEntrante → devuelve el texto del turno (marca + caption)
  │     ├─ upsertCliente + marcarLeido + marcarRespuestaCampana
  │     ├─ comandos de Mario (procesarAprobacion) → RETORNA
  │     ├─ GATE 1  bot_whatsapp_activo === true      → si no: sombra + RETORNA
  │     ├─ GATE 1b bot_pausado del cliente           → si sí: sombra + RETORNA
  │     ├─ GATE 1c takeover humano vigente           → si sí: sombra + RETORNA
  │     ├─ auto-registro de repartidor → responde y RETORNA
  │     └─ repartidor conocido → enrutarMensajeRepartidor (puede caer al flujo cliente)
  │
  ├─ GATE 2  vuelve a leer pausado / takeover / bot activo   ← re-chequeo del turno agrupado
  │
  └─ procesarTextoPersistido(textos.join('\n'), …)  whatsapp-meta.js:1887
        ├─ visión: analiza fotos archivadas (máx 2) y sustituye cada marca
        │          por [CONTEXTO VISUAL]…[/CONTEXTO VISUAL]
        ├─ prepararTurnoParaIA(textoCombinado, contextosVisuales)
        └─ procesarConClaude(telefono, texto, nombreMeta, negocioId)   :809
              └─ procesarMensaje()                    agent/brain.js
```

**Los dos gates son independientes y hacen falta los dos.** Se midió: quitar
solo el `return` que sigue a la observación en sombra no rompe ninguna prueba,
porque el re-chequeo antes de `procesarTextoPersistido` ataja. Quitar los dos
tumba nueve casos. Ver `test/fase-canal-callado.mjs` y la tabla de mordidas de
`docs/incidente-smoke-sombra-2026-09-13.md`.

## Dentro de `procesarConClaude`

Es la única puerta al modelo, y también la que concentra casi todas las salidas
a WhatsApp. En orden:

1. seguimiento de pedido (consulta de estado) — responde de DB, sin modelo;
2. pagos: enlace Clip, folio, "ya pagué";
3. **`procesarMensaje` (brain.js)** — la respuesta conversacional;
4. marcador `<ENVIAR_MENU>` → envía la imagen del menú (ruta propia, con imagen);
5. facturación (`<FACTURA>`);
6. aviso de revisión (`enviarARevision`) si el resultado lo pide;
7. `enviarMensaje(telefono, resultado.texto)` — la salida normal, línea 1442.

## Dentro de `brain.js`, lo que ya existe y hay que reutilizar

```
procesarMensaje(sessionId, mensaje, negocioId, …)
  ├─ modo = await modoDelPedido(negocioId)          ← LEGACY | SHADOW | V2, por negocio
  ├─ evidenciaDelCiclo()                            ← V2: solo lo DICHO; LEGACY: ciclo crudo
  ├─ llamada al modelo (system prompt de prompts.js)
  ├─ aplicarCarrito(propuesta)  si modo.v2          ← reconciliar() de carritoDelPedido.js
  │     └─ 2ª pasada con terminosDelCatalogo si quedó algo sin respaldo
  ├─ validarBorradorPedido(…, { v2: modo.v2 })      ← validadorOrden.js
  └─ preview / confirmación / registrarPedido
```

- **El horario** no es una rutina que envíe nada. `obtenerEstadoRestaurante(reglas)`
  (prompts.js:275) calcula abierto/cerrado desde `configuracion.reglas_atencion`, y
  `construirSystemPrompt` lo inyecta en el bloque «HORARIO — REGLA CRÍTICA». El
  aviso de "estamos cerrados" lo REDACTA el modelo.
- **El saludo** igual: bloque «TONO Y SALUDO CONFIGURADOS POR EL NEGOCIO».
- No hay saludo automático ni aviso de horario fuera de `brain.js`. Está probado
  por negación en R6 y R7 de `fase-canal-callado`.

## Salidas a WhatsApp que NO pasan por `brain`

Importan porque cualquier capa nueva tiene que respetarlas:

| Salida | Dónde | Cuándo |
|---|---|---|
| menú (imagen) | `<ENVIAR_MENU>` :1340 | el modelo pone el marcador |
| enlace de pago Clip | :909, :992 | flujo de pago |
| estado del pedido | seguimiento | consulta de estado |
| factura | `<FACTURA>` :1387 | el modelo pone el marcador |
| registro de repartidor | :1863 | texto "repartidor Nombre" |
| flujo de repartidor | `enrutarMensajeRepartidor` | número registrado |
| compras | `manejarCompraWhatsapp` | comprador autorizado |
| alertas al admin | :92, :128, :208, :1163 | errores, escalación, pedido perdido |
| plantillas de reparto | :329, :395, :444 | oferta a repartidores |

Todas están DESPUÉS de los gates del bot salvo las alertas al admin, que no van
al cliente.

## Estado conversacional que ya existe

`agent/session.js`, en memoria, con snapshot durable por conversación:

- `mensajes[]` — historial completo;
- `cicloPedido` — índice donde empieza el pedido en curso; lo dicho antes no
  respalda nada de ahora;
- `carrito` — **solo en V2**; es el que protege `carritoDelPedido.js`;
- `pedido`, `datosPedido`, `esperandoDato`, `aclaracionProducto`,
  `previewPedido`, `ordenesConfirmadas`.

No existe hoy: fase conversacional, foco, referencias, propuestas del bot,
intenciones. Eso es lo que agrega el Mesero.

## Errores y fallbacks

- `registrarError(negocioId)` cuenta fallos; 3 en 5 min → alerta al admin.
- Cualquier excepción dentro de `procesar` marca la conversación
  `EJECUCION_NO_VERIFICADA` → pausa y revisión humana.
- El vigilante de continuidad libera conversaciones que nadie atendió y avisa.
- `obtenerConfiguracion` devuelve `{}` si falla: toda bandera cae a su default.

## Consecuencia para el Mesero Digital

La frontera ya está construida y hay que apoyarse en ella, no rodearla:

- **el canal decide si se contesta** (dos gates);
- **`modoDelPedido` decide con qué motor**, por negocio, default LEGACY;
- **`carritoDelPedido` decide qué entra al pedido**, campo a campo.

El Mesero se mete entre el modelo y el reconciliador: interpreta, propone y
pregunta. No adquiere ninguna autoridad nueva sobre el pedido.
