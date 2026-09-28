# Botones: integración y validación local sobre producción — 28 sep 2026

## Resultado y alcance

Candidata: `integracion/botones-vigente-20260928`, en un worktree propio.
Integra confirmación, ofertas, elecciones simples y múltiples, y la corrección
de continuidad del licuado. **La integración local está terminada; no está
desplegada ni habilitada para WhatsApp real.**

La base es `ab37545110dadff131218ace9831dab7e680a7cc`, verificada mediante
`git fetch` y al terminar mediante `git ls-remote` de `prod/mesero-shadow-v3`.
Esto verifica Git, no el build que está ejecutando Railway: no se consultó ni
modificó Railway en esta tarea.

Commits locales:

- `a123359`: merge de botones `30bb71a` sobre `ab37545`.
- `f45a99a`: incorporación con trazabilidad de `efac6de` (licuado).
- `71efaff`: corrección de productos distintos y empaquetado del gate.

La integración conserva los cambios de panel/caja y las migraciones 101 y 102.
El único conflicto del merge fue la lista del runner: se conservan 101, 102,
103 y 104, en ese orden. Panel, `orderManager.js`, `database.js`,
`restauranteService.js` y las migraciones 101/102 quedan sin diferencias frente
a la base. Las modificaciones de transporte protegido son las heredadas de la
implementación de botones, no una reescritura adicional durante esta integración.

## Los cinco fallos generales sí se corrigieron

La candidata inicial reprodujo **29/34** en `fase-pedido-canonico-db.mjs`:
fallaban 18, 20, 23, 23b y 25. Después de la corrección pasa **34/34**, sin
modificar el fixture ni las expectativas de esa suite.

La búsqueda de productos coincidía por cualquier palabra compartida. En el
fixture, `CAN Waffle` y `CAN Café Americano` compartían `CAN`. La continuidad
usaba ese resultado de búsqueda como prueba de que eran variantes del mismo
producto: pedir un café podía reemplazar el waffle o bloquear su adición.
Además, `agrégale` no estaba entre las formas reconocidas como adición.

La búsqueda ahora solo descubre candidatos. La reclasificación automática
exige también grupos de opciones compatibles; sin esa estructura conserva
el producto y deja la sustitución al flujo explícito. Se ampliaron las formas
aditivas reconocidas. No se cambió la búsqueda general del catálogo ni se
añadieron nombres de negocio al motor.

`scripts/check-productos-distintos.mjs` reproduce el defecto y comprueba diez
combinaciones de dos prefijos con cinco mensajes. Falló antes del arreglo y
ahora pasa **10/10**: café añadido y waffle original intacto. Forma parte del
gate obligatorio. Este resultado no certifica cualquier intención imaginable.

## Corrección del artefacto de despliegue

El gate de elecciones llamaba a un archivo de `test/`, pero `.dockerignore`
excluye esa carpeta. Se trasladó el contrato puro a
`scripts/contrato-elecciones-interactivas.mjs`; la entrada de `test/` lo importa
y el gate lo ejecuta en un proceso separado, como antes.

Se construyó el Dockerfile real, instalando las dependencias Linux mediante
`npm ci --omit=dev`. Imagen local:
`xabor-botones-integracion-local:20260928`.
ID reportado por Docker: `sha256:469e1a3c113d7ef90da71b53d3932059fa1894375d063ca8199300e13623894f`.

El gate pasó dentro de esa imagen con `--network none`. También se comprobó
que `/app/test` no existe y que el contrato está empaquetado en `/app/scripts`.
Un intento anterior con dependencias Windows montadas en Linux falló por
`sharp`; fue un fallo de entorno, no un resultado aprobado. La comprobación
válida es la imagen construida con sus propias dependencias Linux.

## Evidencia de pruebas

PostgreSQL local 18.4 (`pg-candidato`, puerto 55473), bases sintéticas
desechables y Meta/Anthropic simulados. Las pruebas de aplicación usaron
`NODE_OPTIONS=--import=./test/red-solo-local.mjs` para bloquear red externa.
La construcción de la imagen sí descargó dependencias; la ejecución del gate
dentro de ella no tuvo red. No se usaron credenciales productivas.

| Prueba | Resultado de la candidata |
|---|---|
| `npm run test:incident` | OK, incluido gate y canónico puro 19/19 |
| Gate dentro de la imagen sin `test/` y sin red | OK |
| `fase-pedido-canonico-db.mjs` | 34/34, antes 29/34 |
| Regresión productos distintos | 10/10 |
| Herramientas / replay | 66/66 y 26/26; cero invariantes críticas rotas |
| Elecciones interactivas puras | 14/14 |
| Ofertas / persistencia de botones en PostgreSQL | 6/6 y 27/27 |
| `fase-botones-mixtos-webhook.mjs` | OK, dos servidores, reinicio, reentregas y doble toque |
| `fase-botones-webhook.mjs` | OK, confirmación anterior conservada |
| `fase-continuidad-licuado-webhook.mjs` | OK, 13 respuestas, dos líneas y una confirmación |
| Outbox / continuidad WhatsApp en PostgreSQL | 25/25 y 13/13 |
| Canario horario abierto / cerrado | Ambos OK, incluido aislamiento del teléfono |
| Ciclos / emisión / ciclo terminal / coherencia del prompt | OK; terminal 12/12, prompt 10/10 |
| Cancelaciones autorizadas / tarjeta y caja | 22/22 y 20/20 |
| `git diff --check` | OK |

Mixtos: conserva roja + verde tras reiniciar los servidores; después prueba
sustitución explícita por chipotle y adición de roja. Termina salsas con
`Listo con estas`, elige proteína y dos guarniciones, entrega y pago, y confirma
un solo pedido sintético de $145. Los toques no llaman al modelo.

Licuado: después del reinicio conserva la pregunta, aclara sabor frente a
fruta extra y confirma un solo pedido sintético de $265, sin escalado ni errores
ocultos del proveedor. Estos importes son fixtures, no precios de Obispado.

Bases conservadas para inspección local:

- `test_botones_integracion_canonico_20260928`
- `test_botones_integracion_e2e_20260928`
- `test_licuado_integracion_20260928`
- `test_botones_integracion_aux_20260928`
- `test_botones_integracion_canario_20260928`
- `test_botones_integracion_panel_20260928`

Los E2E se ejecutaron separados de las bases que conservan outbox pendiente o
incierto. No arrancar despachadores sobre esas bases como si fueran vacías.
Las migraciones 101–104 se aplicaron solo en los clones de prueba.

Los logs de esta ejecución están en `%TEMP%`, con prefijo
`botones-integracion-`: `canonico.log` (antes), `canonico-corregido.log`
(después), `gate.log`, `gate-imagen.log`, `build.log`, `tools.log`,
`replay.log`, `ofertas.log`, `persistencia.log`, `outbox.log`,
`cancelaciones.log` y `panel.log`. Son evidencia local temporal, no artefactos
guardados en Git. Los comandos y contratos reproducibles sí están versionados.

## Qué sigue antes de probar desde el teléfono

1. Revisar el diff de esta candidata contra `ab37545`. Si producción avanzó,
   integrar ese avance y repetir lo afectado antes de publicar.
2. Obtener autorización separada de despliegue y canario limitado. Esta tarea
   no incluyó push, despliegue, activación ni reset de conversación.
3. Verificar el catálogo real: grupos, disponibilidad, mínimos/máximos y
   precios; verificar requisitos operativos pendientes, incluida la versión
   física del Edge de caja si sigue siendo una condición del despliegue. Esta
   integración no comprobó la PC de Obispado.
4. Aplicar las migraciones mediante el runner normal y verificar el commit
   reportado por Railway. `/health` por sí solo no acredita el build.
5. Activar únicamente el canario autorizado y los interruptores necesarios,
   con restricción efectiva al teléfono de prueba en sus formas 52 y 521,
   sin abrir atención al resto de clientes. Respetar bot apagado y humano.
6. Probar la visualización en Meta real: dos salsas, dos guarniciones,
   `Listo con estas`, corrección por texto y botón viejo. Antes de confirmar
   un pedido real, acordar cómo impedir cobros e impresiones involuntarios.

Interruptores requeridos: `WHATSAPP_INTERACTIVOS`,
`whatsapp_interactivos_v1` y `whatsapp_interactivos_elecciones_v1`. Las nuevas
funciones siguen apagadas por omisión; no se cambió configuración productiva.
Para retirar botones, usar sus interruptores manteniendo tablas y lectura de
grupos abiertos; no volver a un binario que desconozca ese estado.

**No hubo mensajes, cobros, impresiones ni escrituras de producción.** Las
pruebas locales comprueban el contrato y la continuidad; la visualización real
en WhatsApp queda pendiente de la prueba controlada autorizada.
