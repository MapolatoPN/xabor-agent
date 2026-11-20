# Días cerrados (festivos)

Pedido de Mario (20-nov-2026). El lunes 16 de noviembre Acuña cerró por
festivo y mantenimiento. El panel no tenía dónde decirlo, así que desmarcaron
el lunes en el horario de la semana. Pasaron dos cosas:

- El domingo el bot les dijo a unas 12 personas «abrimos mañana a las 7:30».
- Al volver a marcar el lunes, el panel le puso 9:00–20:00 (su valor fijo), no
  las 7:30–14:00 de los demás días.

## Dónde está

**Configuración → Horarios, operación y entregas**, debajo de «Horarios»:
**Días cerrados (festivos)**. Se guarda con el mismo botón «Guardar horarios y
reglas».

Por cada día:

- **Fecha.**
- **Cerrado todo el día** o **Cierra temprano** (con la hora de cierre).
- **Motivo** (opcional, máximo 80 letras). Sin motivo se guarda
  «cierre especial».

Los días ya guardados que pasaron hace más de 30 se quitan solos al guardar.
Un día que se acaba de poner (o al que se le cambió la fecha) no puede ser de
una fecha pasada ni estar a más de dos años: casi siempre es un error de dedo
en el año, y el panel lo avisa en su renglón en vez de quitarlo sin decir nada.

## Qué hace

No cambia el horario de la semana. Ese día:

- **El bot** sabe que no abren (o que cierran temprano) y, cuando dice cuándo
  vuelven a abrir, se salta ese día. Con el lunes 16 marcado, el domingo 15
  habría dicho «abrimos el martes a las 7:30».
- **La tienda en línea** no recibe pedidos ni deja agendar para esa fecha (o
  después de la hora de cierre temprano).
- **El descuento tras cierre** cuenta a quien escribió ese día en horario
  habitual como «escribió con el negocio cerrado».

Todo eso ya leía `reglas_atencion.cierres_especiales` a través de
`src/services/horarioSemanal.js`. Lo nuevo es la pantalla.

## Al volver a marcar un día de la semana

Si un día estaba cerrado y se vuelve a marcar, el panel propone el horario más
repetido entre los días que abren (en Acuña, 7:30–14:00). Solo si no abre
ningún día propone 9:00–20:00.

## Formato

En `configuracion.reglas_atencion` (JSON por negocio):

```json
"cierres_especiales": [
  { "fecha": "2026-11-16", "motivo": "Día festivo" },
  { "fecha": "2026-12-24", "motivo": "Nochebuena", "hora_cierre": "12:00" }
]
```

Sin `hora_cierre`, ese día no se abre.

## Revisión al guardar

`PUT /api/config` revisa la lista con `validarCierresEspeciales`
(`src/services/cierresEspeciales.js`) y responde 400 con un texto claro si
algo está mal:

- una fecha que no existe;
- el mismo día dos veces;
- una hora de cierre imposible o 00:00;
- un motivo que no es texto o pasa de 80 letras;
- más de 60 días.

A propósito **no** está en `validarEstructuraReglas` (`src/agent/prompts.js`).
Esa la usa también el bot al **leer** las reglas: una regla guardada antes que
no pasara haría que el bot cayera a los horarios por omisión en lugar de los
del negocio.

## Archivos

- `panel/cierres-especiales.js`: la lista y el horario sugerido. Se carga en
  `index.html` con su huella (`?v=` = primeros 8 del sha256).
- `panel/index.html`: `renderReglasForm` (sección y horario sugerido) y
  `guardarReglas` (lee la lista; con error, no guarda).
- `src/services/cierresEspeciales.js`: la revisión del servidor.
- `src/server.js`: `PUT /api/config` la llama.

## Pruebas

`node test/fase-cierres-especiales-panel.mjs` cubre:

- lo puro;
- la compatibilidad con el bot, la tienda y el descuento, con el caso real del
  lunes 16;
- la revisión del servidor;
- la pantalla, con Puppeteer;
- el cableado;
- la ruta real con base `test_botones_*`.

Con `SIN_BASE=1` se omite la ruta real.
