-- ─── 055: deuda durable de derivación en el ciclo de vida del pago ──────────
-- Idempotente y re-ejecutable.
--
-- POR QUÉ EXISTE (y por qué no alcanzaba con lo que ya había)
--
-- Queda una ventana de crash que ningún mecanismo actual cubre:
--
--     asentarPagoRealVerificado COMMIT estado='pagado'
--         ↓ el proceso muere aquí
--     confirmarPagoPedido / confirmarPedidoPendientePago
--
-- Después de ese COMMIT el pago ya está 'pagado', así que la reconciliación de
-- proveedor deja de mirarlo -- para ella el cobro está resuelto. Y la marca
-- `emision_pendiente` del pedido todavía no existe, porque se escribe más
-- adelante, dentro de confirmarPedidoPendientePago. Resultado: dinero cobrado,
-- ledger correcto, y un pedido que nadie va a liberar nunca. No es un caso
-- raro: es exactamente lo que pasa si Railway recicla el contenedor entre esas
-- dos líneas.
--
-- La única forma de cerrarla es escribir la OBLIGACIÓN de derivar en la misma
-- transacción que asienta el dinero. Por eso hace falta migración: no hay
-- ninguna columna existente que pueda representar "este pago ya está cobrado
-- pero su pedido todavía no se liberó". `metadata_sanitizada` podría llevar el
-- dato, pero no se puede indexar bien para que un job lo recorra, y una deuda
-- que no se puede buscar barato no es una deuda: es un comentario.
--
-- La obligación se PERSISTE aquí; la comanda NO se ejecuta dentro de la
-- transacción financiera. Emitir papel mientras se sostiene una transacción de
-- dinero mezcla dos duraciones que no tienen por qué compartir destino.

ALTER TABLE pagos ADD COLUMN IF NOT EXISTS derivacion_pendiente boolean NOT NULL DEFAULT false;
ALTER TABLE pagos ADD COLUMN IF NOT EXISTS derivacion_saldada_at timestamptz;

-- Índice parcial: el job de recuperación solo mira las deudas abiertas, que en
-- operación normal son cero o casi cero. Sin el parcial, recorrer la tabla de
-- pagos cada minuto para encontrar nada sería puro desperdicio.
CREATE INDEX IF NOT EXISTS idx_pagos_derivacion_pendiente
  ON pagos (negocio_id, pedido_folio) WHERE derivacion_pendiente;

-- Reconciliación por proveedor sin usar una ventana de días como sustituto de
-- expiración. Un checkout superseded ('invalidado') SIGUE pudiendo recibir
-- dinero mientras el proveedor no lo cancele de verdad -- Clip no ofrece
-- cancelación en su API pública --, así que tiene que seguir siendo
-- reconciliable. Los estados que quedan fuera son los que ya no pueden recibir
-- nada: cobrado, devuelto, o cancelado con confirmación del proveedor.
CREATE INDEX IF NOT EXISTS idx_pagos_reconciliables
  ON pagos (proveedor, created_at)
  WHERE estado NOT IN ('pagado','reembolsado','cancelado');
