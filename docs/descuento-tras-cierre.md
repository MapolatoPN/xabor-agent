# Descuento al abrir para quien escribió con el negocio cerrado

Decisión de Mario (10-nov-2026), empezando por Acuña.

Quien escribe por WhatsApp **en el horario habitual de servicio** un día en que
el negocio estuvo **cerrado** recibe, al abrir, un código de descuento para la
tienda en línea. El caso típico es el domingo de Acuña. Un día con cierre
especial cuenta igual.

## El mensaje

```
¡Hola! 👋 Lamentamos no haberte atendido ayer: estábamos cerrados. Para compensarte, aquí tienes un descuento de 15 % en nuestra tienda en línea con el código DOMINGO15:
https://xabor.mx/t/<tienda del negocio>

⏰ Válido hasta el lunes 23 de noviembre.

¡Ya estamos en servicio! ☀️
```

- «ayer» cambia a «hace un rato» o «el sábado» según cuándo escribió.
- La fecha es la de **7 días después del envío** (decisión de Mario del
  11-nov). Va en su propia línea para que se vea. Sin fecha no sale mensaje.
- El porcentaje (o el monto, si la promoción es de monto fijo) sale de la
  promoción, no del texto.
- El enlace es la tienda del negocio, no la página de la marca: el código solo
  existe en ese negocio.

## Cuándo sale y a quién no

Lo manda un job en segundo plano (`server.js`, cada minuto).

**Sale al abrir.** WhatsApp solo deja escribir sin plantilla durante las 24 h
siguientes al último mensaje del cliente. Por ejemplo, un mensaje del domingo a
las 10:00 todavía se contesta el lunes a las 7:30, pero no a las 10:30.

**No sale si:**

- el mensaje llegó fuera del horario habitual (madrugada o noche);
- el cliente volvió a escribir ya con el negocio abierto;
- el personal ya le contestó, desde el panel o desde la app de WhatsApp Business;
- ya hizo un pedido, activo o programado;
- la conversación está pausada, tomada por el personal o en revisión;
- quedan menos de 10 minutos de su ventana de 24 h;
- ya lo recibió antes: es **una vez por teléfono por negocio**, para siempre.

El job falla cerrado: no manda nada sin código configurado, sin la promoción
viva, sin tienda publicada, sin el horario propio del negocio (no usa el
genérico) o con el negocio cerrado en ese momento.

Cada envío queda en `descuento_tras_cierre_envios` (migración 136), y la fila se
aparta **antes** de mandar. Así, ni dos instancias durante un despliegue ni un
reintento lo duplican. Un envío que Meta rechaza queda como `fallido` y no se
reintenta.

El mensaje aparece en el chat del panel como un mensaje del bot.

## La promoción

Es una promoción normal de la tienda (pantalla Promociones):

- código `DOMINGO15`;
- 15 %;
- un uso por cliente;
- solo tienda en línea;
- no acumulable;
- sin límite total.

**La fecha de fin la pone el job.** Antes de mandar una tanda, lleva la
vigencia de la promoción al final (hora del negocio) del día que dice el
mensaje: 7 días después. Solo la alarga, nunca la acorta. Como el código es el
mismo todas las semanas, con cada tanda nueva vuelve a valer aunque ya hubiera
vencido. A quien lo recibió antes le sigue valiendo al menos hasta la fecha que
se le dijo, y la tienda lo rechaza al día siguiente de la última fecha
anunciada. Si no puede poner la fecha, no manda nada.

Para apagarlo de verdad: `desactivar` (o desactivar la promoción). Cambiar la
fecha de fin a mano no sirve: la siguiente tanda la vuelve a alargar.

El formulario de WhatsApp no recibe cupones; solo la tienda.

## Encender, revisar, apagar

Todo nace **apagado**. Se enciende por negocio con
`scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs`. El script corre en
**simulacro** por omisión y guarda un respaldo con `--aplicar`:

```
node scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs estado --negocio=<slug>
node scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs activar --negocio=<slug>
node scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs activar --negocio=<slug> --aplicar
node scripts/ops/descuento-tras-cierre-2026-11/descuento.mjs desactivar --negocio=<slug> --aplicar
```

- **`activar`** crea la promoción si no existe y escribe
  `cerrado_descuento_codigo` en la configuración. Antes de guardar, le pregunta
  al job real si podría mandar; si no podría, aborta.
- **`desactivar`** borra esa clave. La promoción sigue viva para quien ya
  recibió el código. Con `--tambien-codigo` también se desactiva.
- **`estado`** muestra la tienda, el horario, la promoción, lo que haría el job
  en ese momento y cuántos envíos lleva.

**Orden:** primero el despliegue (trae la 136 y el job) y después `activar`. El
script se niega a encender si falta la 136.

## Pruebas

- `test/fase-descuento-tras-cierre.mjs` cubre la política. Es pura, sin base.
- `test/fase-descuento-tras-cierre-db.mjs` corre el job real contra Postgres
  local.
