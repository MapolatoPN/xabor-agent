# Mesero de WhatsApp — pedido canónico, un solo circuito de mutación

> Rama local `feat/mesero-pedido-canonico`, nacida de `41c003b`
> (`origin/prod/mesero-shadow-v3` al 2026-09-26). Sin push ni despliegue.
> Este documento tiene dos partes: el **diagnóstico** (escrito antes de tocar
> código) y la **arquitectura resultante** (al final, se completa con la
> implementación).

### Revisión 2 (Codex) — dónde quedó cada hallazgo

| Hallazgo | Causa | Corrección | Dónde |
|---|---|---|---|
| 1 · el outbox podía enviar dos veces | el `enviar` del despachador mandaba a Meta y guardaba el historial en la misma llamada: si el guardado fallaba DESPUÉS de que Meta aceptó, se contaba como fallo de envío, la fila seguía `pendiente` y se reenviaba (reproducido: Meta invocado 2 veces); además el envío en línea y el despachador podían tomar la misma fila, y un timeout se reintentaba a ciegas | reclamo `pendiente→enviando` antes de llamar a Meta, `entregado`+wamid PRIMERO y aislado, clasificación rechazado/incierto, `incierto` → persona sin reenvío, barrido de `enviando` viejas, conciliación del diálogo al leer | §5, `entregaDeRespuestas.js`, 099 |
| 2 · el legacy no obedecía la carta | `brain.js`/`prompts.js`, promociones, negativas, respaldo en texto, sombra, checklist y la puerta final usaban el menú operativo; solo el Agente v1 filtraba | una sola regla por canal (`canalConCartaPublicada`/`cartaDelCanal`) en cada uno de esos puntos, fallo cerrado, y la puerta final exige la carta por canal | §7, §12 |
| 3 · el panel no llegaba a la pantalla | faltaba el enlace; las rutas aceptaban el token legado con `x-negocio-slug` | enlace mínimo en Menú (admin + módulo); rutas con `requireSesionNegocio('admin')` | §7 |
| 4 · gate completo en Postgres nueva | el runner nunca se había corrido desde cero | base desechable nueva, receta de CLAUDE.md, runner completo exit 0; el gate cubre también al legacy | §16, §18 |

### Candidato canario (revisión 3) — los tres bloqueos

| Bloqueo | Causa | Corrección | Dónde |
|---|---|---|---|
| A · outbox sin persona | un rechazo que agotaba `maxIntentos` quedaba `fallido` y una respuesta de más de 15 min quedaba `descartado`, sin pausar la conversación ni avisar a nadie; el incierto sí pedía persona, pero sin reintento si la petición fallaba o el proceso moría; `enviarARevision` leía y escribía sin candado (dos procesos → dos avisos); la lectura de «ya la atiende una persona» fallaba abierta | la fila guarda `humano_motivo` en la MISMA sentencia que la saca de circulación (rechazo agotado, vencida, incierta, emisor muerto) y la confirmación se reclama con arrendamiento propio (`humano_reclamado_at`) hasta dejar `humano_confirmado_at`; el despachador retoma lo que quedó sin confirmar; `enviarARevision` bloquea la fila de la conversación (`FOR UPDATE`); la persona se pide con la puerta completa (pausa + panel + WhatsApp al encargado); «atendida» mira también la revisión durable y, si no se puede leer, no envía | §5, `entregaDeRespuestas.js`, `whatsappContinuidad.js`, 099 |
| B · P8c nunca terminaba | la prueba esperaba `MODULOS.length > 0`; un negocio sin módulos lo deja vacío para siempre | se espera el FIN de la carga de permisos (`NEGOCIO_ID` y `navTabActual`, asignados en el mismo tramo síncrono que `aplicarModulosUI`), con controles positivos; P8d cubre un negocio sin ningún módulo | §16 |
| C · carta vacía en runtime | con cero publicados, el agente todavía contestaba promociones, horario y catering antes de su chequeo, y el legacy seguía conversando (texto fijo de Nonna Maye, «no manejamos X», «no hay promociones»); el menú en imagen salía igual | una guarda ÚNICA en el canal, justo antes de todo lo que habla de productos (menú en imagen, catering por el modelo, agente y legacy; los atajos del pedido existente siguen): sin carta (vacía o ilegible) la conversación pasa a una persona (`SIN_CARTA_WHATSAPP`, no se suelta sola); defensa en profundidad en el agente (antes de cualquier atajo) y en `brain.js` (sin modelo, sin texto); una promoción ilegible ya no se presenta como «no hay»; el gate bloquea TODO bot encendido sin carta | §7, §15, §18 |

---

## Parte 1 — Diagnóstico (antes de modificar)

Todo lo de esta parte está verificado contra el código de `41c003b`; las
referencias `archivo:línea` son de ese commit.

### 1. Recorrido actual de un mensaje hasta el pedido

```
Meta  POST /webhook/whatsapp
 └─ continuidad.recibir ─ TX ─ webhook_entrante (UNIQUE canal+referencia)
 │                             whatsapp_entradas (UNIQUE negocio+wamid)  ← dedup real por wamid
 │                             mensajes (message_id_externo)
 │   COMMIT → 200 a Meta (antes: 503 y Meta reintenta)
 └─ barrido cada 500 ms → ejecutar(n,t)
     pg_try_advisory_lock('wa:n:t')  (de SESIÓN, pool de claims, todo el turno)
     lote: 6 s de silencio (tope 30 s), ≤30 mensajes → entradas 'procesando'
     └─ procesar → whatsapp-meta.js
         solicitud humana → prepararMensajePersistido (corte maestro, pausa,
         takeover + 3 sombras) → procesarConClaude
           facturación → modoDelPedido (llave de PROCESO + bandera de NEGOCIO + canario)
           catering / sesión comercial → decidirRutaCateringWhatsApp
           [ruta normal] atajos legacy ANTES del agente: enlace por folio, pago
               pendiente, estado del pedido (regex), puntos, menú automático
           PERFIL CATERING → brain.js forzado (gana al agente)
           if modo.agente → atenderConAgente (canalDelAgente.js:634)
              leerEstado(agente:tel) → cicloParaTurno → catering → promos
              ATAJO DE PROMOS: escribe oferta/ofrecidos, guarda y responde sin ejecutor
              marcarProgramacionRequerida (muta el estado fuera del ejecutor)
              horario / sin catálogo → depurar modalidad y pago (muta fuera del ejecutor)
              atenderTurnoConHerramientas
                saludo → continuidad determinista (oferta, variante, opciones)
                bucle modelo ↔ herramientas:
                  Zod → máquina de estados → libro (clave con turnoId) → ejecutor
                  → reconciliar() → RELECTURA → tool_result
                cerrar(): si hay renglones, el texto del modelo se sustituye por
                          el canónico; si no, se publica la prosa del modelo
                confirmar_pedido → confirmarYEmitir → previsualizar → registrarPedido
                  (validarOrdenPropuesta, folio por secuencia, INSERT pedidos_activos)
                  → [programado: convertir] → emitir (async) → guardarPedido → enlace
              post-procesadores de texto (entrega, confirmación, pago, prohibida,
              «anoté», catering, enlace) → desenlace → guardarEstado (upsert ciego)
           → enviarMensaje (Meta) → guardarMensaje
           → registrarRespuestaEnviada (TX: acusarDialogo ⇒ dialogo.enviado=true)
           else → brain.js (legacy): <ORDEN_CONFIRMADA>/<ORDEN_PREVIEW> → registrarPedido
     TX de cierre: sesión legacy + entradas 'completado' → unlock
```

### 2. Dónde se carga, modifica, valida o confirma un carrito

| Camino | Carga | Muta | Valida | Confirma |
|---|---|---|---|---|
| Agente (`src/mesero-agente`) | `leerEstado` canalDelAgente.js:245 | `ejecutor.aplicar` → `aplicarPropuestas` → `reconciliar` (ejecutorDeHerramientas.js:316); **directo**: `reclasificar` (557), `cancelar_pedido` (757), `programar_para` (974); **fuera del ejecutor**: atajo de promos (canalDelAgente.js:721-735), `marcarProgramacionRequerida` (313-558), `depurarModalidad/PagoNoDisponible` (802-803), `aplicarRespuestaDePago` (1415, `pagoOfrecido`) | `vistaDelPedido` + `maquinaDeEstados` + `validarOpciones` | `confirmar_pedido` → `confirmarYEmitir` (1586) |
| Legacy (`brain.js`) | `sessions` en memoria, persistida como `meta-n-t` | JSON del modelo (`<PEDIDO_BORRADOR>`); solo V2 pasa por `reconciliar` (786) | `validarBorradorPedido` (930) | `<ORDEN_CONFIRMADA>` = JSON crudo del modelo (1121-1162); `<ORDEN_PREVIEW>` = snapshot (1165) |
| Mesero Digital (`src/mesero-whatsapp`) | `Map` en memoria (sombraDelMesero.js:60) | `compilarTurno` → `aplicarPropuestas` | filtro 8d | nunca: solo sombra (`modo.mesero` no lo lee nadie) |
| Sombra del reconciliador | `registroSombra.js` Map propio | `reconciliar` | — | nunca |
| Sombra del agente | `agente-sombra:tel` | mismo ejecutor | mismo | grabadora |
| Simulador / replay / humo | `Map` en memoria | `atenderTurnoConHerramientas` directo | mismo | efecto simulado **sin acuse del diálogo** |
| Registro final | — | — | `previsualizarPedido` / `validarOrdenPropuesta` (DB) | `registrarPedido` (orderManager.js:324) |

### 3. Caminos paralelos

Siete modos conviven en `modoDelPedido`: LEGACY, SHADOW (reconciliador),
V2 (legacy + reconciliador), MESERO (Mesero Digital — **nunca conectado**),
MESERO SOMBRA, AGENTE, AGENTE SOMBRA. Además el simulador del panel
(`simularConAgente`), el replay (`test/replay/motor.mjs`) y el humo
(`scripts/mesero-humo.mjs`) llaman al bucle **directamente**, sin el adaptador:
se saltan el atajo de promos, la marca de programación, los post-procesadores,
el desenlace y el acuse del diálogo. Consecuencia medible: desde `9754928`
la confirmación exige `dialogo.enviado`, que solo pone el adaptador, y el
replay del commit de producción da **23/26**.

### 4. Estado persistido actual

Fila `conversacion_estado(negocio_id, 'agente:<tel>')`, JSON libre:
`carrito{items, datos{modalidad, forma_pago, cliente, costo_envio,
programado_para}}`, `hechos{confirmado, escalado, cancelado, fallido}`,
`folio`, `foco`, `dialogo{id, tipo, huella, foco, enviado, wamid}`,
`ofrecidos`, `ofrecidosDelTurno`, `ofertaPromocionPendiente`,
`promocionInformativaPendiente`, `pagoOfrecido`, `opcionesPendientes`,
`programacionRequerida`, `referenciaProgramacion`, `evento`, `turno`,
`historialDialogo`, `confirmacionIncierta`, `terminadoEn`, `turnoPendiente`.

- **Fase del flujo**: no se persiste; se calcula (`navegando/armando/aclarando/
  listo` + terminales). «Esperando confirmación» es implícito
  (`dialogo.tipo==='resumen'`).
- **Dato pendiente**: repartido en **siete** representaciones que compiten por
  el mismo «sí»: `foco`, `dialogo`, `ofrecidos`, `ofertaPromocionPendiente`,
  `promocionInformativaPendiente` (booleano), `pagoOfrecido`,
  `opcionesPendientes`, más `programacionRequerida`. La precedencia la decide el
  orden del código.
- **Versión**: la columna `revision` existe pero **nadie la compara**.
- **Último wamid aplicado**: no existe; solo `dialogo.wamid` (el de SALIDA).

### 5. Límites transaccionales

Ninguna escritura del agente comparte transacción. Cada una es su propio
autocommit: `leerEstado`, `reservar`/`cerrar` del libro, `nextval`, INSERT del
pedido (+ triggers de folio, estado y deuda de emisión), conversión a
programado (su TX), emisión (TX en el pool de claims), `pedidos`, marca de
revisión, `guardarEstado`, acuse (TX propia) y cierre de la continuidad (TX
propia). Un crash entre el COMMIT del pedido y `guardarEstado` deja el pedido
vivo, el libro en `pendiente` (congela la conversación como «incierta»), pierde
la fila de `pedidos`, el enlace de pago y la respuesta, y manda la
conversación a revisión sin avisar al cliente.

### 6. Deduplicación, locks, reintentos y outbox (lo que existe de verdad)

- **wamid**: deduplicado en `whatsapp_entradas` (UNIQUE negocio+wamid) dentro de
  la TX de recepción. Sólido.
- **Lock**: `pg_try_advisory_lock` de sesión por conversación, sostenido todo
  el turno (modelo y Meta incluidos). `LOCK_PERDIDO` solo se mira al final.
- **Reintentos**: un turno empezado **nunca** se reejecuta; un crash deja
  `EJECUCION_INTERRUMPIDA` y revisión humana.
- **Libro de operaciones**: la clave incluye `turnoId = wa-${Date.now()}`
  (whatsapp-meta.js:1495): solo es estable dentro de una ejecución; no liga la
  operación al mensaje. La confirmación sí tiene guarda por ciclo
  (`uq_agente_confirmacion_conversacion`).
- **Estado**: upsert ciego, último en escribir gana.
- **Outbox: código muerto.** `canalDelAgente.js:861` llama a `encolar` y
  `TIPOS` sin importarlos; el `ReferenceError` lo traga el `catch`. Nada en
  `src/` importa `outbox.js` y `consumir` no está programado. Ninguna suite
  menciona el outbox.

### 7. Texto del modelo que todavía decide cosas de negocio

1. `definir_entrega.direccion/referencias` y `definir_cliente.nombre`: el
   ejecutor los acepta **sin evidencia** en lo que dijo el cliente, y
   `reconciliar` (paso 5, carritoDelPedido.js:990-1003) tampoco la exige.
2. `ofrecidos` se alimenta de las **búsquedas que decidió hacer el modelo**
   (`buscar_producto` con un resultado, `ver_opciones_producto`): un «sí»
   puede agregar un producto que el cliente nunca vio.
3. Notas de cocina (`nota`) redactadas por el modelo sin cotejo.
4. Legacy: el JSON de `<ORDEN_CONFIRMADA>` es el pedido; `<ORDEN_PREVIEW>` se
   vuelve el snapshot confirmable; el CRM marca venta al ver el marcador.
5. Prosa libre publicada cuando el carrito está vacío, en consultas o tras una
   búsqueda con varios candidatos: precios, productos y promesas sin verificar
   (solo se detectan JSON/herramientas/«anoté», y la detección **escala** en
   vez de sustituir).

### 8. Validar un borrador vs. registrar un pedido

| | Borrador (turno) | Registro (`registrarPedido`) |
|---|---|---|
| Carta | la leída al inicio del turno (memoria) | releída de la DB |
| Precios | mapa por nombre del catálogo | canónicos del backend |
| Promociones | `resumenDelPedido` con las activas | motor de `tiendaPromociones` |
| Modalidad | exige evidencia del cliente | `exigirEvidencia:false` |
| Total | lo que lee el cliente (huella) | recalculado; se rechaza si supera al mostrado |
| Programado | referencia + `programar_para` | gate en `confirmarYEmitir` |

La huella liga la confirmación a lo que el cliente leyó; la relectura final
impide cobrar más de lo mostrado. Lo que falta es que ambos lados vean **la
misma carta publicada**: hoy los dos ven la carta operativa completa.

### 9. Causas raíz de los incidentes conocidos

| Incidente | Síntoma | Causa raíz |
|---|---|---|
| Promo aceptada que se pierde (5218787899919) | «Si» → «¿qué productos quieres?» | la oferta pendiente era un booleano; la aceptación no pasaba por el ejecutor. Hoy es estructurada pero: no se liga a «vigente ahora» (una promo de mañana se acepta hoy), `cantidadRequerida` cae a 2 para cualquier tipo (10 % → 2 cafés), se borra con cualquier otro mensaje y autoriza cantidad por nombre |
| «Sí» que duplica el producto (b969959) | 2 cafés por uno | el pendiente se deduce de efectos laterales de lecturas (`ofrecidos`); varias interpretaciones del «sí» compiten |
| JSON filtrado por `max_tokens` | 2 807 caracteres de JSON | la prosa del modelo es el canal de salida; se parchó con detección → escalado |
| Ciclos atascados | «te paso con alguien» sin salida; pedido del 21 gobernando el 23 | hechos terminales persistidos sin ciclo de vida explícito |
| Sesión comercial ancla al bot viejo | 24 clientes nunca llegan al agente | camino paralelo que gana el enrutamiento antes del agente |
| «chipotle», «papas», «chorizo», «sí», «dos» | opción en el grupo equivocado, doble renglón | la respuesta corta se interpreta por coincidencia de palabras contra carrito y carta, no contra **la pregunta que se hizo** |
| Replay 23/26 en producción | confirmaciones que no confirman | simuladores con contrato distinto al canal |

Denominador común: **no existe un estado canónico del pedido con la pregunta
pendiente estructurada, ni un límite transaccional del turno.** Cada parche
agregó otra marca y otra regla de precedencia.

### 10. Qué se conserva y qué se consolida

**Se conserva** (es correcto y está probado): la continuidad de WhatsApp
(dedup por wamid + lock), el contrato Zod de herramientas, la tabla de
legalidad, el ejecutor + `reconciliar` (evidencia del cliente), la vista y la
huella, el libro para efectos externos, `confirmarYEmitir` →
`registrarPedido` → `validarOrdenPropuesta` como puerta final, la validación de
programados, la evidencia de catering, el detector de salida interna y el
canario de `modoDelPedido`.

**Se consolida**: las siete marcas de pendiente → un `pendiente` estructurado;
la fase → explícita, persistida y validada; atajo de promos y aceptación → el
ejecutor; guardado → commit versionado y atómico (estado + operaciones internas
+ respuesta en outbox + traza del turno); `turnoId` → identidad del lote de
wamids; simulador y replay → el mismo commit y acuse; prosa del modelo →
verificación y sustitución por texto derivado del estado; dirección, nombre y
notas → evidencia; carta → publicada por canal.

> Nota posterior: el replay y el simulador recibieron el **acuse** del
> transporte (lo que los hacía medir otro contrato), pero **no** el commit
> transaccional: siguen con estado y libro en memoria. Ver Parte 2, §12.

---

## Parte 2 — Arquitectura resultante

Todo lo de esta parte describe la rama `feat/mesero-pedido-canonico` tal como
queda para revisión (sin commit, sin push, sin despliegue). Nada de esto está
en producción.

### 1. El contrato

> El modelo interpreta y **propone**. Xabor **decide**: catálogo, producto,
> cantidad, modificadores, promociones, precios, horarios, entrega, pedido,
> pago, persistencia y efectos externos.

En código eso significa que el modelo solo puede producir dos cosas: una
llamada de herramienta (que pasa por el circuito de §4) o prosa (que pasa por
la emisión segura de §9, y que con un pedido en curso ni siquiera sale).

### 2. Recorrido de un turno

```
Meta → continuidad (dedup por wamid, lock de sesión, lote de wamids)
  └─ whatsapp-meta.js: loteEnCurso = { wamids }   (AsyncLocalStorage)
      └─ atenderConAgente(… wamids)
          turnoClave = sha(wamids ordenados)
          leerEstadoVersionado → estado esquema 2 + _revision
          ¿turnoClave ∈ turnosAplicados? → devuelve la respuesta ya comprometida
                                           (outbox), no ejecuta nada
          carta = obtenerCatalogoDelAgente (SOLO lo publicado para WhatsApp)
          consulta de promociones → texto oficial + ofrecer_promocion (acción
                                     de sistema, mismo circuito)
          atenderTurnoConHerramientas
            1. respuesta corta contra estado.pendiente → acción determinista
               con autorización explícita (sin modelo)
            2. continuidad determinista de opciones
            3. modelo ↔ herramientas: Zod → legalidad → libro → ejecutor →
               reconciliar → relectura
            4. cerrar(): fija UN pendiente (fijarPendiente), fase derivada,
               texto canónico si hay pedido en curso, emisión segura si no
          post-procesos del canal (entrega, confirmación, pago, catering,
          desenlace) → resumen con total del motor (previsualizarPedido)
          sellarRespuesta → COMMIT DEL TURNO (una transacción):
             conversacion_estado UPDATE … WHERE revision = leída
             agente_operaciones  (mutaciones internas del turno)
             agente_outbox       (respuesta al cliente + eventos del turno)
             agente_turnos       (traza)
      ← enviarMensaje (Meta) → acusarEnvio (una TX: outbox 'entregado' +
        dialogo.enviado) — solo un resumen ACUSADO autoriza un «sí»
  despachador (cada 30 s): respuestas comprometidas y no entregadas → una vez
```

### 3. El estado canónico (esquema 2)

`src/mesero-agente/estadoCanonico.js`. Vive en la misma fila
`conversacion_estado(negocio_id, 'agente:<tel>')`; no hace falta tabla nueva.

| Campo | Qué es |
|---|---|
| `esquema` | 2. Una fila anterior se actualiza al leerse (`normalizarEstado`), sin inventar autorizaciones: `ofrecidos` y `ofertaPromocionPendiente` se descartan. |
| `fase` | `seleccionando_productos`, `completando_opciones`, `definiendo_entrega`, `definiendo_pago`, `esperando_confirmacion`, `confirmado`, `cancelado`, `requiere_humano`, `capturando_evento`. **Se deriva** del estado y de la vista del pedido (`derivarFase`) y se valida al persistir. |
| `pendiente` | UNA pregunta estructurada: `elegir_opcion`, `modalidad`, `direccion`, `pago`, `fecha_hora`, `confirmar_resumen{huella}`, `aceptar_producto{producto_id}`, `aceptar_promocion{promocion_id, producto_id, cantidad}`, `aceptar_pago_ofrecido{forma_pago}`, `datos_evento`. Esquema Zod; `intentos` cuenta la misma pregunta sin avance. **Único escritor**: `fijarPendiente`. `foco` es solo su proyección. |
| `carrito` | renglones canónicos (`lid`, id, cantidad, modificadores, notas) y `datos` (modalidad, forma de pago, cliente, costo de envío validado, `programado_para` validado). |
| `hechos`, `folio` | confirmado/cancelado/escalado/fallido; folio real del registro. |
| `version`, `ultimoWamid`, `turnosAplicados` | versión = `conversacion_estado.revision`; los últimos 20 lotes aplicados. |
| `dialogo` | la respuesta que salió, con su pregunta pendiente y `enviado` (acuse). |
| `handoff` | la transferencia estructurada (§10). |
| `totalMostrado` | `{huella, total}` del resumen que llevó el total del motor (§6). |
| `fallosProveedor` | fallos seguidos del modelo; a la tercera, una persona. |

`sellarEstado` / `violacionesDelEstado` rechazan antes de escribir: esquema
inválido, fase que no corresponde, confirmado sin folio, confirmado y
cancelado a la vez, pregunta abierta en un terminal, resumen pendiente con otra
huella, opción pendiente de un renglón que no existe. Nada inválido llega a la
base.

### 4. Un solo circuito de mutación

Toda mutación, venga de donde venga, pasa por el mismo camino: esquema Zod →
tabla de legalidad → libro de operaciones → ejecutor → `reconciliar` →
relectura.

- **Respuestas cortas** (`respuestaCorta.js`): «sí», «no», «dos», «esa», «la
  segunda», «sin eso», «para recoger», «efectivo» se interpretan **contra el
  pendiente**, no contra el carrito ni la carta. Producen una acción del
  ejecutor con una `autorizacion` explícita (qué producto, qué cantidad, qué
  opción de qué renglón). Una pregunta del cliente («¿dos?») nunca es una
  respuesta. Confirmar exige `esConfirmacionVerbal` (estricta); aceptar una
  oferta admite cortesía («sí, me funciona») pero no cambios.
- **Acciones de sistema** (`ofrecer_promocion`): las decide Xabor, pasan por
  el mismo circuito y el modelo no las ve; un `tool_use` con ese nombre es
  «herramienta desconocida».
- **Evidencia**: dirección, referencias, nombre y notas de cocina se aceptan
  solo con respaldo textual del cliente; la zona de entrega solo si el cliente
  la nombró.
- **Lo que el modelo no puede**: inventar ids (se resuelven contra la carta
  publicada), cantidades (necesitan respaldo), promociones (solo las
  verificadas), precios, descuentos, disponibilidad, horarios (Xabor valida
  fecha/hora y AM/PM ambiguo), costo de envío (tarifas configuradas), estado
  de pago ni confirmación (huella + acuse + autorización).

### 5. El commit del turno, idempotencia y concurrencia

`src/mesero-agente/persistenciaDelTurno.js`.

- **Identidad del turno**: `turnoClave = sha(wamids ordenados)`. Un lote ya
  aplicado devuelve la respuesta comprometida y no ejecuta nada (reentrega de
  Meta, reinicio, segundo proceso).
- **Commit**: estado (con `WHERE revision = leída`), operaciones internas,
  respuesta en el outbox y traza, en UNA transacción. 0 filas en el UPDATE =
  otro proceso escribió: `ConflictoDeVersionError` y el turno se repite UNA
  vez sobre el estado fresco.
- **Efectos externos** (confirmar, pedir humano, menú, evento) se reservan en
  el libro ANTES de ejecutarse, en su propia transacción: no se pueden
  deshacer si el commit falla, y el libro impide repetirlos.
- **Entrega** (`src/mesero-agente/entregaDeRespuestas.js`, revisión 2): una
  sola función, `entregarRespuesta`, la usan el camino en línea del webhook y
  el despachador. Primero **reclama** la fila (`pendiente → enviando`, con
  dueño y hora); solo quien la reclamó llama a Meta. Después:
  - **Meta aceptó** (hay wamid): lo PRIMERO es escribir `entregado` +
    `wamid_salida`. El historial (`mensajes`) y el acuse del diálogo van
    después, cada uno aislado: si fallan, se anota `post_aceptacion: …` en
    `ultimo_error` y la fila sigue `entregado`. Si falla hasta esa escritura,
    la fila queda `enviando` y el barrido la pasa a `incierto`: **nunca**
    vuelve a `pendiente`.
  - **Meta rechazó con certeza** (`Meta API: …` con respuesta HTTP de error,
    fallo antes de conectar, o sin credenciales): `pendiente` con espera
    creciente hasta 3 intentos y luego `fallido` + persona
    (`AGENTE_RESPUESTA_NO_ENTREGADA`). El camino en línea no reintenta: marca
    `fallido` y pide la persona en el acto.
  - **Resultado incierto** (timeout, conexión cortada, 200 sin wamid, error
    desconocido): `incierto` + persona (`AGENTE_RESPUESTA_INCIERTA`). No se
    reenvía a ciegas.
  - El acuse del diálogo que no alcanzó a escribirse se **concilia al leer**
    el estado (`conciliarDialogoEntregado`): la verdad es la fila entregada.
  No se promete *exactly-once*: se promete **a lo más una vez por fila**
  después de que Meta devolvió un wamid, y revisión humana cuando no se sabe.
- **Una respuesta que no llegó pasa a una persona, una sola vez**
  (revisión 3). Rechazo agotado, respuesta vencida, resultado incierto o
  emisor muerto escriben `humano_motivo` + `humano_solicitado_at` en la MISMA
  sentencia que cambia el estado de la fila: no existe un instante en el que
  la respuesta esté fuera de circulación sin la marca. Después,
  `confirmarEntregaHumana` reclama la confirmación con un UPDATE condicional
  (`humano_reclamado_at`, arrendamiento de 60 s): dos procesos nunca la piden
  a la vez. `alHumano` (en producción `entregarRespuestaFallidaAPersona`:
  pausa durable + panel + WhatsApp al encargado, sin mensaje al cliente)
  devuelve `true` solo si la revisión quedó activa; entonces se escribe
  `humano_confirmado_at`. Si falla o el proceso muere, el reclamo se suelta o
  vence y el despachador lo retoma en su siguiente ciclo. Por conversación,
  `enviarARevision` bloquea la fila (`FOR UPDATE`): dos respuestas fallidas de
  la misma conversación dejan dos filas confirmadas y UN aviso al equipo.
  Observable en la fila (`humano_*`, `ultimo_error`), en el panel (motivo
  explicado) y en los logs (`ALERTA respuesta_no_entregada`,
  `respuesta_vencida`, `entrega_humana_confirmada`,
  `entrega_humana_sin_confirmar`).
- **Despachador** (job de 30 s en `server.js`): barre `enviando` más viejas
  que el arrendamiento (120 s) a `incierto` (con su marca de persona),
  confirma los pasos a persona pendientes, reclama en lote con
  `FOR UPDATE SKIP LOCKED` y entrega con la misma función. Antes de enviar
  descarta, en este orden: la respuesta superada por otra más nueva de la
  misma conversación y la de una conversación que ya atiende una persona
  (pausa manual o revisión durable; si eso no se puede leer, la fila vuelve a
  la cola en vez de enviarse) y la de un negocio con el bot APAGADO (el
  interruptor maestro: apagado, tampoco sale lo que quedó en cola), ninguna
  con persona nueva; y la vencida (15 min), que SÍ pasa a una persona. La
  deduplicación de entrada por wamid no cambia.

| Caída en… | Resultado |
|---|---|
| antes del commit | nada escrito (ni estado, ni operaciones internas, ni respuesta); la reentrega del lote se aplica una vez |
| entre commit y envío | si el proceso murió, la continuidad marca `EJECUCION_INTERRUMPIDA` al arrancar (revisión humana que no se suelta sola) y el despachador descarta la respuesta como atendida: una persona revisa la conversación; si el proceso siguió vivo (falló solo el envío en línea), el despachador la entrega una vez |
| Meta aceptó y falló una escritura local | la fila queda `entregado` con su wamid (o `enviando` → `incierto` + persona); cero reenvíos |
| timeout / resultado desconocido de Meta | `incierto` + revisión humana; cero reenvíos |
| Meta rechazó hasta agotar / la respuesta venció | `fallido` / `descartado` + persona, confirmada una vez |
| entre la marca de persona y su confirmación | la marca ya está en la fila; el despachador confirma después |
| después de registrar el pedido y antes de conocer su folio | conciliación por identidad (§6) |
| el proveedor de IA falla | se responde desde el estado, sin marcar `fallido`; a la tercera seguida, una persona |

### 6. La confirmación

1. El resumen canónico fija `pendiente = confirmar_resumen{huella}`.
2. Solo tras el **acuse** de Meta un «sí» puede confirmar (`autorizaConfirmacion`:
   diálogo enviado, tipo resumen, misma huella, mismo ciclo) **y solo si el
   cliente lo escribió DESPUÉS de ese acuse** (revisión 3). El acuse guarda su
   hora con el reloj de la base (`dialogo.acusadoAt`) y el canal fija la
   recepción más temprana del lote (`whatsapp_entradas.recibido_at`, mismo
   reloj). Un «ok» que el cliente mandó mientras el resumen se armaba no lo
   confirma: se le vuelve a mostrar el resumen, sin efectos y sin contar como
   repregunta. Lo mismo para aceptar un producto, una promoción o el pago
   ofrecidos.
3. **Total del motor**: si el turno termina en resumen, `previsualizarPedido`
   (el mismo pipeline que `registrarPedido`) calcula promociones y total; el
   resumen los muestra y `totalMostrado{huella,total}` queda en el estado. La
   confirmación compara el total canónico contra **lo que el cliente leyó**:
   si una promoción expiró entre el resumen y el «sí», no se registra y se
   vuelve a mostrar el total real.
4. `registrarPedido` → `validarOrdenPropuesta` con `catalogo_publicado:
   'whatsapp'` (la puerta final vuelve a exigir la carta publicada).
5. **Conciliación por identidad**: el pedido lleva
   `origen_agente.conversacion_id` (el ciclo). Si el INSERT hizo COMMIT y se
   perdió la respuesta, se adopta ese folio (uno solo, el que existe), se emite
   a la operación y el cliente recibe su folio real. Si no se encuentra, el
   camino «incierto» de siempre (persona) sigue en pie. Una confirmación por
   ciclo sigue garantizada por `uq_agente_confirmacion_conversacion`.

### 7. Catálogo publicado de WhatsApp

- Tabla `whatsapp_productos` (migración 098): sin fila = no publicado; retirar
  deja la fila en FALSE; FK compuesta `(negocio_id, producto_id)` →
  `menu_productos(negocio_id, id)`; `ON DELETE CASCADE`. Siembra **solo la
  primera vez** que nace la tabla, desde lo publicado en Tienda en línea
  (`origen = 'siembra_tienda'`).
- Gobierna a **todo bot de WhatsApp** (revisión 2): el Agente v1 y el bot
  legacy (`brain.js`/`prompts.js`), con sus simuladores. La regla vive en un
  solo lugar: `canalConCartaPublicada(canal)` (`whatsapp` y `simulador`) y
  `cartaDelCanal(negocioId, canal)` en `src/services/catalogoWhatsapp.js`.
- Se filtra **antes** de todo: prompt (agente y legacy), búsqueda,
  herramientas, verificación de negativas y términos del reconciliador del
  legacy, promociones (participantes, categorías y condiciones; también la
  consulta por fecha), menú de respaldo en texto, catálogo de la sombra,
  emisión segura (`nombresOcultos`) y, otra vez, la validación del borrador y
  la puerta final del registro (`validarOrdenPropuesta`, por la marca
  `catalogo_publicado` del agente **o** por el canal `whatsapp` del legacy).
  Una categoría sin publicados no existe (EXTRAS incluido). Un id adivinado no
  existe. Se filtra por ids y por negocio; ninguna lista escrita a mano.
- Si la publicación no se puede leer, la carta sale **vacía** (falla cerrado),
  nunca el menú completo: el prompt no nombra productos, el borrador y el
  registro se rechazan, no se anuncian promociones y el respaldo en texto cae
  al aviso genérico. Las promociones de WhatsApp **lanzan** en ese caso (antes
  devolvían `[]` y el cliente leía «no tenemos promociones»): cada llamador ya
  lo atrapa y lo trata como lo que es.
- **Sin carta, ningún bot contesta** (revisión 3). `estadoCartaWhatsapp`
  (la MISMA carta que verían los motores; vacía o ilegible = sin carta) se
  consulta en `procesarConClaude` justo antes de todo lo que habla de
  productos —el menú en imagen y, después de los atajos, el catering por el
  modelo, el agente y el legacy—, dentro o fuera del canario (una función,
  dos puntos de llamada, una sola lectura). Lo que no habla de productos
  sigue: facturación, las salidas deterministas de catering y los atajos del
  pedido que el cliente YA tiene (enlace de pago por folio, estado, puntos). Sin carta, la
  conversación pasa a una persona (`SIN_CARTA_WHATSAPP`: aviso al encargado,
  el cliente no recibe nada salvo el `bot_mensaje_revision` que el negocio
  haya configurado) y el turno termina; la revisión no se suelta sola, así
  que ni ese mensaje ni los siguientes llegan después al legacy. Defensa en
  profundidad: el agente sale con `sin_catalogo` antes de cualquier atajo, y
  `brain.js` devuelve `sinCartaWhatsapp` sin llamar al modelo. El simulador
  del panel (Entrenamiento, que usa el agente) le dice al dueño que falta la
  carta en vez de un «intenta de nuevo».
- No toca POS, Tienda ni inventario. **La voz queda fuera** (trabajo aparte,
  §14): `whatsapp_productos` es la carta de WhatsApp.
- `mencionaProductoDelMenu` (legacy) sigue mirando el menú operativo, pero
  solo como **disparador** de la validación: si el cliente nombra un producto
  oculto, se valida (contra la carta publicada) y se rechaza; nada de ese
  menú llega al modelo ni al cliente.
- Panel: página independiente `/catalogo-whatsapp` (`panel/catalogo-whatsapp.html`):
  ofrecer/retirar productos y categorías enteras, búsqueda, avisos de
  categoría oculta y agotado. Sin WebSocket ni impresión. Se llega desde
  **Menú › Productos para WhatsApp** (enlace visible solo para administrador
  con el módulo de WhatsApp; abre en otra pestaña para no cerrar el panel que
  imprime comandas). API: `GET /api/admin/whatsapp/productos`,
  `POST …/productos/publicar`, `POST …/categorias/publicar` —
  `requireSesionNegocio('admin')` + módulo WhatsApp: el negocio sale **solo**
  de la sesión firmada (ni cuerpo, ni query, ni cabeceras, ni el token
  estático legado con `x-negocio-slug`).
- Checklist de activación del bot: «productos» se mide sobre la carta
  publicada para WhatsApp.
- `release-gate.mjs` exige 098/099; para cada negocio con el agente, carta
  publicada no vacía; y para **todo** negocio activo con un bot encendido
  (agente o legacy), carta publicada no vacía. Desde la revisión 3 un legacy
  sin un solo producto en su menú también bloquea (antes era aviso): con la
  guarda de runtime no le contestaría a nadie, y eso lo decide el dueño antes
  de liberar (publicar o apagar ese bot).

### 8. Promociones

- La consulta la contesta Xabor con sus datos (nunca el modelo), acotada a la
  carta publicada.
- `ofrecer_promocion` solo deja una oferta aceptable si la promoción está en
  la consulta verificada del turno, **vigente ahora** (una de mañana se
  informa, no se ofrece), con **un** participante publicado. La cantidad sale
  del **tipo**: 2x1/segundo = `cantidad_requerida` (2 por omisión); porcentaje
  o monto = 1; envío gratis no se acepta agregando producto.
- Aceptar («sí» o el número exacto) agrega por el mismo ejecutor; después se
  piden opciones, entrega y pago como cualquier renglón. El descuento lo
  calcula el motor y se ve en el resumen (§6).

### 9. Emisión segura

`src/mesero-agente/emisionSegura.js`. La prosa del modelo solo se publica
cuando no hay pedido en curso (saludos, consultas, varios candidatos). Se
descarta y se sustituye por texto construido con datos verificados si trae:
protocolo interno (JSON, nombres de herramientas, marcadores, truncado), un
producto no publicado, un precio que no está en la carta/pedido/tarifas, o una
afirmación de pedido registrado/folio sin confirmación. En una captura de
evento el canal la sustituye por la siguiente pregunta de captura (sin
escalar).

### 10. Transferencia a una persona, estructurada

`estado.handoff = { motivo, en, fase_previa, pedido{lineas, modalidad,
forma_pago, programado_para, total, con_direccion, nombre}, evento,
pendiente_previo }`, y un evento `handoff` en el outbox dentro del mismo
commit. Pasan a una persona: catering con la ficha completa (nombre, personas,
lugar, fecha y hora; sin cotizar), la misma pregunta tres veces sin avance,
tres fallos seguidos del proveedor, un pedido de persona del cliente, una
respuesta prohibida por el negocio y los estados inciertos.

### 11. Observabilidad

Una fila por turno en `agente_turnos` (migración 099), en la misma
transacción que el estado: wamids, fase y versión antes/después, pendiente
antes/después, acciones propuestas y autorizadas (argumentos redactados),
rechazos con motivo, folio, claves del outbox, motivo de handoff, cierre,
recuperación, latencias y errores del proveedor. El texto del cliente no se
copia (se cruza por wamid con `mensajes`).

### 12. Caminos paralelos: qué quedó unificado y qué no

| Camino | Estado |
|---|---|
| Agente productivo | todo lo anterior |
| Sombra del agente | mismo bucle, carta publicada, commit versionado en su propio espacio (`agente-sombra:`), sin outbox |
| Simulador del panel | mismo bucle y carta publicada, acuse; estado y libro **en memoria**, sin el atajo de consulta de promociones ni el total del motor en el resumen |
| Replay | acuse del transporte; estado en memoria |
| Bot legacy (`brain.js`) | carta publicada en prompt, promociones, negativas, reconciliador, borrador, preview y registro (revisión 2) |
| Menú de respaldo en texto | carta publicada (solo lo recibe un cliente de WhatsApp) |
| Voz (`voice.js`) | menú operativo, sin cambios: fuera de alcance, trabajo aparte (§14) |

### 13. Migraciones y reversión

| Migración | Qué hace | Reversión |
|---|---|---|
| `098_catalogo_whatsapp.sql` | tabla `whatsapp_productos`, índice, trigger `updated_at`, siembra única desde Tienda | `098_catalogo_whatsapp_down.sql` (`DROP TABLE`): se pierde la selección del panel; el código anterior no la lee |
| `099_agente_turnos.sql` | tabla `agente_turnos`; `agente_outbox.conversacion_id`, `turno_clave`, `wamid_salida`, `reclamado_at`, `reclamado_por`; estados `enviando` e `incierto` en el CHECK; `humano_motivo`, `humano_solicitado_at`, `humano_reclamado_at`, `humano_confirmado_at` (revisión 3) e índice de pasos a persona por confirmar; índices de respuestas pendientes, de reclamos y por diálogo | `099_agente_turnos_down.sql`: `enviando`/`incierto` pasan a `fallido` (nunca a `pendiente`: no se reenvían) y se restaura el CHECK anterior; se pierde la traza y la marca de persona (el archivo trae la consulta para revisar antes los pasos a persona sin confirmar); nada de pedidos ni conversaciones |

Ambas aditivas e idempotentes, con su `predeploy-09N-*.mjs` en el runner
(ensayadas dos veces seguidas y con su `_down` + re-aplicación sobre una base
local con el esquema de `41c003b`). El código anterior no lee ninguno de los
objetos nuevos (tablas nuevas y columnas nulas): para revertir el código basta
redeplegar el commit anterior y las migraciones pueden quedarse (ver §16 para
la corrida de suites de `41c003b` sobre el esquema nuevo).

### 14. Decisiones de producto que tiene que confirmar el dueño

1. **Siembra inicial** del catálogo de WhatsApp desde lo publicado en Tienda.
   Un negocio con el agente encendido y sin Tienda queda con carta vacía: el
   agente pasa cada conversación a una persona y el release gate **bloquea el
   despliegue** hasta que se publique algo o se apague el agente de ese
   negocio.
2. **Bot legacy filtrado** (revisión 2, pedido por la revisión): desde este
   release el legacy vende solo la carta publicada. Cambia la carta en vivo
   de cada negocio legacy al desplegar; por eso el gate detiene la liberación
   mientras un bot legacy que vende no tenga carta, y la transición está
   escrita abajo («Transición de los negocios con bot legacy»).
3. **Productos nuevos nacen sin publicar** para WhatsApp.
4. **Catering**: se captura un dato por respuesta (varios juntos se
   repreguntan) y se entrega a una persona; nunca se cotiza.
5. **Conciliación por identidad** en vez de congelar la conversación cuando se
   pierde la respuesta del registro.
6. **Checklist de activación**: «productos» ahora es «carta de WhatsApp
   publicada» (incorporado con la decisión 2; etiqueta de Superadmin ajustada).
7. **Panel**: la pantalla sigue independiente; el enlace desde Menú se agregó
   como cambio mínimo y aislado en `panel/index.html` (componente protegido):
   un bloque HTML estático, sin JavaScript, con las compuertas que ya existen.
8. **Voz — resuelto por el dueño (26-sep): fuera de alcance.** Hoy no se
   atiende por voz con IA; si se enciende, será un trabajo aparte decidir si
   comparte la carta de WhatsApp o tiene la suya.
9. **Texto fijo del prompt legacy**: el prompt de `prompts.js` trae párrafos
   escritos para Nonna Maye (Focaccia Bar, combos, sorteo, rentas, vacantes)
   que llegan a TODO negocio legacy. No salen del catálogo, así que la carta
   publicada no los gobierna (la validación final sí rechaza esos productos
   donde no estén publicados). Moverlos a configuración por negocio es otra
   tarea. Con la guarda de la revisión 3, un negocio SIN carta ya no llega a
   ese prompt.
10. **Sin carta, ningún bot contesta** (revisión 3, bloqueo C): la
    conversación pasa a una persona y el cliente no recibe nada del bot (la
    decisión de silencio del 11-sep sigue: solo sale `bot_mensaje_revision`
    si el negocio lo escribió). Siguen funcionando, sin carta, facturación,
    las salidas deterministas de catering y los atajos del pedido que el
    cliente ya tiene (enlace de pago por folio, estado, puntos). El gate
    bloquea todo bot encendido sin carta, aunque no tenga productos (antes
    era aviso).
11. **El bot que se entrega es el agente nuevo para todos** (26-sep): Acuña
    pasa a él después de preparar su carta y de un canario. El primer canario
    es SOLO para los teléfonos del dueño (§17).

### 15. Riesgos abiertos

- **Carta vacía al desplegar** (decisiones 1, 2 y 10): cualquier negocio
  activo con un bot encendido (agente o legacy, con o sin productos) que no
  tenga productos publicados queda sin carta de WhatsApp. El gate detiene la
  liberación (el binario anterior sigue vendiendo), pero hay que prepararlo
  antes: ver la transición. **Desplegar el canario también cambia al legacy**:
  todo negocio con bot legacy pasa a vender solo su carta publicada.
- **Sin carta después del despliegue** (el dueño retira todo, o la lectura
  falla): la conversación pasa a una persona y el bot calla hasta que alguien
  la devuelva. Si nadie atiende el panel, el cliente espera; el encargado sí
  recibe el aviso por WhatsApp.
- **La imagen del menú la sube el dueño**: el bot la manda tal cual. Si la
  imagen muestra productos que no están en la carta publicada, el cliente los
  ve aunque el bot no pueda venderlos (la validación final los rechaza).
- **Una falla al leer la configuración** hace que `modoDelPedido` trate el
  turno como legacy (comportamiento anterior a esta rama): un teléfono del
  canario sería atendido ese turno por el bot legacy del negocio, con su carta
  publicada.
- **Respuesta incierta = persona**: un timeout de Meta ya no se reintenta;
  la conversación pasa a revisión. Si Meta sí la entregó, el cliente la tiene;
  si no, una persona le contesta. Se prefirió eso a un posible duplicado.
- **No probado con modelo ni Meta reales**: todo es con mocks (modelo de
  guion, Meta simulado). Falta una conversación de prueba real antes de
  exponerlo a clientes.
- **Simulador y sombra** no tienen el atajo de consulta de promociones ni el
  total del motor en el resumen: pueden diferir del canal en esos dos puntos.
- **Texto fijo del prompt legacy** (decisión 9) queda fuera de la carta
  publicada. La voz no se atiende hoy con IA (decisión 8).
- **Presupuesto de 6 vueltas** del modelo: un mensaje con muchos productos
  puede agotarlo; se responde con lo que quedó guardado y se pregunta si falta
  algo (seguro, pero con fricción).
- **Despachador**: solo reenvía respuestas de menos de 15 minutos; una más
  vieja se descarta y la conversación pasa a una persona (revisión 3).
- **Un paso a persona que no se puede confirmar** (la base de revisiones cae
  por mucho tiempo) se reintenta cada 30 s indefinidamente, con una línea
  `ALERTA entrega_humana_sin_confirmar` por intento.
- **Reintento por conflicto de versión**: los avisos a una persona que hace el
  adaptador (no los del libro) podrían duplicarse en el reintento; no afecta
  al cliente.
- **`agente_turnos` crece una fila por turno** sin política de retención.
- **Catering estricto**: un dato por respuesta; varios juntos se repreguntan.
- **Latencia**: un `previsualizarPedido` adicional en cada turno que termina
  en resumen.
- Fuera de alcance, detectado de paso: `POST /chat` no exige sesión (se dejó
  una tarea aparte).
- Fuera de alcance, detectado de paso: el agente no usa la caché de
  instrucciones del proveedor (`cache_control`): cada llamada paga completas
  las instrucciones y las herramientas, y un turno hace varias llamadas.
  Mejora de costo y latencia, a medir aparte.
- `src/mesero-agente/libroDeOperaciones.js` trae un byte NUL literal (ya
  estaba en `41c003b`): git lo trata como binario y `git diff` no muestra su
  cambio; revisarlo con `git diff --text`.

### 16. Pruebas

Todo contra Postgres **local y desechable** (una base nueva por suite, creada
desde una plantilla con el esquema de `41c003b`, + 098/099 para la rama),
modelo de guion o mock HTTP de Anthropic y mock de Meta. Nada real.

Suites nuevas:

| Suite | Qué cubre | Resultado |
|---|---|---|
| `test/fase-pedido-canonico.mjs` (pura) | fase, pendiente (esquema, único escritor, intentos), filas viejas, invariantes antes de persistir, respuestas cortas, emisión segura, sellado, total del motor, identidad del turno, carta publicada, acciones de sistema, ambigüedad → persona | 18/18 |
| `test/fase-pedido-canonico-db.mjs` | los 28 escenarios pedidos, por el adaptador real con `registrarPedido` real y aserciones en `conversacion_estado`, `pedidos_activos`/`pedidos_programados`, `agente_outbox`, `agente_turnos`, `agente_operaciones`; y el caso 01b: el «sí» a «¿Lo confirmo?» ya no duplica el producto (bug de producción desde b969959) | 30/30 |
| `test/fase-catalogo-whatsapp-db.mjs` | tabla, servicio y rutas del catálogo: nace sin publicar, rol y módulo, aislamiento, categoría, fallo cerrado, re-ejecución de la 098, cascada | 10/10 |
| `test/fase-outbox-entrega-db.mjs` (revisión 2) | Meta aceptó + historial falló → cero reenvíos (despachador y en línea); falla hasta el acuse → `incierto`; dos despachadores concurrentes; en línea vs despachador en los dos órdenes; rechazo confirmado con reintentos acotados; ECONNREFUSED/sin credenciales = rechazo; timeout/reset/200 sin wamid = `incierto` sin reenvío; barrido de `enviando`; descartes; conciliación del diálogo; clasificación | 12/12 |
| `test/fase-carta-publicada-legacy-db.mjs` (revisión 2) | bot legacy: publicado usable (prompt, preview, registro); oculto fuera del prompt de WhatsApp y del simulador; promociones (prompt y consulta por fecha); petición explícita de un oculto por nombre, id y `[P…]` rechazada en borrador/preview/registro; EXTRAS oculto entero; otro negocio; lectura caída → cerrado; turno real de `brain.js` con el prompt capturado del mock; candado de negativas; misma selección y mismo efecto al retirar en Agente v1 y legacy; POS, tienda y voz sin cambios | 12/12 |
| `test/fase-catalogo-whatsapp-panel.mjs` (revisión 2) | servidor y sesiones REALES: página, admin lista y publica, staff 403, sin sesión 401, negocio solo de la sesión (cuerpo, query, cabeceras y token legado con control positivo), admin de B contra A, sin módulo 403; Puppeteer: Menú → enlace → pantalla con los productos del negocio; staff y negocio sin módulo no ven el enlace | 10/10 |
| `test/fase-release-gate-carta-db.mjs` (revisión 2) | el `release-gate.mjs` real como proceso sobre una copia desechable: agente sin carta → exit 1; publica → exit 0; legacy sin productos → aviso; legacy que vende sin carta → exit 1; categoría inactiva y agotado no cuentan; negocio inactivo no bloquea | 9/9 |

Pruebas de mordida (cada garantía desactivada por separado; la suite tiene que
fallar donde debe; archivos restaurados y verificados por hash): ver el informe
de la entrega para la cuenta final.

**Revisión 2 — suites existentes con fixtures actualizados.** Con la carta
publicada gobernando también al legacy, toda suite que arma un negocio que
vende por WhatsApp (prompt legacy, borrador, preview, registro por canal
`whatsapp`, promociones del bot, menú de respaldo, sombra) tiene que publicar
sus productos, igual que el dueño en el panel. El cambio en cada una es solo
esa publicación (`test/lib-carta-whatsapp.mjs`, por el mismo servicio que usa
el panel); ninguna aserción se tocó. Antes del cambio fallaban con
`MENU_VACIO`/`PRODUCTO_NO_EXISTE` o con el producto ausente del prompt:
`fase-bot-forma-pago`, `fase-bot-pedido-tras-pago`, `fase-chilaquiles-contexto`,
`fase-confirmacion-agrupada`, `fase-confirmacion-determinista`,
`fase-confirmacion-ux`, `fase-continuidad-webhook`, `fase-descuentos-normalizados`
(su caso `[MESERO] C`), `fase-e2e-licuado`, `fase-fidelidad-borrador`,
`fase-fidelidad-catalogo-notas`, `fase-flujo-real`, `fase-folio-concurrencia`,
`fase-fotos-producto`, `fase-grupos-requeridos`, `fase-menu-metadata-tecnica`,
`fase-menu-multiimagen`, `fase-mesero-deploy-multiempresa`,
`fase-mesero-sombra-canal`, `fase-modificadores-grupo-identidad`,
`fase-modificadores-llm`, `fase-negaciones-injustas`, `fase-pedido-determinista`,
`fase-pedido-fuente-de-verdad`, `fase-preconfirmacion-pricing`,
`fase-promo-condiciones-modificadores`, `fase-promo-consulta-fecha`,
`fase-promo-guiado-preview`, `fase-promo-informativa`, `fase-promo-prompt-e2e`,
`fase-promociones`, `fase-seguridad-transaccional`,
`fase-validacion-conversacional-catalogo`, `fase3a-registro-usos-promociones`.
Además: `fase-checklist-activacion-bot`
ahora exige «sin publicar = no listo» y después publica; `fase-cutover-059`
publica la carta de los bots de su copia local antes del runner (la regla de la
carta tiene su suite; ahí sería ruido, igual que la 063 que ya neutraliza);
`fase-catalogo-whatsapp-db` simula `requireSesionNegocio` en lugar de
`requireAuthSeguro`.

**Revisión 2 — regresión, scripts y mordidas** (código final, cada suite en
su base desechable, modelo y Meta simulados):

- 182 suites (las 137 comparadas en la revisión 1 + las que tocan el bot
  legacy, la validación por canal WhatsApp, promociones, menú de respaldo,
  checklist, panel y continuidad + las nuevas): 164 con exit 0. Las 18
  restantes: 15 fallan IGUAL en `41c003b` (`fase-agente-conversacion-real` y
  `fase-agente-piloto-integral-real` exigen proveedor real;
  `fase-compras-whatsapp` y `fase-ingredientes-incluidos` buscan otra base en
  el puerto 55454; `fase-vision-whatsapp` 36/37; `fase-agente-programados-db`;
  `fase-borrador-admin-whatsapp` 11/13; `fase-asistente-comercial-5-e2e` 1/8;
  `fase-hotfix-borrador-recuperable` 4/8; `fase-enrutamiento-repartidor-cliente`
  5/13; `fase-crm-clientes` 13/14; `fase-panel-comercial` (correo duplicado en
  la plantilla); `fase-tienda-recuperacion-crash` K5 (busca una forma vieja de
  `agregarPedido`); `fase-cutover-059` caso 7; `fase-descuentos-normalizados`
  `[COBRO] A` (claves de autofactura)); `fase-integracion-mesero-rewards` se
  niega a correr sin `MESERO_SHADOW_MODE=true` (con la llave: 13/13);
  `fase-flujo-real` pasó 6/6 y cayó en una aserción de libuv al salir, y
  `fase-emision-operacional-crash-real` dio el código de muerte de Windows
  (0xC0000409): aisladas, 6/6 y 12/12 con exit 0 (en `41c003b`, aislada,
  6 fallos por ese mismo código).
- Permisos y multiempresa: `fase-permisos-operador` 11/11,
  `fase-canje-permisos` 4/4, `fase-cotizaciones-multiempresa-telefono` 13/13,
  `fase-p0-aislamiento-pedidos` 29/29, `fase-mesero-multiempresa` 22/22,
  `fase-multiempresa-modo-pedido` 19/19, `fase-mesero-deploy-multiempresa`
  10/10; `fase3a-registro-usos-promociones` 18/18; `mordidas-mesero-handoff`
  exit 0 con el árbol de trabajo idéntico antes y después.
- `npm run test:incident` exit 0 · `npm run mesero:tools` 66/66 ·
  `npm run mesero:replay` 26/26 · `npm run test:pedido-canonico` (18, 29, 10,
  12 y 12, sin fallos; con el caso 01b posterior la suite de base da 30/30) · `npm run test:carta-whatsapp-liberacion` (10 y 9).
- Mordidas: 72/72 (con la del caso 01b, que reintroduce el doble producto).
  Revisión 1 + outbox 46/46 (el CM1 del catálogo ahora
  desactiva las DOS capas contra el staff); revisión 2 25/25 (legacy 10,
  checklist 1, panel y API 8, gate 6).

**Revisión 2 — predeploy completo en una Postgres NUEVA** (contenedor
`pg-canonico-limpio`, 18.4 con SSL, base vacía): receta de CLAUDE.md
(`aplicar-migraciones` → predeploys 051–064, 065/066 por `psql`, 067/068 →
81 tablas; 087 → 85) y fixture ANTES de la 098; después
`scripts/predeploy-run-032-033.mjs` completo: **exit 0**, 112 tablas, 058 y 063
incluidas (y re-verificadas por el runner). La 098 sembró exactamente lo
publicado en Tienda (3 de 3; ni internos, ni EXTRAS, ni la fila de Tienda no
publicada). Con un negocio con el agente encendido y la carta vacía: gate y
runner completo **exit 1** («se conserva el deployment anterior»); publicado un
producto por el servicio del panel: **exit 0**. Legacy que vende y se queda sin
carta: gate **exit 1**; al republicar, **exit 0**. Nonna Maye (creada por las
migraciones con el bot encendido y sin un solo producto) sale como `AVISO`.

Comparación rama vs. `41c003b` (mismas suites, cada una en su base
desechable): 138 suites — 98 puras y de base de datos + 40 de servidor.
**Ninguna pasa en la base y falla en la rama.**

- Fallan igual en los dos lados (preexistentes o de entorno):
  `fase-agente-conversacion-real` y `fase-agente-piloto-integral-real` (exigen
  proveedor real), `fase-compras-whatsapp` (busca otra base en el puerto
  55454), `fase-vision-whatsapp` C1 (36/37), 2 casos de
  `fase-agente-programados-db` (10/12), 2 de `fase-borrador-admin-whatsapp`
  (11/13) y `fase3a-registro-usos-promociones` (se niega a correr si la base no
  se llama `test_*`; con ese nombre: base 18/18, rama 16/18 bajo carga de tres
  corridas en paralelo por timeouts de conexión y 18/18 en las dos
  repeticiones).
- Fallan en la base y pasan en la rama: `replay-mesero` (23/26 → 26/26),
  `fase-respuesta-truncada` (2 casos con precondiciones rotas de la propia
  prueba → 23/23) y `fase-emision-operacional-crash-real` (intermitente en la
  base: proceso que no muere limpio en Windows).
- `fase-cutover-063-emision-operacional`: 11/11 en los dos lados; en el
  worktree de la rama solo pasa con un `node_modules` completo (la suite enlaza
  el primero que encuentra y el del worktree solo tenía `qrcode`).

Pruebas actualizadas por un cambio de contrato deliberado (no por ocultar
fallos): `fase-agente-recorrido-operacional` R8–R12 (conciliación por
identidad, §6), y los fixtures que arman un negocio para el agente ahora
publican su carta (§7).

Reversión: 10 suites de `41c003b` corridas sobre el esquema con 098/099 —
todas iguales que en su propio esquema.

Predeploy (revisión 1, sobre la base local ACUMULADA de pruebas): el runner
completo no pasaba ahí (058 y 063 abortan por datos que dejaron otras suites,
idéntico en `41c003b`); 098/099 se revierten con sus `_down` y se vuelven a
aplicar. En la revisión 2 se corrió desde cero sobre una Postgres nueva (arriba):
exit 0.

**Revisión 3 (candidato canario)**, sobre un contenedor Postgres 18.4 NUEVO
(SSL, sin reutilizar ninguna base anterior): receta de CLAUDE.md + fixture
previo a la 098 + runner completo del Pre-Deploy. La primera corrida sale con
exit 1 SOLO por Nonna Maye (bot legacy encendido por la 019, sin menú ni
carta): es la detección correcta de la regla nueva. Aplicada su transición
(«c»: apagar ese bot), el runner completo da exit 0 dos veces seguidas (112
tablas; 098 sembró 3 productos desde Tienda; gate financiero OK; barrera de
datos «12 comprobaciones correctas, 0 fallos»). Cada suite corre después en
su propia copia nueva de una plantilla sembrada (`test_*`).

Pruebas nuevas o ampliadas en la revisión 3:
- `fase-outbox-entrega-db` 12 → 20: rechazo agotado (despachador y en línea),
  vencida, superada/atendida sin persona, confirmación que falla y se
  completa en el siguiente barrido, reclamo de un proceso muerto, dos
  despachadores a la vez (una persona por fila) y la revisión atómica por
  conversación (6 pedidos simultáneos → 1 marca y 1 aviso).
- `fase-carta-publicada-legacy-db` L11a-e: catálogo operativo lleno y cero
  publicados (estado de la carta, legacy sin modelo ni texto, simulador,
  agente antes de cualquier atajo y sin estado ni outbox, vuelta a atender al
  publicar).
- `fase-sin-carta-canal-db` (nueva): por el webhook real con servidor hijo,
  canario y legacy sin carta → revisión `SIN_CARTA_WHATSAPP`, cero mensajes al
  cliente, cero llamadas al modelo, un aviso al equipo por conversación; los
  mensajes siguientes quedan sin procesar; con un producto publicado vuelve a
  atender.
- `fase-catalogo-whatsapp-panel` P8c espera el fin de la carga de permisos
  (no «hay algún módulo») con controles positivos; P8d, negocio sin ningún
  módulo; los módulos de A se fotografían y se restauran completos.
- `fase-release-gate-carta-db` G2b/G2c: legacy sin productos ni carta bloquea;
  al apagar su bot pasa.
- `fase-bot-calla-y-avisa` 6, 13e y S3: la lista cerrada de motivos crece a
  propósito con `SIN_CARTA_WHATSAPP`; el conteo de fallos tipados de catering
  deja aparte la guarda de carta; el panel explica los cuatro motivos nuevos.
- `fase-agente-programados-db` («caller real»): la prueba confirmaba en el
  mismo turno que armaba el resumen, contrato anterior a 9754928 (fallaba
  igual en `41c003b`, con «promo desfasada» en cascada). Ahora sigue el real:
  resumen, acuse del transporte simulado explícito, «sí» en el turno
  siguiente. Mismo propósito; 12/12.
- `fase-cutover-059`: en su copia, los bots sin productos se apagan como su
  transición (antes solo se publicaba la carta de los que tenían).

Precondición de entorno documentada: la siembra nueva da al negocio A solo
el módulo `whatsapp`; `fase-programado-crash-real` y
`fase-programado-memoria-panel` necesitan los módulos operativos (en la base
acumulada anterior A tenía 15). Corren sobre la misma plantilla + los 15
módulos operativos de un restaurante para A y B (`test_mod_tpl`); el barrido
amplio también.

### 17. Despliegue y canario SOLO para los teléfonos del dueño (runbook, NO ejecutado)

Nada de esto lo ejecuta el agente sin la autorización explícita del dueño en
esa conversación. Cada paso dice qué se lee y qué se cambia.

**0. Antes de tocar nada**
1. Revisión del diff (Codex) y de este documento; decisiones del §14.
2. Confirmar que producción sigue en `41c003b` (lectura en Railway: el último
   deployment `SUCCESS` del servicio `xabor-agent` con `commitHash`
   `41c003b…`) y que el commit candidato desciende de él
   (`git merge-base --is-ancestor 41c003b <candidato>`). Si alguien desplegó
   otra cosa, integrarla primero: con `railway up` desde otros worktrees, el
   último que sube gana.
3. Confirmar en Railway que la variable del PROCESO `MESERO_AGENTE_MODE` vale
   `true` (sin ella el agente no atiende a nadie: falla cerrado). No hace
   falta `MESERO_AGENTE_SHADOW`.

**1. Vista previa de la carta en producción (solo lectura)** — la consulta
del §18. Toda fila que salga ahí con carta vacía **detiene la liberación**:
decidir por negocio (publicar en Tienda antes, publicar por SQL tras el
primer intento, o apagar su bot). Recordatorio: desplegar el canario también
cambia al bot LEGACY de todos los negocios (vende solo su carta publicada).

**2. Desplegar el código (sin encender nada)**
1. Empujar el commit candidato a `prod/mesero-shadow-v3` (avance rápido
   desde `41c003b`). Desde el 24-sep el push no dispara el build: desde
   `C:\xabor-agent`, `railway redeploy --yes --from-source`.
2. Verificar el deployment: `SUCCESS` con `commitHash` del candidato. En el
   log del Pre-Deploy: `[predeploy-099] …verificadas`, `OK  todo negocio con
   un bot de WhatsApp encendido tiene carta publicada para WhatsApp` y
   `[predeploy-run] Todos los pasos completados.` Si el gate falla, Railway
   conserva el deployment anterior: resolver la carta (§18) y redeplegar.
3. Huella del código nuevo: `https://xabor.mx/app` contiene
   `btn-carta-whatsapp`; `/catalogo-whatsapp` responde.

**3. Preparar el negocio del canario** (el negocio `<N>` cuyo número de
WhatsApp va a escribir el dueño). Leer y GUARDAR primero los valores actuales:
```sql
SELECT n.bot_whatsapp_activo, c.clave, c.valor
  FROM negocios n LEFT JOIN configuracion c
    ON c.negocio_id = n.id AND c.clave IN ('mesero_agente_v1','mesero_agente_telefonos',
       'mesero_agente_porcentaje','mesero_agente_shadow','bot_whatsapp_solo_prueba')
 WHERE n.id = '<N>';
```
Y comprobar su carta en **Menú › Productos para WhatsApp**: lo que se
ofrece es exactamente lo que el bot podrá vender (nada interno, nada de
EXTRAS sueltos, nada que no se quiera por WhatsApp).

**4. Encender el canario** (sin redeploy; vale desde el siguiente mensaje):
```sql
INSERT INTO configuracion (negocio_id, clave, valor) VALUES
  ('<N>', 'mesero_agente_telefonos', '528787899919,5218787899919'),
  ('<N>', 'mesero_agente_porcentaje', '0'),
  ('<N>', 'mesero_agente_shadow', 'false'),
  ('<N>', 'bot_whatsapp_solo_prueba', 'true'),
  ('<N>', 'mesero_agente_v1', 'true')
ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor;
UPDATE negocios SET bot_whatsapp_activo = TRUE WHERE id = '<N>';
```
- La lista lleva LAS DOS formas del número: `enElCanario` compara los
  dígitos exactos y Meta puede entregar el número con o sin el `1` de móvil
  (`bot_whatsapp_solo_prueba` sí normaliza ambas).
- `porcentaje = 0` y lista explícita: la lista manda; nadie más entra al
  agente.
- `bot_whatsapp_solo_prueba = true`: **ningún bot** (ni el legacy) contesta a
  un número fuera de la lista; esas conversaciones quedan en atención manual,
  como hoy si el bot del negocio está apagado. Si ese negocio hoy atiende a
  sus clientes con el bot legacy, este paso los pasa a atención manual
  mientras dure el canario: elegir un negocio donde eso sea aceptable.
- `bot_whatsapp_activo` es el interruptor maestro que ve el panel.

**5. Apagado inmediato** (sin redeploy, desde el siguiente mensaje):
- Total: en el panel, **apagar el bot del negocio**
  (`UPDATE negocios SET bot_whatsapp_activo = FALSE WHERE id = '<N>'`).
- Solo el agente: `mesero_agente_v1 = 'false'` (con `bot_whatsapp_solo_prueba
  = 'true'`, los teléfonos del dueño pasarían al legacy de ese negocio; para
  que nadie reciba bot, usar el apagado total).
- Una conversación: tomarla en el panel (queda pausada).
- Volver al estado anterior: restaurar los valores guardados en el paso 3.
- Código: rollback en Railway al deployment anterior (`41c003b`). 098/099
  pueden quedarse: el código anterior no las lee (sus `_down` existen).

**6. Observar cada conversación de prueba** (lectura):
`whatsapp_conversaciones` (¿`requiere_revision`? ¿`motivo`?), `agente_turnos`
(fase, pendiente, acciones, rechazos, folio, handoff por turno),
`agente_outbox` (una respuesta por turno, `entregado` con `wamid_salida`;
`humano_*` si alguna no llegó), `pedidos_activos` / `pedidos_programados`
(un solo folio por pedido confirmado) y los logs `[AGENTE]`,
`[AGENTE-OUTBOX]`, `[Meta WA] ALERTA sin_carta_whatsapp`.

### 18. Transición de los negocios con bot legacy

Desde la revisión 2, el bot legacy de un negocio (Acuña es el caso conocido)
vende **solo** lo publicado en `whatsapp_productos`. La 098 siembra, la
**primera** vez que crea la tabla, lo que cada negocio ya publicó en su Tienda
en línea; lo demás nace sin publicar. Un negocio que vende por WhatsApp y no
tiene Tienda publicada se quedaría sin carta, y el gate lo detiene.

Pasos (los decide y ejecuta el dueño; nada de esto lo corre el agente):

1. **Vista previa, solo lectura** (con `DATABASE_PUBLIC_URL`, antes de
   desplegar). Qué negocios tienen un bot que vende y qué les sembraría la 098:
   ```sql
   SELECT n.nombre, n.id,
          n.bot_whatsapp_activo AS legacy,
          EXISTS (SELECT 1 FROM configuracion c WHERE c.negocio_id = n.id
                   AND c.clave = 'mesero_agente_v1' AND lower(trim(c.valor)) = 'true') AS agente,
          (SELECT count(*) FROM menu_productos p JOIN menu_categorias k
             ON k.id = p.categoria_id AND k.negocio_id = p.negocio_id
           WHERE p.negocio_id = n.id AND k.activa AND p.disponible IS NOT FALSE
             AND p.agotado IS NOT TRUE) AS productos_en_menu,
          (SELECT count(*) FROM tienda_productos t
            WHERE t.negocio_id = n.id AND t.publicado) AS sembrables_desde_tienda
     FROM negocios n
    WHERE n.activo IS NOT FALSE
      AND (n.bot_whatsapp_activo OR EXISTS (SELECT 1 FROM configuracion c
            WHERE c.negocio_id = n.id AND c.clave = 'mesero_agente_v1'
              AND lower(trim(c.valor)) = 'true'))
    ORDER BY n.nombre;
   ```
   Bloquearía la liberación toda fila que tenga `sembrables_desde_tienda = 0`
   (desde la revisión 3 también con `productos_en_menu = 0`: sin carta, ese
   bot ya no le contestaría a nadie). En una base nueva, Nonna Maye sale así
   (la 019 le enciende el bot y no trae menú): el gate la detiene y su
   transición es la «c».
2. **Elegir la carta** de cada uno de esos negocios. Tres caminos:
   - a) Publicar en su Tienda en línea lo que también se puede vender por
     WhatsApp **antes** del primer despliegue: la 098 lo siembra sola. Ojo:
     eso también lo muestra en la tienda.
   - b) Desplegar, dejar que el gate se detenga (el binario anterior sigue
     vendiendo; la tabla ya existe), y publicar con SQL los ids que el dueño
     elija — ids explícitos de ESE negocio, nunca por nombre ni «todo»:
     ```sql
     INSERT INTO whatsapp_productos (negocio_id, producto_id, publicado, origen)
     SELECT p.negocio_id, p.id, TRUE, 'panel'
       FROM menu_productos p
      WHERE p.negocio_id = '<negocio>' AND p.id = ANY('{<id>,<id>}'::int[])
     ON CONFLICT (negocio_id, producto_id) DO UPDATE SET publicado = TRUE, updated_at = NOW();
     ```
     y volver a desplegar.
   - c) Si ese negocio no debe vender por WhatsApp con bot, apagar su bot
     antes (pasa a atención humana).
3. Desplegar. El gate imprime `OK  todo negocio con un bot de WhatsApp
   encendido tiene carta publicada para WhatsApp`; si falta alguna, `FALLO`
   con el negocio y si además no tiene productos.
4. Revisar la carta en **Menú › Productos para WhatsApp** y hacer una
   conversación de prueba por el bot legacy de Acuña.

Qué deja de hacer el bot legacy de un negocio con carta publicada: nombrar,
recomendar, cotizar, promocionar o registrar un producto no publicado. Si el
cliente lo pide, se le dice que no se maneja (y se le ofrece lo publicado). El
POS, la tienda en línea y la voz no cambian.

### 19. Evaluación con la IA real: herramienta aparte, fuera de este commit

La medición con la IA real sobre conversaciones inventadas (decidida por el
dueño el 26-sep) se preparó como herramienta aparte y **no forma parte del
commit de producto**: no la importa ningún módulo, ninguna suite ni ningún
script de npm de este commit, y no se ejecutó con IA real. La prueba real del
candidato es el canario del §17: el dueño escribe desde su teléfono.
