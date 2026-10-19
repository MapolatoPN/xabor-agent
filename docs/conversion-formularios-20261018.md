# Conversión de formularios de WhatsApp — 18 de octubre de 2026

Implementación local, pendiente de revisión e integración. No se ejecutaron push,
deploy, cambios de catálogo ni activaciones en producción.

## Comportamiento preparado

1. Tras un menú en imágenes o su alternativa textual vigente, el mismo mensaje
   continúa al router y ofrece el formulario nativo con «Ordenar ahora». Conserva
   las barreras de horario, revisión humana, sucursal y deduplicación. No se genera
   una orden ni se delega la redacción al modelo por pedir el menú.
2. Una renuncia gratuita y única a extras, complementos, fruta extra o flores
   queda seleccionada inicialmente. No se eligen automáticamente salsa, proteína,
   leche, endulzante, tamaño ni extras con cargo. No se cambia el catálogo.
3. Un pedido escrito puede producir una propuesta de borrador de `tienda_v1`.
   El modelo tiene una única herramienta de extracción, esquema estricto y un
   límite de cuatro segundos. El servidor exige producto, cantidad y opciones
   explícitos, respaldados por el mensaje y el catálogo publicado. Lo ambiguo,
   negaciones y notas se dejan para la revisión del cliente. Un fallo del modelo
   conserva el formulario disponible.
4. Un formulario con avance conserva su borrador compatible al reenviarse, con
   la misma foto del catálogo y carrito. Abrir uno vacío
   permite precargar después el primer pedido escrito; vaciar uno ya editado no
   autoriza a reemplazarlo. El pedido comercial solo cambia al recibir el cierre
   nativo válido. El resumen todavía requiere confirmación del cliente.
5. «Repetir mi pedido» aparece en el menú de inicio y se reconoce como solicitud
   explícita. Consulta el último pedido entregado de los últimos 90 días del
   mismo negocio y teléfono. Copia productos y cantidades con precio vigente;
   preparación, notas, entrega, pago y programación se eligen de nuevo. Si falta
   un producto o la cantidad excede el contrato, ofrece elegir el pedido completo
   en el formulario. Nunca recupera pedidos de otra sucursal o cliente.
6. La actividad distingue MENU, CATEGORIA, PERSONALIZAR, CARRITO, EDITAR, ENTREGA,
   DIRECCION, TACOS y FINAL. El panel muestra el último paso observado y sugiere
   ayuda ante una incidencia pendiente o diez minutos sin avance. No afirma
   presencia en vivo ni abandono. El operador usa «Ayudar con el formulario».
7. El informe agregado deduplica reenvíos por ciclo de compra y separa actividad,
   cierre del formulario, respuesta aplicada, pedido registrado y pago confirmado.
   No interpreta una imagen de comprobante como dinero recibido.

## Interruptor y requisitos de integración futura

- `whatsapp_formulario_conversion_v1=true`, por negocio, habilita las mejoras.
  Ausencia o cualquier otro valor conserva el comportamiento anterior.
- Precarga, repetición y omisiones de extras requieren `tienda_v1` ya configurada;
  también deben estar completos el modo formulario/recepcionista y sus controles
  existentes. Esta implementación no activa esos servicios ni publica otro Flow.
- El detalle de pantallas requiere además
  `whatsapp_trazabilidad_formularios_v1=true`. La migración 118 agrega una columna
  nullable y está incorporada al runner de predeploy. No reconstruye pantallas
  históricas ni enciende banderas. Una pérdida de telemetría no invalida el pedido.
- Para revertir, apagar la bandera. El avance existente continúa siendo válido;
  conservar la columna de telemetría evita perder la evidencia nueva.
- La coincidencia de historial para repetir es deliberadamente exacta por
  teléfono; un pedido antiguo guardado con otra representación no se incorpora.

No se cambió ninguna bandera de los negocios reales. Antes de activar después
de un despliegue autorizado: revisar con teléfonos de prueba la precarga y el
menú real de cada sucursal, y comprobar la disponibilidad física de productos.

## Medición y operación

El comando de solo lectura, con fechas locales y `hasta` exclusivo, es:

```powershell
node scripts/analizar-formularios.mjs --negocio <slug> --desde 2026-10-19 --hasta 2026-10-26
```

El reporte incluye pedidos con identidad canónica del ciclo, pagos con la marca
durable `pago_confirmado`, atención humana y pedido manual posterior. Este último
es una coincidencia por cliente y periodo; no demuestra que se recapturó el mismo
pedido. El informe usa estados actuales y no reconstruye sus modificaciones
posteriores al periodo. Sin trazabilidad, «sin apertura observada» no significa
que nadie abrió el formulario. El detalle antiguo permanece en TIENDA.

La meta inicial de 70% es un objetivo por validar, no una mejora ya observada.
Medir una semana por sucursal con la misma unidad y fechas; el histórico de 52%
se calculó por conversación y no se compara directamente con ciclos de compra.
Revisar conjuntamente registros, pagos y ayuda humana, además de las pantallas
pendientes. Un cierre FINAL por sí solo no acredita un pedido registrado.

El personal mantiene agotados y métodos de pago al abrir y durante el servicio.
El servidor conserva la validación final de disponibilidad y precios. La función
de ayuda permite resolver dudas sin interrumpir la captura; una toma manual sigue
siendo una decisión explícita del operador. No se programaron mensajes automáticos
de insistencia a clientes.

## Verificación local

PostgreSQL aislado `test_botones_conversion_20261018`; red externa bloqueada por
`test/red-solo-local.mjs`. Proveedor IA y transporte Meta simulados. Se verificaron
precarga hasta el resumen, opciones requeridas, persistencia, duplicados, botón
de repetición, aislamiento por cliente/negocio, productos retirados, fallo de
proveedor, reversa de bandera y reporte READ ONLY. La prueba HTTP verifica menú
seguido de Flow, menú textual vigente y comportamiento con la bandera apagada.

También se ejecutaron las regresiones de incidentes, recepción (47 casos), tienda
(15 casos), panel y su vista a 1200/390/320 px. La verificación visual del panel
es aislada y no sustituye la prueba de dispositivos reales en la activación.

## Comprobaciones previas al despliegue

Se integró la versión productiva `1db56a7`, conservando su checkout de Clip.
La prueba contra el proveedor real detectó que el esquema estricto no admite
`maxItems`: se retiraron los límites del esquema enviado al proveedor y se
conservaron obligatorios en la validación Zod del servidor. La extracción de
prueba con los catálogos vigentes de ambas sucursales respondió correctamente,
sin persistir conversaciones ni enviar WhatsApp.

La regresión de Clip pasó 42 casos usando su SDK oficial servido desde una copia
local descargada por HTTPS; pedidos, proveedor de cobro y retornos se simularon.
Las barreras financiera y de datos productivos se comprobaron en READ ONLY.
