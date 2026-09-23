# Fase 3A — auditoría multicanal de promociones

Esta fase registra qué promociones ya otorgadas terminaron en ventas de POS y
WhatsApp/Mesero. No vuelve a calcular descuentos ni convierte esos canales en
consumidores del cupo de la tienda en línea.

## Decisiones de contrato

- `tienda_online` conserva el ciclo existente reserva → consumo y es el único
  canal que participa en `limite_por_cliente` y en el contador global `usos`.
- `pos` y `whatsapp` escriben filas `consumida` de auditoría, pero no cambian
  esos cupos. Los dos conteos por cliente filtran `canal = 'tienda_online'`.
- Un pedido `pendiente_pago` no registra uso. La fila nace después de la
  transición financiera idempotente a `nuevo`.
- La identidad de WhatsApp es `telefono_conversacion`; el teléfono de entrega
  sólo es fallback. Placeholders o valores con menos de diez dígitos se
  guardan como `NULL`.
- `campaniaId` viaja en `datos.descuentos.promociones[]`. Es una fotografía
  histórica: ni el registro tardío ni la reconciliación consultan la campaña
  vigente de la promoción.
- La clave única `(negocio_id, promocion_id, pedido_folio)` hace idempotentes
  los reintentos y separa negocios incluso si comparten el texto del folio.

## Fallos y recuperación

El hook síncrono usa un pool separado con tiempos máximos de conexión,
sentencia, lock y consulta. La auditoría es fail-open: un timeout o error nunca
revierte un pedido ya persistido ni una confirmación de pago.

Cada cinco minutos, el reconciliador busca promociones faltantes durante las
últimas 48 horas. La deuda se compara por promoción, no sólo por pedido, y se
lee tanto de `pedidos_activos` confirmados como de `pedidos_programados` no
activados cuyo snapshot tenga explícitamente `estado = 'nuevo'`. Esto permite
reparar una conversión inmediata a programado sin transformar por accidente
una reserva pendiente de pago en venta.

El barrido está limitado a 200 pedidos y 30 segundos por pasada, no se solapa
dentro de una instancia y sigue siendo seguro entre instancias por la clave
única. UUID malformados y bloques `promociones` que no sean arreglos se omiten
sin abortar otras reparaciones.

## Migración 091

`canal` queda como `text NOT NULL DEFAULT 'tienda_online'`. El default permite
que el binario anterior siga insertando durante la ventana de despliegue; el
predeploy corrige estados nullable de la antigua migración local y valida sólo
estructura e invariantes estables. Los canales desconocidos producen aviso,
no error, para no impedir evolución futura.

El down es deliberadamente un no-op: una versión anterior de la aplicación
ignora la columna adicional. El teardown manual
`ALTER TABLE public.tienda_promocion_usos DROP COLUMN canal` es destructivo y
borra atribución histórica; requiere respaldo y autorización explícita.

## Límite conocido

Pedidos anteriores a esta versión no contienen `campaniaId`; una reparación de
esos snapshots deja `campania_id = NULL` en vez de inventar la campaña vigente.
También queda fuera de esta fase el flujo preexistente para confirmar pagos de
un pedido que ya fue retirado de activos al programarse.
