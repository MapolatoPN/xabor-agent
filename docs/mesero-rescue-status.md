# Rescate del Mesero de WhatsApp — estado

**Rama:** `rescue/mesero-tool-agent` (desde `a90c8d0` = producción `dab2f12` + 1)
**Fecha:** 20 de septiembre de 2026
**Auditoría de partida:** [`mesero-auditoria-2026-09-20.md`](mesero-auditoria-2026-09-20.md)

**Estado de salida:** NO APTO PARA CANARIO. La revisión posterior encontró que
el camino nuevo registraba el pedido sin llamar a `emitirPedido`. Ya se conectó
con esa ruta operacional durable y se añadió una prueba con un emisor inyectado.
Falta comprobar con una base y un canal de prueba que el pedido llegue de verdad
al panel y a la impresora. El replay y el humo simulado no ejercitan ese tramo.
Los eventos de `agente_outbox` siguen sin consumidor y no forman parte del
camino productivo actual.

---

## 1. La arquitectura anterior, y por qué no se podía encender

```
mensaje -> continuidad -> brain.js
             |
             +-- el MODELO emite un PEDIDO ENTERO en <ORDEN_PREVIEW>
             +-- si no lo emite, se le PIDE OTRA VEZ (extraerBorradorForzado)
             +-- propuestasDesdeBorrador() deduce POR DIFERENCIA qué quiso cambiar
             +-- reconciliar() decide sobre ese diff
             +-- validarOrdenPropuesta() vuelve a decidir, con OTRAS reglas
```

Y el Mesero Digital —7.300 líneas, 24 suites, ~470 aserciones verdes— colgaba
de esto:

```
atenderTurno()  <-  sombraDelMesero.js  <-  whatsapp-meta.js:1876
                                            detrás de `if (!modo.meseroSombra)`
```

**Un solo sitio de llamada en todo `src/`, y era la sombra.** `modo.mesero`
—la bandera productiva `mesero_whatsapp_v1`— no la leía nadie. Poner esa clave
en `true` no cambiaba una línea de lo que el negocio contestaba.

No es que el Mesero estuviera mal probado. Es que **no había nada que
encender**: activar no estaba a una bandera de distancia, estaba a una
integración de distancia, y esa integración nunca se escribió porque toca dos
componentes protegidos.

## 2. La arquitectura nueva

```
WhatsApp
  -> continuidad existente (dedup wamid, FOR UPDATE, advisory lock)   SIN TOCAR
  -> whatsapp-meta.js: modoDelPedido(negocio, teléfono)
       proceso? negocio? ESTE teléfono en el canario?   -> si no, sigue el bot de siempre
  -> canalDelAgente.atenderConAgente()
       carga estado REAL (conversacion_estado) + carta REAL (menu_*)
  -> agenteDelMesero: bucle
       modelo -> tool_use -> [esquema] -> [máquina de estados] -> [libro] -> ejecutor
       ejecutor -> reconciliar()  <- LA ÚNICA AUTORIDAD
       RELECTURA del pedido -> tool_result -> el modelo sigue
  -> el modelo redacta DESPUÉS de todas las herramientas
  -> registrarPedido() (la puerta de siempre) -> emitirPedido() (ruta operacional durable)
  -> WhatsApp
```

La diferencia en una frase: **el modelo ya no emite un estado, emite
operaciones, y cada una vuelve con lo que realmente pasó.**

### Lo que se reutilizó tal cual

| Pieza | Para qué |
|---|---|
| `services/whatsappContinuidad.js` | dedup por `wamid`, agrupación 6 s, `FOR UPDATE`, `pg_advisory_lock`, ejecución interrumpida. **No se construyó Redis ni BullMQ**: no hay evidencia de que Postgres no alcance. |
| `orders/carritoDelPedido.js` `reconciliar()` | la autoridad. Toda mutación pasa por aquí y sigue exigiendo evidencia en lo que DIJO el cliente. |
| `mesero-whatsapp/motorTransaccional.js` | ya era un ejecutor de acciones; le faltaba el emisor. |
| `mesero-whatsapp/consultasDelMenu.js` | `buscar_producto` y `ver_opciones_producto` son esto. |
| `mesero-whatsapp/resumenDelPedido.js` | resumen desde el carrito validado + `huellaDelResumen`. |
| `mesero-whatsapp/faseConversacional.js` `loQueFalta()` | incluye «un domicilio sin dirección NO está listo». |
| `orders/orderManager.js` `registrarPedido()` | única puerta de creación de pedidos, con su gate P0. |
| `conversacion_estado` (migración 076) | el estado del agente entre turnos, en su propio espacio de nombres. **Una tabla menos.** |

### Lo que se retiró del camino crítico

| Se retira | Por qué |
|---|---|
| `<ORDEN_PREVIEW>` / `<ORDEN_CONFIRMADA>` | el modelo ya no emite un pedido entero. |
| `extraerBorradorForzado()` (2.ª llamada al modelo) | no hay borrador que arrancarle. |
| `propuestasDesdeBorrador()` (el diff) | las operaciones llegan explícitas. |
| `clasificarTurnoPostPreview()` | la huella del resumen hace el trabajo, con datos y no con léxico. |
| **el menú dentro del prompt** | la carta se consulta con una herramienta. Un menú memorizado es de donde salen los platillos que no existen. |
| 3 de los 4 tipos de aclaración | con `producto_id` obligatorio, un renglón ambiguo no puede nacer. Queda «grupo obligatorio sin elegir», y se deduce del carrito. |
| el estado conversacional guardado | el estado se CALCULA del carrito. Un estado guardado es una opinión, y se desincroniza. |

**Nada de esto se ha borrado de `brain.js`.** El camino viejo sigue entero y es
el que atiende a todo el mundo fuera del canario. Retirarlo es un paso
posterior, cuando el agente lleve tráfico.

## 3. Las herramientas (12)

| Herramienta | Efecto | Qué garantiza |
|---|---|---|
| `ver_pedido` | no | el modelo nunca supone el contenido del pedido |
| `buscar_producto` | no | sin resultados = NO existe; varios = pregunta, no elige |
| `ver_opciones_producto` | no | grupos y cardinalidad reales del negocio |
| `agregar_producto` | sí | exige `producto_id` real; opciones validadas contra ese producto |
| `modificar_linea` | sí | cantidad, opciones, `sin_opciones` (quitar), nota |
| `quitar_linea` | sí | por `linea_id`; el verbo lo sigue exigiendo el reconciliador |
| `definir_entrega` | sí | modalidad y/o dirección; un domicilio sin dirección no queda listo |
| `definir_pago` | sí | |
| `definir_cliente` | sí | el teléfono ya lo tiene Xabor |
| `cancelar_pedido` | sí | desenlace de conversación, no edición de carrito |
| `confirmar_pedido` | sí | **exige la huella del resumen que el cliente leyó** |
| `pedir_humano` | sí | legal incluso con el pedido confirmado |

Esquema Zod estricto (`additionalProperties: false`); el JSON Schema que ve el
modelo se **deriva** del mismo Zod, así que no pueden divergir.

## 4. La máquina de estados

```
navegando -> armando -> aclarando -> listo -> confirmado
                 \                      \
                  +--> cancelado         +--> escalado
                                          +--> fallido
```

**El estado no se guarda, se calcula** del carrito real. Solo se guardan los
cuatro hechos irreversibles. Se retiró `confirmando` del diseño: su única
función era recordar que se mostró un resumen, y eso ya lo lleva la huella.

Legalidad: leer siempre; mutar solo en los cuatro estados en curso;
`confirmar_pedido` **solo desde `listo`**; `pedir_humano` también desde
`confirmado`. «No se puede cambiar un pedido confirmado» no necesita una regla
por herramienta: no hay ninguna mutación legal ahí.

## 5. Invariantes

Se comprueban en **todos** los fixtures, diga lo que diga cada uno.

| Invariante crítica | Cómo se detecta |
|---|---|
| `producto_inventado` | un renglón que no está en ninguna carta |
| `cruce_multiempresa` | un renglón de la carta de OTRO negocio |
| `mutacion_no_autorizada` | el pedido cambió en un turno sin ninguna herramienta aplicada |
| `confirmacion_distinta` | lo mandado a cocina != el pedido real |
| `precio_incorrecto` | el total != suma de la carta |
| `efecto_repetido` | la misma operación registrada dos veces |
| `pedido_duplicado` | dos confirmaciones en una conversación |

## 6. Resultados

```
test/fase-agente-tools.mjs        47 pasadas, 0 fallidas    (contrato, ejecutor, FSM, libro)
test/fase-agente-canario.mjs      14 pasadas, 0 fallidas    (alcance, kill switch, sombra)
test/replay-mesero.mjs            26 pasadas, 0 fallidas    (conversaciones completas)
test/fase-agente-estado.mjs        lectura fallida rechazada, sin inventar estado nuevo
test/fase-agente-emision.mjs       registro enlazado a emitirPedido; rechazo no emite
test/fase-agente-ciclos.mjs        un pedido nuevo rota la identidad del libro
test/fase-agente-indice-local.mjs  índice único y libro probados en Postgres local; ROLLBACK
npm run mesero:eval               invariantes críticas: 0/7   PUERTA: ABIERTA
27 suites del Mesero anterior     verdes sin base de datos
2 suites con base de datos        requieren fixture dedicado; no se corrieron sobre datos locales compartidos
```

**Pruebas de mordida** — cada garantía desactivada por separado, y dónde cae:

| garantía desactivada | caen |
|---|---|
| el `producto_id` no se resuelve contra la carta | B3 |
| las opciones no se validan contra el producto | B4 B5 B6 B7 |
| la máquina de estados sin guardia | D4 E3 |
| la huella del resumen sin comparar | E2 |
| el libro sin idempotencia | F1 F6 |
| lo ofrecido no se limita a un candidato | G2 |
| los esquemas dejan de ser estrictos | A3 A5 |
| el reconciliador deja de decidir | C1 C2 C3 G2 G3 |
| el pedido no se relee tras mutar | B7 E4 |
| el canario deja de acotar | A1 A2 C4 |
| la llave del proceso deja de hacer falta | B1 |
| la lista deja de mandar sobre el porcentaje | A4 |
| el porcentaje se vuelve aleatorio | A5 |
| «true» deja de ser la palabra exacta | B3 |
| el agente se observa a sí mismo | C2 |
| un error de lectura ya no cae apagado | B4 |

### Tres defectos REALES que encontró el replay

No los introdujo el código nuevo: los descubrió, y llevaban tiempo ahí.

1. **«quita el waffle, el café sí lo quiero» borraba los dos.** El corte de
   alcance asume objeto después del verbo; el español lo antepone con clítico.
   Regla general de gramática: con clítico antes del verbo de pedir, el alcance
   se corta en el límite de cláusula anterior. Una enumeración sin verbo propio
   («quita el waffle, la coca y ya») sigue quitando las dos.
2. **«sin huevo» no quitaba nada.** Vaciar un grupo era *inexpresable*: la lista
   vacía se caía del borrador y el reconciliador conservaba lo viejo (y hacía
   bien: eso es lo que arregló `fase-mesero-suma-grupos`). Ahora se distingue
   array vacío —una decisión— de omisión, y vaciar sigue necesitando que el
   cliente lo pidiera.
3. **«dos bowls iguales» entregaba uno.** Dos acciones idénticas en el mismo
   turno son dos peticiones, no un reintento: la clave de operación lleva el
   ordinal por contenido.

## 7. Lo que NO está probado (y es el bloqueo)

> **El agente nunca ha hablado con el modelo de verdad.** No hay
> `ANTHROPIC_API_KEY` en esta máquina.

El replay corre el sistema entero con un **modelo de guion**. Eso prueba que
Xabor decide bien —rechaza lo no autorizado, no inventa productos, no confirma
de más, no aplica dos veces— y **no prueba nada** sobre si el modelo entiende a
una persona ni sobre si llama a las herramientas correctas.

Lo que falta es una corrida de `scripts/mesero-humo.mjs`, que está escrito y
listo:

```bash
ANTHROPIC_API_KEY=... DATABASE_URL=... node scripts/mesero-humo.mjs --negocio <uuid>
```

Sin efectos (no registra, no escala, no imprime). `--registrar` se rechaza:
los pedidos reales solo se prueban mediante el canario autorizado.
La clave del humo se pasa directamente al cliente del modelo para evitar
importar `server.js` y arrancar los jobs de la aplicación durante la prueba.

Segunda medición con modelo real, sobre los 26 fixtures:

```bash
ANTHROPIC_API_KEY=... npm run mesero:eval -- --modelo
```

## 8. Pasos exactos para la SOMBRA

La sombra no responde, no registra, no imprime, no cobra, no escala y escribe
su libro en memoria. Funciona con el bot productivo apagado.

1. En Railway, sobre la rama de despliegue vigente (**no `main`** — ver
   CLAUDE.md), variables del servicio:
   ```
   MESERO_AGENTE_SHADOW=true
   ```
2. En `configuracion`, para el negocio a observar:
   ```sql
   INSERT INTO configuracion (negocio_id, clave, valor)
   VALUES ('<uuid>', 'mesero_agente_shadow', 'true')
   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'true';
   ```
3. Aplicar las migraciones (ver §11).
4. Leer en los logs de Railway (**hora UTC-6**, no UTC):
   `[SOMBRA-AGENTE] {...}` — una línea JSON por turno, sin PII.
5. Apagar: quitar `MESERO_AGENTE_SHADOW` o poner la clave del negocio a
   `'false'`. Cualquiera de las dos basta.

## 9. Pasos exactos para el CANARIO — **requiere aprobación de Mario**

No se activa sin autorización explícita. Preparado, no activado.

1. **Gate previo:** cerrar el bloqueo operacional señalado al inicio,
   comprobar con una prueba de integración que el pedido llega al panel y a la
   impresión, correr el humo con modelo real (§7) y obtener
   `npm run mesero:eval -- --modelo` sin críticas.
2. Variable del servicio:
   ```
   MESERO_AGENTE_MODE=true
   ```
3. Alcance **explícito** — sin esto no atiende a nadie, que es el diseño:
   ```sql
   INSERT INTO configuracion (negocio_id, clave, valor) VALUES
     ('<uuid>', 'mesero_agente_v1',        'true'),
     ('<uuid>', 'mesero_agente_telefonos', '528781234567')   -- los de prueba
   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor;
   ```
4. Ampliar por porcentaje solo después, y por pasos: `mesero_agente_porcentaje`
   a `'5'`, luego `'25'`. El reparto es **estable por teléfono**: un cliente no
   salta entre bots a mitad de pedido.
5. **Kill switch — tres niveles, del más rápido al más fino:**

   | quitar | alcance | efecto |
   |---|---|---|
   | `MESERO_AGENTE_MODE` | todos los negocios | inmediato, sin redeploy de código |
   | `mesero_agente_v1='false'` | un negocio | al siguiente mensaje (no hay caché) |
   | vaciar `mesero_agente_telefonos` y poner porcentaje a `'0'` | unos clientes | al siguiente mensaje |

   En los tres casos el cliente sigue atendido: **el bot de siempre responde**,
   porque el camino viejo no se tocó.

6. **Verificar que llegó, no suponerlo.** `/health` responde 200 con el build
   viejo igual que con el nuevo. Lo que prueba: una conversación de prueba
   desde un número de la lista, y `[AGENTE] evento=atendido` en los logs.

## 10. Variables de entorno nuevas

| Variable | Para qué | Sin ella |
|---|---|---|
| `MESERO_AGENTE_MODE` | habilita el agente productivo | apagado |
| `MESERO_AGENTE_SHADOW` | habilita la sombra | apagada |
| `MESERO_AGENTE_MODELO` | modelo del agente | `claude-sonnet-5` |
| `LANGFUSE_PUBLIC_KEY` / `LANGFUSE_SECRET_KEY` / `LANGFUSE_HOST` | trazas externas | solo la línea `[AGENTE-TRAZA]` en el log |
| `CORPUS_SALT` | seudónimo estable del corpus | el script se niega a exportar |
| `DATABASE_PUBLIC_URL` | leer producción desde fuera | el `DATABASE_URL` de la app es red interna y no se alcanza |

Claves de `configuracion` por negocio: `mesero_agente_v1`,
`mesero_agente_shadow`, `mesero_agente_telefonos`, `mesero_agente_porcentaje`.

## 11. Migraciones

La 084 crea el libro de operaciones y es requisito del agente productivo.
El script verifica que el camino crítico (pedidos, mensajes, configuración,
negocios) no cambió y aborta si algo difiere.

```bash
node scripts/predeploy-084-agente-operaciones.mjs   # libro de operaciones
```

Reverso: `migrations/084_agente_operaciones_down.sql`.
La 085 crea una tabla experimental sin consumidor y no es requisito del camino
productivo actual: no aplicarla por inercia.

**No hace falta migración para el estado del agente**: vive en
`conversacion_estado` (076) con su propio `session_id`.

## 12. Rollback

| Qué | Cómo | Deja algo atrás |
|---|---|---|
| Apagar el agente | quitar `MESERO_AGENTE_MODE` | no |
| Apagar un negocio | `mesero_agente_v1='false'` | no |
| Volver al build anterior | redeploy del commit previo de la rama de despliegue | la tabla 084, vacía e inerte |
| Deshacer la migración | `084_agente_operaciones_down.sql` | no |

El camino viejo (`brain.js`) no se modificó. La única edición en
`whatsapp-meta.js` es un bloque que, si el agente no puede o está apagado, se
aparta y deja seguir el flujo de siempre línea por línea.

## 13. Qué necesita aprobación humana

1. **Correr el humo con modelo real** — necesita `ANTHROPIC_API_KEY`, que no
   está en esta máquina.
2. **Activar el canario** — atiende clientes reales.
3. **Desplegar** — CLAUDE.md: el despliegue es un acto explícito
   (`railway redeploy --yes --from-source`) y sobre la rama configurada en
   Railway, **no `main`**.
4. **Merge a `main`** o a la rama de despliegue.
5. **Correr el corpus contra producción** — lectura de conversaciones reales,
   aunque salgan anonimizadas.

## 14. Fallos restantes y riesgos

**Fallos preexistentes, comprobados idénticos en `a90c8d0`** (worktree del
commit base, misma base, mismo puerto):

| suite | resultado | en la rama | en la base |
|---|---|---|---|
| `fase-bot-calla-y-avisa` | S1, S2 (parseo de borrador JSON) | 22/2 | 22/2 |
| `fase-vision-v2-universal` | 1 caso | 62/1 | 62/1 |

Riesgos que quedan abiertos:

- **Emisión operacional sin prueba de integración.** El agente ya llama a
  `emitirPedido` después de `registrarPedido`, igual que el bot legacy, y una
  prueba con funciones inyectadas verifica el enlace. Falta demostrar con base
  y canal de prueba que el mensaje al cliente, el panel y la impresión reciban
  el mismo folio. Una falla después del registro ya no devuelve el turno al
  bot viejo; aún falta ejercitar ese caso en una prueba de integración.
- **Resultado incierto del registro.** Si la conexión cae justo después del
  COMMIT de `registrarPedido`, el agente puede recibir un error sin saber si el
  pedido quedó creado. El libro ya bloquea un segundo intento en esa
  conversación y solicita intervención humana; la 084 tiene una restricción
  única para cerrar también la carrera entre dos turnos concurrentes. El
  índice y el libro pasaron una prueba transaccional en Postgres local. Falta
  comprobar con base de prueba el flujo de error posterior al COMMIT. No se
  debe pedir al modelo que reintente a ciegas.
- **Pedidos posteriores.** Un pedido nuevo explícito tras un estado terminal
  abre otro ciclo y otra identidad en el libro. Las consultas sobre el pedido
  anterior conservan el ciclo previo. Faltan pruebas con lenguaje real para
  medir si los clientes formulan el nuevo pedido de manera reconocible.
- **Outbox experimental.** La migración 085 y `outbox.js` siguen en la rama,
  pero no hay consumidor y el agente no escribe allí. No se deben usar como
  evidencia de entrega operacional ni habilitar sus efectos sin una revisión
  separada.
- **El prompt no está afinado con tráfico real.** El sistema frena lo que el
  modelo se invente, pero cada freno cuesta una iteración y un turno peor. Es
  lo que mide `npm run mesero:eval -- --modelo`.
- **Coste por turno sin medir.** El agente hace varias llamadas por turno
  (mediana 2–3 en los fixtures). El scorecard ya cuenta llamadas y tokens;
  falta el dato con modelo real.
- **`registrarPedido` revalida con `validarOrdenPropuesta`**, que sigue siendo
  un segundo juego de reglas junto al reconciliador. No se tocó a propósito —es
  el gate P0 y la única puerta de creación de pedidos—, pero es la duplicación
  de autoridad que queda por resolver.
- **`sin_opciones` sobre un grupo obligatorio** deja el renglón pendiente, que
  es correcto, pero si el cliente nunca contesta el pedido no avanza. Hoy sale
  por `pedir_humano` tras dos intentos.
