# Selección de producto entre mensajes — 28 sep 2026

## Incidente y alcance

Build observado: `00e82ef1b4b28ae5885ff1eaddc3c01840d5f55f`.
Conversación de prueba terminada en 9919, ciclo `r256`:

- «Quiero unos chilaquiles» se procesó en un turno sin crear renglón ni
  selección pendiente. La redacción fue sustituida por `producto_no_publicado`.
- «Serían verdes» y «Con pollo» llegaron durante ese turno y se atendieron
  juntos después. El modelo veía el historial; el reconciliador solo recibió
  este lote como evidencia y rechazó agregar el producto. Terminó en humano.

La traza no conserva la prosa descartada ni qué nombre oculto la disparó;
no se atribuye ese detalle a un producto concreto. No fue una falla de Edge.
La corrección anterior de añadir salsa a un plato existente no cubría esta
selección inicial, cuando el carrito aún está vacío.

## Corrección

`seleccionDeProducto.js` deriva una selección de la solicitud literal del
cliente y la carta publicada, antes de consultar al modelo. Persiste dentro
del único `estado.pendiente`: ciclo, solicitud, cantidad y candidatos.
No incorpora el historial completo como permiso ni convierte respuestas o
búsquedas del modelo en autorización.

Las preferencias explícitas del siguiente mensaje vuelven a resolver los
candidatos contra la carta vigente. El ejecutor revalida identidad, cantidad y
opciones exactas; usa el reconciliador y el libro transaccional existentes y
consume la selección únicamente después de aplicar la adición. Una llamada
normal del modelo no recibe este permiso. Los mensajes anteriores al acuse
pueden aportar preferencias, pero no aceptar una oferta ni confirmar un pedido.

No se amplía la gramática a consultas, condiciones, negaciones, dos productos
en una frase ni cantidades ambiguas. Una intención distinta abandona la
selección; no se recupera después desde el historial. No se cambia recepción
de WhatsApp, precios, pagos, impresión ni esquema SQL.

## Verificación

- `scripts/check-seleccion-fragmentada.mjs`: 18/18. Tres recorridos completos
  (preferencias separadas, juntas y en orden inverso), recarga JSON entre turnos,
  mensaje anterior al acuse, cantidad ligada al producto, consumo único,
  condiciones/consultas rechazadas, ciclo nuevo, terminales e incertidumbre.
- Integrado en `predeploy-check-incidentes`; `npm run test:incident` verde.
- Corrección de salsa existente: 42/42; herramientas 66/66; replay 26/26,
  cero invariantes críticas rotas. Prompt coherente 10/10, ciclos, emisión,
  ciclo terminal 12/12 y `git diff --check` verdes.
- Catálogo publicado real (76 productos) leído mediante el cargador de Xabor
  dentro de READ ONLY, finalizado con ROLLBACK. Luego tres conversaciones
  completas fragmentadas con red bloqueada, sin modelo y confirmación simulada.
- `test/fase-outbox-entrega-db.mjs`: 25/25 en Postgres desechable; reintentos
  del despachador, rechazo en línea, entrega incierta y carreras de emisores.
- Canario abierto y cerrado: verdes con Meta/Anthropic locales.
- Gate financiero y gate de producción consultados en READ ONLY: 12/12,
  cero fallos. Bot de Obispado apagado; conversación r256 intacta.

La prueba de presupuesto agotado ahora usa un artículo explícito en lugar de
«agrega un taco»: esa familia genérica se resuelve por selección sin llamar al
modelo. Se conservan las aserciones de herramienta inválida y escalación.

## E2E y límites

`test/fase-seleccion-fragmentada-webhook.mjs` usa dos servidores reales, una
base local cuyo nombre debe comenzar por `test_fragmentada_`, y Meta/Anthropic
simulados. Requiere `NODE_OPTIONS=--import=./test/red-solo-local.mjs`, heredado
por los procesos hijos para bloquear toda red externa.

Retiene la primera respuesta en el transporte, ingresa preferencias y
reentregas por el otro servidor, detiene un proceso y continúa con persistencia
real hasta confirmar. Comprueba una sola línea, total $205, pedido único,
historial y eco deduplicados. No ejecutar otras suites con servidores y mocks
distintos sobre esa misma base: sus workers compiten por las mismas colas.

Durante la preparación se corrigieron problemas del fixture: dependencias
locales incompletas, acuses de lectura de Meta, identidad única de wamids
simulados, efectivo no habilitado en el negocio sintético y colisión entre
suites compartiendo base. No se relajó ninguna aserción del pedido.

El rechazo del envío EN LÍNEA pasa a humano por política vigente; no se afirma
que se reintente. Sus pruebas y las del despachador se verifican por separado.
No hay pruebas reales contra Meta, cobros ni tickets físicos en esta entrega.

## Operación

Desplegar no significa activar. Mantener apagado el bot y conservar la
conversación con su evidencia; no resetearla con esta tarea. Para una prueba
real posterior se necesita reanudación controlada autorizada. Al revertir a un
build anterior, revisar los pendientes `elegir_producto` nuevos: el esquema
anterior no reconoce este tipo y no debe reinterpretarse como aceptación.

E2E final aprobado en `test_fragmentada_final_20260928`: siete salidas únicas,
una sola línea y un pedido local de $205; cero llamadas al modelo y cero efectos
externos. Base conservada para auditoría. Estado: listo para publicación
autorizada manteniendo el bot apagado y sin reiniciar conversación.
