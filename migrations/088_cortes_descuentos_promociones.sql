-- ─── 088: el corte de caja aprende cuánto se regaló ────────────────────────
-- Idempotente y re-ejecutable.
--
-- NUMERACIÓN: la 079-087 ya existen en la rama `rescue/mesero-tool-agent`
-- (y 079-086 están desplegadas en `prod/mesero-shadow-v3`), pero esta rama
-- parte de `main`, que solo llega hasta la 078. Se numera 088 -- por encima
-- de la más alta conocida en cualquier rama viva -- para no chocar cuando
-- esta rama y esa se junten. Ver docs correspondiente de esta feature.
--
-- QUÉ ESTABA MAL
--
-- `cortes_caja` (064) congela ventas por forma de pago, pero nunca supo que
-- un `total` puede llevar descuento adentro. El dueño no tiene forma de ver,
-- al cierre del día, cuánto del ingreso se fue en descuentos manuales,
-- cuánto en promociones automáticas y cuánto en canje de Rewards -- el dato
-- vive disperso en `pedidos_activos.datos` (con tres formas distintas según
-- el canal) y en `rewards_movements`, pero nadie lo suma.
--
-- QUÉ SE AGREGA (columnas nullable-por-DEFAULT, no destructivo)
--
--   descuento_manual        lo que un cajero/mesero tecleó a mano (motivo
--                            obligatorio, staff ≤10%, admin sin límite).
--   descuento_promocional   lo que otorgó el motor de promociones
--                            (tiendaPromociones.calcularPromociones), sin
--                            intervención humana.
--   rewards_canjeados       puntos Rewards canjeados y aplicados como
--                            descuento en pedidos del día (de
--                            rewards_movements, no de pedidos_activos: es la
--                            fuente que no depende del formato de cada canal).
--
-- Los tres son INFORMATIVOS: ya están incluidos dentro de `total` /
-- `ventas_totales` -- sumarlos NO cambia `efectivo_esperado` ni el arqueo.
-- Es la misma cautela que exige el propio módulo (ver comentario de cabecera
-- de cortesCaja.js, invariante 2).
--
-- LÍMITE CONOCIDO (documentado a propósito, no oculto): el envío regalado por
-- una promoción de envío gratis NO se contabiliza aquí todavía -- el dato no
-- se guarda de forma uniforme en los tres canales (POS lo descarta al armar
-- el pedido; solo la tienda en línea lo conserva). Queda para una fase
-- posterior que además corrija esa omisión en el POS.

ALTER TABLE cortes_caja
  ADD COLUMN IF NOT EXISTS descuento_manual      NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE cortes_caja
  ADD COLUMN IF NOT EXISTS descuento_promocional NUMERIC(12,2) NOT NULL DEFAULT 0;

ALTER TABLE cortes_caja
  ADD COLUMN IF NOT EXISTS rewards_canjeados     NUMERIC(12,2) NOT NULL DEFAULT 0;
