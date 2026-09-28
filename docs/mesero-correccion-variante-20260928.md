# Corrección de presentación del pedido — 28 sep 2026

Estado: segunda corrección DESPLEGADA y conversación de prueba REINICIADA.
Bot general de Obispado APAGADO; falta aceptación real por WhatsApp.
Rama: `fix/mesero-correccion-variante`.
Base: `3d99bc71ac59d7052527ad74aad5a6db98779690`.

## Segunda incidencia: petición cortés de añadir salsa

El primer despliegue NO cerró el caso. En el ciclo `r246`, el mensaje real
«Me puedes agregar salsa verde? \n\nSerían Rojos y verdes» no modificó el
plato rojo con pollo. El bot preguntó la modalidad; solo corrigió al repetirse
las dos salsas. La comprobación local anterior aceptaba incorrectamente que
«Le podrías agregar chipotle?» fuera una consulta sin mutación.

- Se reconoce la petición aditiva explícita, aunque lleve interrogación, solo
  cuando su objeto completo son opciones del catálogo. Consultas de precio,
  capacidad, negaciones, alternativas, sustituciones y mensajes con otra
  petición no se convierten en una adición automática.
- Se forma una unión estructurada con las elecciones persistidas. La carta
  decide la presentación y el precio; la operación existente y el
  reconciliador aplican el cambio atómicamente. No se elige por foco entre
  dos platos y repetir la petición no duplica ni reemplaza el plato.
- Un grupo explícito delimita la elección: «salsa verde» no selecciona las
  proteínas «… en Salsa». Tampoco se confunde con productos que solo
  comparten una palabra, como «Jugo verde grande».
- La respuesta canónica enseña el cambio antes de la siguiente pregunta,
  sin delegar de nuevo al modelo una petición que ya quedó resuelta.

Regresión ampliada: **42/42**. La primera ejecución de los 40 casos previos
a la ampliación final falló en 9 casos antes de la corrección. Se prueban
los mensajes exactos, la adición de una sola salsa sin repetir la anterior,
otras intenciones, ambigüedad, agotados, reintentos y dos recorridos hasta una
confirmación simulada única, recargando el estado entre turnos.

Además se leyó la carta publicada real de Obispado (76 productos) usando el
cargador del servicio dentro de `BEGIN READ ONLY` / `ROLLBACK`. Después de
cerrar la conexión se bloqueó la red: el motor local pasó los tres mensajes
roja/verde y suiza/chipotle, dos veces cada uno, conservando proteína,
guarniciones y un solo plato de $205. Esta prueba detectó las colisiones
léxicas de la carta real; se incorporaron a la regresión. No fue una prueba
real por WhatsApp ni se enviaron mensajes, pagos o impresiones.

Pasaron `npm run test:incident` (gate obligatorio y canónico 19/19),
`mesero:tools` 66/66, `mesero:replay` 26/26 y `git diff --check`.
Las suites focalizadas de prompt, ciclos, emisión, terminal, catálogo,
variantes y acumulación también pasaron durante la corrección.

El dueño autorizó corregir, desplegar y reiniciar su conversación. La lectura
previa encontró el bot general APAGADO, borrador sin folio, sin pedido abierto,
pago no terminal ni salida pendiente. El reinicio se hará solo sobre su
borrador y sesión legacy, con bloqueo de conversación, comprobación de la
última entrada y respaldo del estado anterior en auditoría; no borrará
historial ni cambiará el interruptor del bot. Falta registrar el resultado
del despliegue y del reinicio antes de declararlos completados. Ambos se
completaron después de esa lectura, con el resultado siguiente.

### Resultado verificado de la segunda publicación

- Commit publicado: `00e82ef1b4b28ae5885ff1eaddc3c01840d5f55f`.
- Push fast-forward desde `3eb7f38`; no hubo despliegue automático. Se
  verificó el origen configurado y se lanzó una sola publicación explícita.
- Railway: `f3a78c7e-c9f6-48bc-8820-39e9f6d01e80`, `SUCCESS`, SHA correcto.
  El predeploy volvió a ejecutar **42/42**, gate financiero OK, barrera de
  datos **12 correctas / 0 fallos** y todos los pasos completados.
- `/health`: HTTP 200, `status=ok`, `listo=true`, después de verificar el SHA.
- Reinicio autorizado del teléfono del dueño terminado en …9919:
  ciclo `r246` → `r256`, carrito vacío y sin folio. Se comprobó bajo bloqueo
  que no hubiera nuevas entradas después de 2577, pedidos abiertos, pagos
  no terminales, efectos de confirmación ni salidas pendientes.
- Se actualizó el borrador del agente y se retiró una sesión legacy de ese
  teléfono. Ambos estados anteriores quedaron respaldados de forma atómica
  en auditoría `db490c12-68d4-49fc-a112-eaae97e1f6fb`; son recuperables.
  Mensajes, operaciones, pedidos y pagos históricos no se borraron.
- El bot general continúa **apagado**, sin modificar variables, configuración
  del canario ni pausa de otras conversaciones. No se envió mensaje,
  impresión ni pago real. No se hizo una conversación real posterior al deploy.
- Las suites focalizadas se repitieron sobre el commit publicado y pasaron.

## Despliegue autorizado — 28 sep 2026

- Corrección funcional: `73ca09385a7061b423fe50a82b8298db6b675a86`.
- Commit publicado: `3eb7f38a6ac99c179ae5ef506938f7cc58f78efb`.
  Incluye el ajuste de empaquetado de la regresión, sin cambiar su lógica.
- Push fast-forward a `prod/mesero-shadow-v3`; no se creó build automático.
  Se verificó la rama configurada y se ejecutó una sola vez el despliegue
  explícito desde el origen, sin cambiar variables ni configuración.
- Railway: `a68b3635-5be9-42d2-bb9c-46d87dbf54ce`, `SUCCESS`, con el SHA
  publicado; el deployment anterior quedó `REMOVED`.
- El predeploy en Railway ejecutó la regresión **22/22**, el gate financiero
  y la barrera de datos **12 comprobaciones, 0 fallos**; runner completado.
- `https://xabor.mx/health`: HTTP 200, `status=ok`, `listo=true`, comprobado
  a las `2026-09-28T11:37:48Z`. La identidad se verificó en Railway, no se
  dedujo del HTTP 200.
- Sin cambios manuales de datos productivos, interruptores del bot o pausa de
  conversación. El runner habitual de migraciones se ejecutó en el predeploy.
  No se enviaron mensajes, pagos ni impresiones de prueba reales.
- El borrador duplicado anterior NO se reparó ni se reanudó. La validación
  real requiere preparar un ciclo limpio con autorización separada.

## Incidente y alcance

El cliente pidió chilaquiles suizos con pollo, frijoles y papas a la mexicana;
aclaró frijoles con chorizo y después pidió Suiza y Chipotle. La presentación
Mixtos existe en la carta. La conversación ignoró esa corrección, repitió el
resumen y acabó con Sencillos y Mixtos en el borrador, sin folio.

La reclasificación concatenaba las elecciones guardadas como texto y volvía a
interpretarlas: frijolitos con chorizo + papas a la mexicana también sostenían
«papas con chorizo». Además dependía del foco de la última pregunta y de aliases
explícitos de variante. La recuperación quitar+agregar podía aplicar solo la
segunda mitad.

## Cambio

- La presentación se resuelve con el mensaje nuevo. Las elecciones anteriores
  se cotejan como estructura exacta contra cada candidato, sin volverlas texto.
- Una línea nombrada inequívocamente puede corregirse aunque el foco sea el
  licuado. Varias líneas posibles no autorizan escoger una por el modelo.
- Se reutiliza `modificar_linea(reclasificar: true)`: conserva lid, cantidad,
  notas y elecciones. Identidad y elecciones nuevas se aplican juntas y se
  restauran si el reconciliador rechaza parte del cambio.
- La herramienta de agregar bloquea usar una corrección como otra unidad de
  una línea anterior. Las adiciones explícitas y las cantidades de un mismo
  turno inicial conservan sus validaciones habituales.
- La respuesta derivada muestra la presentación, opciones y precio leídos del
  carrito. Una corrección posterior al resumen cambia su huella; no confirma.
- No hay nombres de platillos ni precios de Mapolato en la lógica nueva.

## Evidencia y límites

La primera versión de la regresión tenía 15 casos: en la base fallaron 6 y
pasaron 9. La suite ampliada tiene 22 casos y se incorpora al gate obligatorio.
Incluye el recorrido desde el pedido inicial, consulta de Chipotle, ambas
salsas, licuado, entrega, pago y confirmación; recarga JSON del estado entre
turnos. Comprueba dos líneas, total $295 y un solo registro simulado. También
prueba corrección con otro producto en foco, corrección después del resumen,
intento de quitar+agregar, límites, negaciones, ambigüedad y otra carta.

La implementación de esta regresión vive en `scripts/check-correccion-variante.mjs`
para incluirse en Docker; la entrada de `test/` solo la importa. El gate no
depende de la carpeta `test/`, que la imagen productiva excluye.

Verificación local con conexiones de red bloqueadas y DATABASE_URL ficticia
en loopback; sin credenciales productivas:

- `npm run test:incident` (incluye `predeploy-check-incidentes`).
- `npm run mesero:tools`: 66/66.
- `npm run mesero:replay`: 26/26, cero invariantes críticas rotas.
- `test/fase-agente-correccion-variante.mjs`: 22/22.
- Suites de prompt coherente (10), ciclos, emisión, ciclo terminal (12),
  catálogo canónico (26), variantes (14) y acumulación (20).
- `git diff --check` y comprobaciones de sintaxis.

Esto verifica el motor y sus efectos simulados; NO es una prueba de WhatsApp
real, ni un E2E nuevo con Postgres/webhook/outbox/impresora. No se ejecutó el
barrido completo del repositorio. No se modificó producción, no se enviaron
mensajes ni se reanudó la conversación del cliente durante la prueba local.
Los borradores que ya
quedaron afectados no se reparan automáticamente con este cambio.

El despliegue se autorizó por separado y se verificó como se indica arriba.
Pendiente: prueba controlada en un ciclo limpio; no reutilizar ni confirmar
el borrador duplicado del incidente.
