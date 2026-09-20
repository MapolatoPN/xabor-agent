# Auditoría del Mesero de WhatsApp — 20 de septiembre de 2026

Punto de partida de la reingeniería. Escrita leyendo el código de `a90c8d0`
(producción `dab2f12` + un commit), no de memoria.

---

## 0. El hallazgo que explica el mes

> **El Mesero no está conectado a ningún camino productivo. No hay nada que
> activar.**

No es una opinión. Es el grafo de llamadas:

```
atenderTurno()                       src/mesero-whatsapp/meseroDigital.js:299
  └── único llamador en src/:        sombraDelMesero.js:377
        └── único llamador:          whatsapp-meta.js:1876
              └── guardado por:      if (!modo.meseroSombra) return null;
                    └── y llamado SOLO desde los tres puntos donde el canal
                        ya decidió callarse (bot apagado / cliente pausado /
                        takeover humano)
```

`grep -rn "atenderTurno" src/` devuelve **un** sitio de llamada. Es la sombra.

Y el interruptor que supuestamente enciende el Mesero productivo:

```
modo.mesero   <-  mesero_whatsapp_v1 && pedido_reconciliador_v2
```

**no lo lee nadie.** Los únicos lectores de `modoDelPedido` son `brain.js:654`
(usa `.v2`), `whatsapp-meta.js:1842/1875` (usan `.shadow` y `.meseroSombra`) y
`validadorOrden.js:375/944` (usan `.v2`). Poner `mesero_whatsapp_v1='true'` en
la tabla `configuracion` de un negocio hoy **no cambia una sola línea de lo que
ese negocio contesta**.

De ahí sale, entera, la sensación de «muchas pruebas verdes y aun así no
podemos activarlo»: las 24 suites puras del Mesero (~470 aserciones, todas
verdes hoy — ver §4) prueban una capa que **no puede hablarle a un cliente**.
Activar no estaba a una bandera de distancia; estaba a una integración de
distancia, y esa integración nunca se escribió porque toca dos componentes
protegidos.

La propia nota de arquitectura lo dice, en la última sección y sin énfasis:
«**No hay integración con el canal.** `whatsapp-meta.js` y `brain.js` no llaman
al mesero todavía.»

---

## 1. Qué sirve y se reutiliza tal cual

Esto es lo bueno, y es mucho. Nada de esto se rehace.

| Pieza | Qué resuelve | Por qué se conserva |
|---|---|---|
| `services/whatsappContinuidad.js` | persistencia de entradas, dedup por `wamid`, `FOR UPDATE`, `pg_advisory_lock(negocio,teléfono)`, ejecución interrumpida, vigilante | es la única parte que ya sobrevivió a tráfico real sin un fallo |
| `orders/carritoDelPedido.js` `reconciliar()` | **la autoridad**: qué entra al pedido, campo a campo, contra lo DICHO | es el freno; la reingeniería lo mantiene como único juez |
| `mesero-whatsapp/anclajeAlCatalogo.js` | resolver una frase a producto(s) reales con la cardinalidad del catálogo | es exactamente el motor que necesitan `buscar_producto` / `ver_opciones_producto` |
| `mesero-whatsapp/motorTransaccional.js` | `{accion, lid, campo, valorAnterior, valorNuevo, evidencia}` -> `reconciliar` -> `decisiones` | **ya es un ejecutor de acciones**: le falta el emisor |
| `mesero-whatsapp/aclaraciones.js` + pendientes | descriptor, no frase; ciclo `creados/resueltos/cancelados/obsoletos` | corregido con tráfico real el 13-sep; rehacerlo sería repetir ese día |
| `mesero-whatsapp/resumenDelPedido.js` | resumen desde el carrito validado + `huellaDelResumen` / `resumenSigueVigente` | es la invariante de confirmación que se pide |
| `mesero-whatsapp/redaccionPII.js` | redacción de teléfono/dirección/email | es el prerrequisito de toda observabilidad externa |
| `orders/modoDelPedido.js` | banderas por negocio, fail-safe a LEGACY | el gate por negocio ya está resuelto y probado |
| `mesero-whatsapp/handoffDeSombra.js` / `handoffHumano.js` | criterio y equipaje del escalado | reutiliza `enviarARevision` del canal |

---

## 2. Qué duplica responsabilidad

1. **Dos juegos de reglas sobre el pedido.** `carritoDelPedido.js` (983 líneas)
   decide qué entra; `validadorOrden.js` (1377 líneas) vuelve a decidir sobre el
   borrador ya reconciliado, con su propio catálogo de `RECHAZOS`, su propia
   normalización de nombres y su propia resolución de producto ambiguo
   (`continuarAclaracionProducto`). Son dos autoridades, y la que manda es la
   que corre última.

2. **Dos llamadas al modelo por turno para el mismo dato.**
   `procesarMensajeInterno` llama al modelo; si la respuesta no trajo
   `<ORDEN_PREVIEW>`, `extraerBorradorForzado()` (brain.js:269) **vuelve a
   llamar al modelo** para arrancarle un pedido completo. Un pedido que el
   modelo no quiso emitir se le exige igualmente.

3. **Tres estados conversacionales en paralelo.** `agent/session.js` (en memoria
   + snapshot durable: `mensajes`, `cicloPedido`, `carrito`, `pedido`,
   `datosPedido`, `esperandoDato`, `aclaracionProducto`, `previewPedido`,
   `ordenesConfirmadas`), `contextoMesa.js` (fase, foco, propuestas, pendientes,
   líneas — solo del Mesero) y `conversaciones_control` (continuidad). Ninguno
   es la fuente de verdad de los otros.

4. **Cuatro resolutores de «a qué se refiere el cliente»**: `parecido()` y
   `laFraseLoSenala()` en el carrito, `anclarLinea()` en el anclaje,
   `referenciasDelCliente.js`, y `continuarAclaracionProducto()` en el validador.

---

## 3. Dónde tiene demasiada autoridad el modelo

El contrato actual con el modelo es **texto con marcadores XML que contienen un
pedido completo**:

```
<ORDEN_PREVIEW>{...pedido entero...}</ORDEN_PREVIEW>
<ORDEN_CONFIRMADA>{...pedido entero...}</ORDEN_CONFIRMADA>
```

No hay una sola llamada a herramientas en todo `src/`
(`grep -rn "tool_use\|tools:" src/` -> 0 resultados).

Consecuencias, en orden de gravedad:

1. **El modelo emite un ESTADO, no una operación.** Nadie sabe qué quiso
   cambiar. `propuestasDesdeBorrador()` lo reconstruye por diferencia — un diff
   contra un estado probabilístico, que es justo lo que se quiere retirar.
2. **El modelo nombra productos con texto libre.** El anclaje al catálogo
   existe, pero se aplica *después*, sobre una cadena que el modelo inventó.
3. **El modelo decide cuándo hay preview y cuándo hay confirmación** poniendo un
   marcador. Si no lo pone, se le fuerza (§2.2). Si lo pone de más, el backend
   tiene que atajarlo con `clasificarTurnoPostPreview`.
4. **El texto que ve el cliente lo redacta el modelo en el mismo turno en que
   propone el pedido**, así que puede describir un pedido que el reconciliador
   luego rechazó. Es la divergencia que `huellaDelResumen` intenta cazar después
   del hecho.

---

## 4. Línea base medida (20-sep-2026, `a90c8d0`)

Las 24 suites puras del Mesero, sin Postgres, sin puertos, con el entorno limpio
(`MESERO_SHADOW_MODE` y `PEDIDO_SHADOW_MODE` **sin heredar**):

```
fase-mesero-acumulacion                    20/20
fase-mesero-adversariales                  33/33
fase-mesero-autoridad                      25/25
fase-mesero-autoridad-articulo-y-direccion 26/26
fase-mesero-borrador-real                  30/30
fase-mesero-catalogo-canonico              26/26
fase-mesero-cliente-vigencia               verde (sin línea de resumen)
fase-mesero-concurrencia-turnos            15/15
fase-mesero-consentimiento                 22/22
fase-mesero-contexto                       34/34
fase-mesero-declaracion-vs-consulta        verde (sin línea de resumen)
fase-mesero-e2e                            20/20
fase-mesero-frijoles                       11/11
fase-mesero-intenciones                    33/33
fase-mesero-matching-seguro                27/27
fase-mesero-memoria                        15/15
fase-mesero-menu                           37/37
fase-mesero-nombre-de-grupo-no-elige       12/12
fase-mesero-ontologia-causal               19/19
fase-mesero-pendientes                     25/25
fase-mesero-sombra-datos-operativos        14/14
fase-mesero-suma-grupos                    12/12
fase-mesero-variantes                      14/14
mordidas-mesero-handoff                    verde (sin línea de resumen)
```

**24 suites, 0 fallidas.** Y el bot sigue sin poder activarse. Esa frase es la
línea base real: el verde de hoy no mide lo que hace falta medir, porque
**ninguna de estas suites ejerce el camino por el que llega un mensaje**. Todas
inyectan `proponer` (un modelo falso que devuelve el borrador que la prueba
quiere) y ninguna toca `whatsapp-meta.js`, `brain.js` ni la base.

Por eso la reingeniería empieza por un arnés de replay de conversaciones
completas y un scorecard, no por más unit tests.

---

## 5. Lo que NO se va a rehacer

Queda dicho para que ninguna iteración posterior lo reabra:

- **No se construye Redis, BullMQ ni cola nueva.** `whatsappContinuidad` ya hace
  dedup por `wamid`, agrupación de 6 s, `FOR UPDATE`, `pg_advisory_lock` por
  (negocio, teléfono) y recuperación de ejecuciones interrumpidas, sobre
  Postgres. No hay evidencia de que no alcance.
- **No se reescribe `reconciliar`.** Sigue siendo el único juez del pedido.
- **No se toca la continuidad ni los dos gates del canal.**
- **Dedup de `wamid` != dedup de una acción del agente.** Son dos problemas
  distintos y el segundo no existe hoy: es el libro de operaciones nuevo.
