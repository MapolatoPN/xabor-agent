# Menú principal de tres opciones para pedidos por formulario

El menú principal del modo formulario presenta, en este orden, **Ordenar ahora**, **Eventos y catering** y **Hablar con una persona**. Sustituye la presentación de cinco opciones que incluía Información y Facturación. Esta decisión actualiza el menú de cuatro opciones descrito en el plan comercial anterior.

## Recorridos

| Opción | Acción |
| --- | --- |
| Ordenar ahora | Abre el formulario vigente de platillos y personalización; el pedido se registra con su confirmación existente |
| Eventos y catering | Abre el formulario de solicitud de cotización; no confirma una reserva ni disponibilidad |
| Hablar con una persona | Transfiere al personal mediante el circuito existente y pausa la automatización |

La lista nativa conserva los valores internos de acción. Las preguntas y los controles contextuales de pedidos en curso conservan sus recorridos. Las elecciones válidas de menús enviados antes del cambio siguen reconocidas; la prueba de Facturación verifica esa continuidad después de activar el modo formulario.

El menú simplificado aplica cuando el modo formulario o recepcionista está vigente y tiene sus precondiciones completas. Los negocios sin ese modo conservan su menú anterior. No se modifican formularios publicados, catálogo, precios, registro de pedidos, credenciales ni banderas de activación.

## Base y alcance

Base: `a1bbab3f104e8a9f6b7983728bc46ec5eeae60bb`, identificada como despliegue activo de Railway al iniciar el trabajo el 9 de octubre de 2026. Rama aislada: `codex/menu-tres-opciones-20261009`.

La consulta de producción previa encontró el modo formulario para todos los clientes en Obispado y Acuña. El interruptor general estaba encendido en Obispado y apagado en Acuña. Publicar este cambio no activa Acuña. No se alteró esa configuración ni se enviaron mensajes reales.

## Validación

Node 22.23.3 en Docker, PostgreSQL desechable `test_botones_menu_20261009`, transporte y modelo simulados, conexiones externas bloqueadas y archivos del worktree montados en modo de solo lectura.

- `fase-ia-recepcion.mjs`: 189 casos pasados.
- `fase-ia-recepcion-db.mjs`: 43 casos pasados, incluidas las tres rutas reales del menú, pausa humana, solicitudes por formulario y compatibilidad con una opción antigua de Facturación.
- `check-inicio-mapo.mjs`: correcto; conserva las pruebas del menú anterior para negocios sin el modo y sus entradas protegidas.
- `check-modo-ia.mjs`: 12 grupos pasados.
- `git diff --check`: correcto.

La primera ejecución del contenedor omitió el montaje de `edge` y no inició la suite. Una expectativa antigua intentaba acceder a Facturación desde el nuevo menú y se adaptó para probar un menú emitido antes de activar el modo; la ejecución final pasó todos los casos. No se ejecutaron envíos a Meta, cobros ni impresión física.

## Riesgo y publicación

El riesgo principal es que una etiqueta quede ligada a otra acción o que un menú enviado previamente deje de funcionar. Las pruebas recorren pedido, eventos y persona por el adaptador, persistencia y transporte simulado. Los identificadores de acciones anteriores se conservan. No se cambian reglas de confirmación o pago.

Falta revisar el diff antes de integrar, comprobar nuevamente la base desplegada y autorizar la publicación. La apariencia en el teléfono y la entrega con Meta real requieren una comprobación posterior de alcance definido. Este cambio está preparado localmente; no está publicado.

## Disponibilidad solicitada en ambas sucursales

El propietario solicitó que los formularios estén disponibles en Obispado y Acuña. La revisión de Meta identificó que Acuña no tenía formularios propios y su configuración refería IDs de otra cuenta. El número de Acuña pertenece a su WABA, pero su registro de clave pública estaba vacío. La operación de reparación registra únicamente la clave pública derivada de la privada vigente y replica las definiciones ya publicadas de Obispado dentro de la cuenta propia de Acuña; no cambia la clave privada ni envía mensajes.

`scripts/replicar-flows-acuna-20261009.mjs` separa plan de solo lectura, preparación en Meta y corrección de IDs. Esta última requiere el bot apagado, guarda un respaldo y registra auditoría del propietario; no activa el bot. La activación se realiza después de comprobar los formularios y la disponibilidad del asistente mediante la función existente.

El gate de liberación bloqueó inicialmente `XAB-1440`. La consulta de solo lectura mostró un pedido programado futuro, con identidad durable y pago confirmado; no un pedido perdido. Se corrigió el gate para aceptar esa reserva pendiente sin exigirla en el tablero antes de su hora. Los pagos confirmados deben constar también en la reserva. Pedidos faltantes, vencidos, activados sin fila, cancelados con pago, de otro negocio o sin identidad siguen bloqueando.

La suite local `fase-gate-programados-db.mjs` pasó 13 casos con PostgreSQL y tablas temporales. El gate completo de producción, ejecutado en solo lectura con la corrección, pasó sus comprobaciones. No se modificó `XAB-1440`, su pago ni su programación.
