# Auditoría de puntos únicos de fallo — Xabor

Hecha sobre el árbol `ecc1b34`, el mismo que produce hoy. Cada hallazgo se
verificó leyendo el código, no de memoria.

El disparador fue un incidente real de conectividad regional de Railway: la
aplicación seguía viva (`/health` 200, `listo:true`, CPU y RAM normales) pero
hubo peticiones de 3, 12 y 14 segundos y 502 alrededor del límite del proxy.
La app estaba sana y el restaurante igual no podía trabajar. Eso no es un bug
de la app: es una propiedad de la arquitectura.

## Resumen

| Severidad | Cuántos | Qué significa |
|---|---|---|
| **P0** | 6 | Puede perder datos, duplicar dinero o dejar el turno parado |
| **P1** | 7 | Degrada el servicio o rompe con más de una réplica |
| **P2** | 5 | Molesto, sin pérdida de datos |

**18 en total.** Ninguno se resuelve "poniendo dos réplicas": varios empeoran
con dos réplicas, que es justamente el punto de esta auditoría.

---

## Los diez principales

### 1. P0 — El webhook de WhatsApp contesta 200 antes de guardar nada

`src/channels/whatsapp-meta.js:1101` — `res.sendStatus(200)` es la **primera
línea** del handler. Todo lo demás (resolver el negocio, guardar el mensaje,
llamar al bot) ocurre después de que Meta ya recibió el acuse.

Si el proceso muere ahí, si la base no responde, o si el deploy reinicia en
ese instante, **Meta no reintenta** y el mensaje del cliente desaparece sin
que nadie se entere. No hay log de que existió.

*Qué se pierde:* el mensaje entrante completo.
*Recuperación actual:* ninguna.
*Protección:* `whatsapp_inbox` (migración 044). Persistir → contestar →
procesar aparte. **Implementado y probado.**

### 2. P0 — Una reentrega de Meta vuelve a ejecutar el bot

La tabla `mensajes` sí deduplica por `message_id_externo` (índice único
parcial, y `guardarMensaje` comprueba el `RETURNING` vacío correctamente).
Pero el webhook **no corta** cuando eso pasa: sigue hasta `procesarMensaje`.
Un webhook reentregado puede acabar en un pedido repetido.

*Protección:* `encolarEntrante` devuelve `duplicado: true` para que el webhook
pueda cortar en seco. **Implementado y probado** (1000 eventos con 341
duplicados inyectados → 1000 lógicos).

### 3. P0 — La idempotencia del POS vive en un `Map` de proceso

`src/services/posEnvios.js:153` — `const _idempotencia = new Map()`.

Con **una** réplica funciona. Con dos, el mismo request idempotente atendido
por instancias distintas crea **dos pedidos**. Y un reinicio vacía el Map, así
que un reintento después de un deploy también duplica.

*Protección:* `sync_operaciones` con UNIQUE `(negocio_id, operation_id)` y
efecto persistido. **Implementado y probado.**

### 4. P0 — La revocación de sesiones vive en memoria

`src/services/session.js:40` — `const tokensRevocados = new Map()`.

Es un agujero de seguridad, no solo de disponibilidad: con dos réplicas, un
token revocado en la instancia A **sigue siendo válido en la B**. Un reinicio
lo revive en todas.

*Protección:* diseñada (tabla de revocación o versión de credencial en el
token). **No implementado**: cambia el flujo de autenticación y merece su
propia fase con pruebas de sesión.

### 5. P0 — Los pedidos activos viven en un array de proceso

`src/orders/orderManager.js:25` — `const pedidos = []`, poblado al arrancar, y
de ahí sale el próximo folio (el log dice `próximo folio: XAB-0124`).

Con dos réplicas cada una tiene su copia y divergen; peor, dos instancias
pueden calcular el mismo folio siguiente. El hotfix de folios (`95ddc96`) puso
la detección de conflicto en la base, así que hoy falla ruidosamente en vez de
duplicar — pero el diseño sigue asumiendo un solo proceso.

*Protección:* diseñada. Requiere mover el cálculo de folio a la base con
`RETURNING`. **No implementado.**

### 6. P0 — El buffer de mensajes de WhatsApp es un `Map` con timer

`src/channels/whatsapp-meta.js:95` — `bufferMensajes`, con debounce por timer.

Un mensaje que entró al buffer y todavía no venció el timer **solo existe en
RAM**. Un reinicio lo borra. Meta ya contestó 200.

*Protección:* con el inbox durable el evento ya está en la base antes del
debounce; el buffer pasa a ser una optimización de agrupado, no el único
lugar donde vive el mensaje. **Implementado a nivel de cimiento**; falta
reescribir el handler para que lo use.

### 7. P1 — PostgreSQL es único y está en el mismo proveedor

Un solo servicio Postgres en el mismo proyecto de Railway. Si no responde:
todo el plano de coordinación cae. No hay réplica de lectura, no hay
failover, y el backup es lógico (`pg_dump`) — no hay PITR verificado.

Detalle que importa: **el fallo de Postgres y el fallo de la app comparten
dominio**. Un incidente regional de Railway se los lleva a los dos.

*Protección:* el plano local del restaurante sigue operando sin base central
(**probado**). Para la nube: propuesta en `cloud-failover.md`, sin implementar.

### 8. P1 — El rate limit es por proceso

`src/services/rateLimit.js:8` — `const intentos = new Map()`.

Con N réplicas el límite real es N×. Afecta al antispam del formulario público
y a los intentos de login. No pierde datos; sí debilita una defensa.

### 9. P1 — El anti-replay del state de OAuth vive en memoria

`src/services/embeddedSignupState.js:9` — `const usados = new Map()`.

Un `state` ya consumido en la instancia A se puede volver a usar en la B.
Es una ventana de replay real en el alta de WhatsApp.

### 10. P1 — Cloudflare está en la ruta y reescribe el HTML

Comprobado en vivo: `https://xabor.mx/` no devuelve bytes estables. Cloudflare
inyecta `/cdn-cgi/l/email-protection` con un token que cambia en cada
petición (56 040 → 57 334 bytes). Es un tercer dominio de fallo entre el
cliente y Railway, y hace que "el HTML servido coincide con el commit" deje de
ser verificable por hash.

No es un defecto en sí. Es una dependencia que no estaba documentada, y
durante el incidente los 502 llegaron a través de ella.

---

## Los ocho restantes

| # | Componente | Sev | Si falla | Protección |
|---|---|---|---|---|
| 11 | `src/agent/session.js` sesiones del bot en `Map` | P1 | el contexto de la conversación se parte entre réplicas y el bot "olvida" a mitad | mover a la base o afinidad por conversación — diseñado |
| 12 | `src/channels/voice.js` sesiones de voz en `Map` | P1 | igual, en llamadas | igual |
| 13 | `src/server.js:112` `integracionesCache` | P1 | una réplica sirve configuración vieja tras un cambio | TTL + invalidación por evento — diseñado |
| 14 | WebSocket `/ws/print-agent` con dueño en proceso | P1 | el desplazamiento por código 4001 solo funciona **dentro de un proceso**: con dos instancias, dos Edge con la misma credencial pueden convivir y duplicar impresiones | ver §WebSocket abajo |
| 15 | `whatsapp-meta.js:55` `erroresPorNegocio` | P2 | las alertas de error se cuentan por réplica | aceptable |
| 16 | `intentoSignupPendiente.js:15` | P2 | un alta a medias se pierde en un reinicio | aceptable, el usuario reintenta |
| 17 | `routes/finanzas.js:27` `syncLog` | P2 | se pierde el log de sincronización al reiniciar | aceptable |
| 18 | Sin `/readiness` separado de `/health` | P2 | el proxy manda tráfico a una instancia que arrancó pero no está lista | `health-contracts.md` |

## WebSocket y multi-instancia (Parte 3)

Las preguntas que había que responder, respondidas leyendo el código:

- **¿Edge A conecta a Cloud 1 y reconecta a Cloud 2?** Funciona: la
  autenticación es contra la base, no contra memoria del proceso.
- **¿Cloud 2 sabe que Cloud 1 tenía el socket?** **No.** El barrido de
  conexiones previas (`src/server.js:1267`) recorre solo el `Set` de clientes
  **de ese proceso**.
- **¿Pueden dos instancias creerse dueñas?** **Sí.** Con dos réplicas, dos
  procesos Edge con la misma credencial conectados a instancias distintas no
  se desplazan. Es exactamente el bug de impresión duplicada que se cerró en
  el gate de Edge — pero solo se cerró *dentro de un proceso*.
- **¿Un ACK puede llegar a otra instancia?** Sí, y no pasa nada: el ACK se
  resuelve contra la base con el `terminalId` de la conexión autenticada.

**Conclusión:** el Edge printing es seguro con **una** instancia. Antes de
activar réplicas hay que resolver el desplazamiento distribuido. Está en los
stoppers.

## Qué NO es un SPOF

Vale la pena decirlo para no inflar la lista: los `Set` de constantes
(`TRANSPORTES`, `AMBITOS`, `ESTADOS_PAGO_VALIDOS`, `SLUGS_RESERVADOS`…) son
tablas de valores, no estado mutable. No estorban a las réplicas.
