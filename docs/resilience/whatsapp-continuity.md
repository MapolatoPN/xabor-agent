# Continuidad de WhatsApp

## Qué se promete y qué no

**Se promete:** una caída de Railway, de una región, de una instancia, de un
deploy o de nuestro Postgres **no debe perder eventos de WhatsApp**.

**No se promete:** disponibilidad de WhatsApp si Meta está caído. Eso no
depende de nosotros y decir lo contrario sería mentir. Lo que sí se puede es
distinguir los dos casos y no perder lo que generamos mientras tanto.

## Flujo actual, y dónde se rompe

```
Meta → webhook → [200 inmediato] → resolver negocio → guardar mensaje
     → bot → respuesta → Meta
```

`src/channels/whatsapp-meta.js:1101`: `res.sendStatus(200)` es la **primera
línea**. Todo lo demás pasa después del acuse.

| Momento del crash | Qué pasa |
|---|---|
| Después del 200, antes de guardar | **mensaje perdido**. Meta no reintenta |
| Base sin responder al guardar | **mensaje perdido**, solo queda un `console.error` |
| `phone_number_id` sin mapear | **mensaje descartado** a propósito |
| Dentro del buffer con debounce | **mensaje perdido**: solo estaba en RAM |
| Durante el bot | respuesta perdida, el entrante sí quedó |
| Entre decidir la respuesta y llamar a Meta | **saliente perdido**, sin rastro |
| Después de que Meta aceptó, antes de anotarlo | se puede reenviar duplicado |

## Flujo nuevo

```
1. validar
2. deduplicar
3. PERSISTIR en whatsapp_inbox
4. responder 200
5. procesar en un worker aparte
```

El 200 solo puede significar "lo tengo guardado", nunca "lo entendí".

## Deduplicación

- Mensajes: clave `msg:<wamid>`.
- Estados: clave `st:<wamid>:<status>:<timestamp>`. **No basta el wamid**: el
  mismo mensaje pasa por `sent`, `delivered` y `read`, y los tres son eventos
  legítimos distintos. Deduplicar solo por wamid tiraría dos de cada tres.

`encolarEntrante` devuelve `duplicado: true` para que el webhook **corte en
seco**. Hoy no corta: aunque `mensajes` deduplica la fila, el handler sigue
hasta el bot y una reentrega puede acabar en un pedido repetido.

## Eventos sin negocio

Hoy se descartan. Ahora se guardan como `huerfano`: perder el mensaje de un
cliente porque falta una fila de configuración es peor que guardarlo sin
dueño. `adoptarHuerfanos()` los reasigna cuando el negocio se configura.

## Claiming distribuido

`FOR UPDATE SKIP LOCKED` + lease con vencimiento. Dos workers en dos
instancias nunca toman el mismo evento; si uno muere, su lease vence y otro lo
recoge. Probado con 40 eventos y dos workers en paralelo: cero solapamiento.

## Outbox

```
encolado → enviando → enviado_a_meta
                    → incierto
                    → fallo_reintentable → fallo_definitivo
```

**`incierto` es la pieza clave.** Un worker que muere con el envío en vuelo no
se reintenta solo: Meta pudo haberlo recibido y no hay forma de preguntárselo.
Reintentar es mandarle al cliente el mensaje dos veces; darlo por enviado es no
mandárselo nunca. Se marca y lo decide una persona. Es la misma semántica que
el `incierto` de la impresión RAW TCP, por la misma razón.

## Idempotencia de salida (Parte 27)

Nuestra idempotencia es `(negocio_id, clave_idem)`: la misma causa no genera
dos mensajes. **Meta no ofrece idempotencia de envío** — no hay forma de
decirle "manda esto una vez y si te lo repito ignóralo". Por eso no se promete
exactamente-una-vez de punta a punta: se promete no perder, y no duplicar por
causas nuestras.

## Semántica de Meta (Parte 25) — BLOQUEADO

No se pudo verificar contra documentación oficial en esta sesión: el trabajo
corrió sin acceso de navegación a developers.facebook.com, y **no se citan de
memoria** los tiempos de reintento, la ventana, el orden de entrega ni el
comportamiento ante 5xx.

Lo que el diseño hace mientras tanto es **no depender de ello**:

- no se asume que Meta reintente: el evento se persiste antes de contestar,
  así que un reintento suyo es una comodidad, no un requisito;
- no se asume orden: cada evento se procesa por su identificador;
- no se asume que un duplicado sea raro: se deduplica siempre.

**Pendiente antes del piloto:** confirmar en la documentación oficial vigente
los reintentos, la ventana y el comportamiento ante 5xx, y citar las URLs aquí.

## Métricas (Parte 48)

`metricasWhatsapp()` expone pendientes de entrada y salida, fallidos,
huérfanos, inciertos y **la edad del más viejo**. Lo último importa más que el
conteo: tres mensajes parados cuarenta minutos es peor que trescientos
avanzando.

## Resultado del caos

1000 eventos, 341 duplicados inyectados, 106 crashes de worker:
**1000 eventos lógicos, 0 perdidos, 0 procesados dos veces.**
Salida con un worker muerto en vuelo: 80 enviados + 40 inciertos = 120,
ninguno perdido y ninguno reintentado a ciegas.
