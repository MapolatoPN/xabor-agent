# Corrección de presentación del pedido — 28 sep 2026

Estado: corrección local para revisión, NO desplegada.
Rama: `fix/mesero-correccion-variante`.
Base: `3d99bc71ac59d7052527ad74aad5a6db98779690`.

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
mensajes ni se reanudó la conversación del cliente. Los borradores que ya
quedaron afectados no se reparan automáticamente con este cambio.

Antes de publicar: revisar el diff contra la base, verificar integración y
autorizar el despliegue por separado. Después, prueba controlada en un ciclo
limpio; no reutilizar ni confirmar el borrador duplicado del incidente.
