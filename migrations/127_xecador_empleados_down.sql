-- Reversa de la 127.
--
-- Falla (a propósito) si ya hay empleados o números registrados: borrarlos
-- es borrar el expediente de personas reales y la garantía de que su número
-- no se reutiliza. Primero hay que decidir qué hacer con esos datos.
--
-- El orden importa (mismo motivo que la reversa de la 051): restaurar el CHECK
-- antes de quitar las filas de negocio_modulos haría fallar el ALTER, porque
-- Postgres valida la restricción contra las filas existentes.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM xecador_empleados) OR EXISTS (SELECT 1 FROM xecador_numeros_empleado) THEN
    RAISE EXCEPTION 'La reversa de la 127 no corre con empleados registrados: hay datos de personas que se perderían';
  END IF;
END $$;

-- 1) Ningún negocio queda con un módulo que deja de existir.
DELETE FROM negocio_modulos WHERE modulo = 'personal';

-- 2) CHECK exactamente como lo dejó la 051.
ALTER TABLE negocio_modulos DROP CONSTRAINT IF EXISTS negocio_modulos_modulo_check;
ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_modulo_check CHECK (modulo = ANY (ARRAY[
  'pos', 'usuarios', 'caja', 'menu', 'impresion', 'whatsapp', 'voz', 'rappi',
  'facturacion', 'rewards', 'chat_imagenes', 'chat_documentos_pdf', 'cotizaciones',
  'generador_cotizaciones', 'pagos', 'repartidores', 'asistente_comercial_cotizaciones',
  'restaurante', 'tienda_online'
]));

-- 3) Tablas vacías (comprobado arriba) y la función del trigger.
DROP TABLE IF EXISTS xecador_empleados;
DROP TABLE IF EXISTS xecador_numeros_empleado;
DROP FUNCTION IF EXISTS xecador_numeros_empleado_inmutable();
