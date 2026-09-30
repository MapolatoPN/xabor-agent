# Seguimiento de la beta — 30 septiembre 2026

Trabajo posterior a «continúa trabajando». Base local `ed203e6`; producción
verificada en Railway: `547d160`, deployment
`cd69395f-20b5-4e5c-acff-0e1388edcb04`, SUCCESS.

## Corrección implementada: pregunta y cambio en el mismo mensaje

Se reprodujo una divergencia entre dos reglas de clasificación:

- `politicaDelTurno` reconocía «añádeme», «ponle», «para recoger» y «pago en».
- La beta mantenía una lista más corta y, al detectar además una pregunta de
  horario/ubicación, forzaba solo lectura. El modelo no podía proponer el cambio.
- «Elimina el taco y dime cuánto cuesta el envío» también quedaba como
  consulta en la regla general.
- «Quiero saber a qué hora cierran», en cambio, no recibía la protección de
  consulta de la beta por la palabra «quiero», aunque solo pedía información.

Ambas rutas comparten ahora `contieneDecisionDePedido`, incluida la exclusión
de cortesía «quiero/quisiera saber/consultar/preguntar». Se reconocen las
solicitudes de eliminar/borrar en esa señal común. No es una autorización:
producto, cantidad, renglón, opciones, pago y confirmación siguen pasando por
los validadores de Xabor. No se interpreta el texto de la respuesta del modelo
para reconstruir el pedido ni se ejecuta una acción directamente desde esta regla.

La política compartida también se usa fuera de la beta: el ajuste de
eliminar/borrar no está detrás de su flag. Por eso se repitieron las suites
generales de herramientas, replay y el gate, además de las de beta.

### Evidencia antes/después

La nueva prueba pura falló antes de la corrección porque «Añádeme dos tacos
y dime a qué hora cierran» se clasificaba como consulta. La prueba SQL local
también falló: el carrito conservaba 1 café cuando debía terminar con 3.

Con la corrección, en Postgres aislado:

1. Un café previo + «Añádeme 2 cafés americanos y dime a qué hora cierran»
   termina con 3 unidades, sin folio ni confirmación.
2. Después, «Quiero saber a qué hora cierran» conserva ese carrito aunque el
   modelo simulado intente agregar 8 unidades sin autorización.
3. La respuesta informativa conserva su contenido y ofrece «Continuar pedido».

No se afirma que la respuesta de un modelo real a toda frase compuesta esté
resuelta. Esta corrección evita perder la solicitud de cambio por clasificarla
solo como consulta; el formato de respuesta tras una mutación sigue siendo
el del estado canónico. Sigue pendiente probar la calidad conversacional real.

## Verificación final

- `npm run test:beta`: 7 grupos, verde.
- `test/fase-beta-hibrida-db.mjs`: 9/9, tanto Node 24/Windows como Node 20/Linux.
- `test/fase-beta-hibrida-webhook.mjs`: verde; firma, dos procesos, reinicio,
  deduplicación, prioridad del texto y barreras de atención.
- `npm run mesero:tools`: 66/66.
- `npm run mesero:replay`: 26/26, 0 invariantes críticas rotas.
- `npm run test:incident`: verde en Node 20/Linux; incluye gate obligatorio,
  continuidad y pedido canónico (19/19).
- Sintaxis de ambos módulos y `git diff --check`: verdes.

Pruebas SQL/HTTP únicamente en bases locales `test_botones_`, red externa
bloqueada. No se enviaron mensajes, pedidos, cobros ni tickets reales.

## Producción: solo lectura durante este seguimiento

Se verificaron maestro existente, solo-prueba activo, porcentaje 0, listas de
agente/Flows y beta limitadas al dueño, duplicación activa y catálogo nativo
apagado. No se cambiaron banderas ni pausas.

La consulta acotada al dueño y sus alias, con fecha inicial
`2026-09-30T10:14:20Z` (posterior al arranque registrado por Railway), devolvió
sin entradas, turnos ni salidas. No constituye una prueba real de WhatsApp.
No se leyó el texto de clientes ajenos ni se limpiaron conversaciones.

## Alertas de dependencias: clasificación inicial, no reparación

El build publicado reportó 18 alertas. `npm audit --omit=dev --json` local
reportó 16 (6 moderadas, 9 altas, 1 crítica). **No se repararon dos problemas**:
no se cambió ninguna dependencia ni el lockfile. No se equiparan los conteos
de ejecuciones/entornos distintos ni se presenta la auditoría como prueba de
explotabilidad en producción.

- **`tar@6.2.1`** llega por `pdfjs-dist → canvas` opcional →
  `@mapbox/node-pre-gyp → tar`. No se encontró importación directa de tar en
  `src`/`scripts`. El aviso crítico describe agotamiento de recursos al
  extraer archivos no confiables; falta completar el análisis del uso
  transitivo y de instalación, no se declara inocuo.
  [Aviso del mantenedor](https://github.com/isaacs/node-tar/security/advisories/GHSA-23hp-3jrh-7fpw).
- **`file-type@19.6.0`** sí se llama sobre archivos entrantes en
  `src/services/imagenes.js` y `documentos.js`, antes del rechazo por MIME.
  El aviso sobre bucle en ASF merece prioridad por esa superficie de entrada.
  Un límite de tamaño no demuestra por sí solo protección ante un bucle.
  [Aviso del mantenedor](https://github.com/sindresorhus/file-type/security/advisories/GHSA-5v7r-6r5c-r473).
- **`sharp@0.35.3`** se usa en imágenes y visión. El aviso corresponde a
  libheif; la recepción de imágenes permite JPEG/PNG/WebP, pero eso no
  demuestra cobertura de todos los caminos del decodificador. Revisar
  actualización compatible y regresiones de imágenes antes de integrar.
  [Aviso del mantenedor](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).
- **`adm-zip`** aparece en extracción de paquetes SAT; **Puppeteer** afecta
  otros recorridos de documentos. No se hicieron saltos de versión mayor ni
  `npm audit fix --force` como parte de un ajuste conversacional.

El aviso Meta 141006 previamente documentado no se resolvió ni se cambió
facturación. La prueba sigue requiriendo que el dueño inicie conversación.

## Siguiente paso

Revisar este diff local y aprobar su publicación antes de integrarlo. No
requiere migración, Flow nuevo ni cambios de configuración. En paralelo,
probar el formulario ya publicado desde el teléfono del dueño y registrar
resultado real. Priorizar una tarea separada de endurecimiento de recepción
de archivos y actualización de dependencias compatibles, con sus pruebas.

`STATUS_CODEX: CORRECCION_MENSAJES_MIXTOS_LOCAL_PROBADA_SIN_DEPLOY`
