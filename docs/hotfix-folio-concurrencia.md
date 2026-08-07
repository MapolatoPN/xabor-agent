# Hotfix P0 — Conflicto silencioso de folio

Rama `hotfix/folio-conflicto-silencioso` (base 98601ec, el commit desplegado).
**Sin migración, sin SQL, sin tocar producción durante la implementación.**

## El bug

`guardarPedidoActivo()` (src/services/database.js) insertaba con
`ON CONFLICT (folio) DO NOTHING` y devolvía `true` **incondicionalmente**:

```js
await pool.query(`INSERT ... ON CONFLICT (folio) DO NOTHING`, [...]);
return true;   // ← también cuando no se escribió NINGUNA fila
```

`pedidos_activos.folio` es **PRIMARY KEY global** (no por negocio), así que
un folio ya usado por otro pedido —incluso de **otro negocio**— hacía que el
INSERT no escribiera nada y la función igual reportara éxito.

`registrarPedido()` (src/orders/orderManager.js) tomaba eso como confirmación:
agregaba el pedido a memoria, lo devolvía al canal, y a partir de ahí se
emitía la comanda, se generaba el enlace de pago y se ofrecía a la red de
repartidores — **sobre una fila que en la base era otro pedido**.

Además el contador se incrementaba **después** del `await`:

```js
const persistido = await guardarPedidoActivo(pedido, negocioId); // ← await
pedidos.push(pedido);
contadorPedidos++;                                               // ← tarde
```

Dos creaciones concurrentes leían el mismo `contadorPedidos` y componían el
mismo folio.

## Riesgo real

Reproducido en base fresca con el código exacto de producción:

- 2º guardado del **mismo folio con otro negocio**: no inserta, devuelve
  `true`, la fila sigue siendo la del negocio original.
- 20 intentos concurrentes sobre 10 folios repetidos: **20 "éxitos", 10 filas,
  10 pérdidas silenciosas**.

Vías de exposición en producción: dos pedidos creados casi al mismo tiempo en
el mismo proceso (WhatsApp + POS + presencial), y sobre todo el **solape de
instancias durante un deploy de Railway** (la instancia vieja y la nueva
tienen cada una su contador en memoria).

No se encontró evidencia histórica del daño en producción (0 folios duplicados
en el historial, 0 pagos sin pedido). Los 21 huecos de secuencia y las 49
notificaciones huérfanas se explican por completo por pedidos de prueba
borrados con el DELETE de admin (XAB-0099, XAB-0107, XAB-0116).

## La corrección

1. **Detección real del conflicto** (`guardarPedidoActivo`): `RETURNING folio`
   + `rowCount`. Sigue sin lanzar nunca, y ahora devuelve:

   | Resultado | Significado |
   |---|---|
   | `{ ok:true, insertado:true, conflicto:false }` | fila nueva escrita |
   | `{ ok:true, insertado:false, conflicto:true }` | el folio ya existía |
   | `{ ok:false, insertado:false, conflicto:false }` | error SQL real |

2. **Reserva de folio antes del primer await** (`registrarPedido`): se toma
   `contadorPedidos` y se incrementa en la misma vuelta del event loop, así
   dos creaciones concurrentes del mismo proceso ya no pueden componer el
   mismo folio.

3. **Reintento acotado**: si el INSERT no escribió fila, ese folio es de otro
   pedido → se reintenta con el siguiente candidato,
   `MAX_REINTENTOS_FOLIO = 20`. Al agotarse:
   `FOLIO_NO_DISPONIBLE` (error explícito, nunca un pedido confirmado).
   Un `ok:false` (error de base de datos) **no entra al reintento**: se
   rechaza de inmediato con `PEDIDO_NO_PERSISTIDO`.
   Log seguro, sin datos personales:
   `[Pedido] Conflicto de folio XAB-0123, reintentando (intento 1/20, canal=pos)`.

4. **Idempotencia del POS** (efecto secundario obligatorio): la clave
   `Idempotency-Key` se **reserva antes del primer await**
   (`reservarIdempotencia`, src/services/posEnvios.js) y el segundo request
   espera el folio del primero. El flujo anterior (`buscar → crear → recordar`)
   era un check-then-act con dos awaits en medio; **pasaba la prueba de doble
   clic gracias al bug** (ambos requests recibían el mismo folio porque el
   contador se incrementaba tarde y el segundo INSERT se perdía en silencio).
   Corregido el folio, ese hueco habría creado dos pedidos reales. Si la
   creación falla, la clave se libera para no bloquear el reintento.

## Lo que NO es este cambio

Un conflicto de folio **no** significa "mismo pedido". No se recupera ni se
devuelve el pedido existente que comparte folio: entre negocios distintos eso
sería exactamente la contaminación multi-tenant que se está corrigiendo.
Tampoco se agrega un sistema nuevo de idempotencia; los llamadores que ya
re-guardan el **mismo** pedido siguen funcionando igual:

| Llamador | Comportamiento |
|---|---|
| `registrarPedido` (orderManager) | único que reserva folio y reintenta |
| `whatsapp-meta.js:1013` (re-save defensivo) | ignora el retorno; el conflicto es lo esperado |
| `server.js` scheduler de programados | ignora el retorno; folio propio, no del contador |
| `restauranteService.js` (`RM-`) | **intacto**: INSERT propio, folio determinista, su `ON CONFLICT DO NOTHING` es idempotencia legítima |

## Pruebas

`test/fase-folio-concurrencia.mjs` (23 casos): contrato de las tres
respuestas (INSERT / conflicto / error SQL, incluido el cruce de tenants que
reproduce el incidente); reserva y avance del contador; reintento ante folio
ajeno sin adoptar la fila; agotamiento → `FOLIO_NO_DISPONIBLE` sin dejar nada
en memoria; error SQL con **un solo intento**; 20 y 100 creaciones
simultáneas → 20/100 filas con folios únicos; 30 concurrentes de dos negocios
con tenant correcto; **multi-instancia real** (el servidor hijo y el proceso de
la suite arrancan con el mismo contador contra la misma base); re-save de
WhatsApp; scheduler; Rappi; Restaurante `RM-` sin tocar; POS 20 simultáneos,
doble clic idempotente, clave liberada tras fallo, y cero folios duplicados.

Regresión completa de la batería + build Docker.

## Base de datos

**Sin migración.** No se agrega `UNIQUE` a `pedidos.folio` (historial) en esta
fase: hoy no hay duplicados ahí, pero el DELETE de admin borra de activos sin
archivar, y una restricción nueva sobre datos históricos es un cambio de
esquema con riesgo propio. Queda **documentado como defensa futura opcional**,
a evaluar en una fase de datos con su propio respaldo y ventana.

## Rollback

Redeploy del commit anterior (98601ec). El cambio es solo de código en
memoria/consulta: no escribe estructuras nuevas ni migra datos, así que
volver atrás no deja rastro — únicamente reaparece el bug.
