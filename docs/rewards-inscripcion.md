# Rewards solo para inscritos (saneamiento, fase 3)

Puntos 10 a 17 del saneamiento de Clientes, Campañas y Rewards (pedido de
Mario del 21-nov-2026; recomendaciones R1–R4 aprobadas el 23-nov). Migración
**149**. El programa sigue apagado en los negocios hasta que Mario lo encienda.

## 1. La regla

**Solo acumula y canjea una persona inscrita e identificada.** Lo decide el
servidor (`rewardsService.acumularPuntos` y `registrarCanje`), no la pantalla.

Una venta da puntos cuando, todo a la vez:

- el módulo Rewards está contratado y el programa activo;
- el canal está encendido (`MAPA_CANAL_CONFIG`; el POS de envíos, canal
  `pos`, usa el interruptor «Mostrador y POS de envíos»; las mesas no
  acumulan en esta fase);
- el teléfono identifica a una persona: de 10 a 13 dígitos, sin letras, y se
  guarda con los **últimos 10** (`telefonoRewards`). El registro genérico del
  mostrador (`pos-…`) y el técnico de Rappi nunca cumplen;
- no es un teléfono del negocio (`negocio_telefonos_propios`) ni un cliente
  marcado como interno (`clientes_negocio.es_interno`);
- la cuenta existe, está activa y **inscrita** (`inscrito_at`).

**Comprar no inscribe.** Antes, la primera compra creaba la cuenta; así
nacieron las cuentas automáticas (y la del registro genérico del mostrador).
Ahora una venta sin inscripción no da puntos y no crea nada.

## 2. Inscribirse

`inscribirCliente` es la única puerta. Pide nombre y teléfono, y en una
transacción:

- rechaza teléfonos del negocio e internos (409);
- si la persona ya tenía una cuenta «sin inscribir», inscribe **esa** cuenta y
  conserva sus puntos (R1);
- asegura la fila de la persona en la Lista de Clientes, sin pisar un nombre
  que ya estuviera ahí;
- anota la inscripción en `rewards_bitacora`.

Por dónde se llega:

| Origen | Cómo |
|---|---|
| Caja | «Alta» con nombre y teléfono (`POST /api/rewards/cliente`). La búsqueda de la caja solo ofrece inscritos. |
| Tienda | «Mi cuenta» → Rewards → «Inscribirme» (`POST /api/tienda/:slug/cuenta/rewards/inscripcion`, con la sesión de código por WhatsApp; el negocio sale del slug). |
| WhatsApp | «¿Cuántos puntos tengo?» contesta con un texto fijo y, si la tienda tiene cuentas, la liga `…/t/<slug>#mi-cuenta`, que abre Mi cuenta en Rewards. |

La liga necesita la dirección pública del servidor (`XABOR_URL_PUBLICA`,
`BASE_URL` o `PUBLIC_URL`) y una tienda publicada con cuentas de cliente; sin
eso el texto solo dice «en caja».

En la tienda, `inscrito` solo viaja cuando el teléfono es el de una sesión
verificada (Mi cuenta y la cotización con sesión). La ruta pública por
teléfono y la cotización sin sesión no lo incluyen.

## 3. Las cuentas que ya existían

Todas quedan como **«sin inscribir (automático)»**: conservan cuenta y saldo,
no acumulan ni canjean, y se ven aparte en el panel. Qué hacer con ellas lo
decide Mario. Si una persona se inscribe en caja o en la tienda, sus puntos
siguen ahí.

## 4. Una sola fuente para las cifras

`sqlCuentaVigente` define qué cuenta «cuenta» (activa, identificable, ni del
negocio ni interna) y `sqlPersonasRewards` agrupa por persona (los 10
dígitos): dos cuentas del mismo número en formatos distintos son una persona.
`cifrasRewards` da las cifras y la leen la pestaña Rewards y la Lista de
Clientes, así que no pueden diferir:

- inscritos y su saldo;
- sin inscribir (automáticos) y su saldo;
- fuera del programa (el genérico, teléfonos del negocio, internos), aparte.

En la Lista, «Inscritos en Rewards» y los puntos son solo de inscritos, y el
segmento de Campañas por puntos también.

## 5. Vencimiento

Configurable en Rewards → Config: «Vencimiento de puntos», en meses sin
compra (3 a 24 en el panel; el servidor acepta de 30 a 3,650 días). **Nace
apagado.**

- Solo vence cuentas inscritas con saldo.
- El plazo cuenta desde lo más reciente entre la última compra o canje, la
  inscripción y `vigencia_desde` (el día en que se encendió, o en que el
  programa se reanudó). Encender el vencimiento nunca vence a nadie de golpe.
- Cada vencimiento es un movimiento `expiracion` con el saldo completo; una
  segunda pasada no encuentra nada.
- El job corre en segundo plano (`rewardsVencimiento.vencerPuntos`).

## 6. El script de saneamiento

`scripts/rewards-saneamiento.mjs`. **Sin `--aplicar` no escribe**: corre en
una transacción `READ ONLY` que termina en `ROLLBACK`. Nunca imprime un
teléfono completo (solo los últimos 4 dígitos).

```
node scripts/rewards-saneamiento.mjs reporte          --negocio <uuid>
node scripts/rewards-saneamiento.mjs anular-generico  --negocio <uuid> [--aplicar] [--usuario <quién>]
node scripts/rewards-saneamiento.mjs normalizar       --negocio <uuid> [--aplicar] [--usuario <quién>]
node scripts/rewards-saneamiento.mjs revertir         --lote <uuid> | --bitacora <id> [--aplicar]
```

- **reporte**: inscritos, sin inscribir (cuántos con nombre en Clientes),
  números en varios formatos, cuentas con 52/521, registros genéricos y
  teléfonos del negocio. Solo lee.
- **anular-generico** (punto 12): cada cuenta activa sin teléfono de persona
  recibe un `ajuste_negativo` por su saldo, queda dada de baja y sin
  inscripción, con su renglón `anulacion` en la bitácora.
- **normalizar** (punto 14): por persona, lleva el teléfono a 10 dígitos y
  fusiona los duplicados en una cuenta (la de 10 dígitos; si no hay, la
  inscrita; si no, la más vieja) con un par de ajustes. No toca teléfonos del
  negocio ni internos. Comprueba al final que los puntos del negocio no
  cambiaron.
- **revertir**: deshace un lote (o una fila) de la bitácora en orden inverso.
  No revierte una fusión cuyos puntos ya se gastaron: eso se ve a mano.

Movimiento y saldo se escriben juntos: si el saldo en la base no es el que se
leyó, el script se detiene y no queda nada a medias. Lo que se aplica en
producción lo autoriza Mario, después de ver el resultado del modo de prueba.

## 7. Panel

- Rewards: sin los botones repetidos «Configuración» y «Movimientos» del
  encabezado; quedan las cuatro pestañas.
- Tarjetas: «Clientes inscritos», «Saldo de inscritos», «Sin inscribir
  (automáticos)» y una nota con las cuentas fuera del programa.
- En la lista, la insignia «Sin inscribir»; la búsqueda de la pestaña incluye
  a los automáticos, la de la caja no.

## 8. Pruebas

- `test/fase-rewards-inscripcion.mjs`: acumulación, inscripción, canje,
  cifras, tienda, vencimiento, script (modo de prueba, aplicar, revertir,
  libro = saldo), textos, panel y migración.
- `test/fase-rewards-acreditacion.mjs` (caso 14: comprar no inscribe),
  `fase-rewards-tienda`, `fase-integracion-mesero-rewards` y las suites de
  tienda, Lista y cobro, con sus clientes de prueba inscritos.

## 9. Reversa

La 149 es aditiva y el código anterior no lee lo que agrega: volver al
despliegue anterior basta. `migrations/149_rewards_inscripcion_down.sql` solo
a mano y a propósito (borra la bitácora).
