-- Reversa de la 127 (Xecador, directorio de empleados).
--
-- ANTES DE CORRERLA: revertir primero el código (el binario) que depende de la
-- 127. Con el binario nuevo vivo, las rutas /api/personal/* fallarían contra
-- tablas que ya no existen, y el alta de negocios del Superadmin
-- (crearNegocioCompleto inserta una fila por cada módulo válido, 'personal'
-- incluido) chocaría con el CHECK restaurado.
--
-- Se corre con psql:  psql "$CONN" -f migrations/127_xecador_empleados_down.sql
--
-- Es todo o nada, aunque quien la corra olvide -v ON_ERROR_STOP=1:
--   - la primera línea lo enciende dentro del propio archivo, así que ante
--     cualquier error psql se detiene y termina con código 3;
--   - todo va dentro de BEGIN/COMMIT: si algo falla, no queda nada a medias.
-- Si alguna herramienta la mandara por Node (pg) en vez de psql, el servidor
-- rechaza el texto completo por la línea \set antes de ejecutar nada: también
-- falla cerrada.
--
-- Falla (a propósito) si ya hay empleados o números registrados: borrarlos es
-- borrar el expediente de personas reales y la garantía de que su número no se
-- reutiliza. Primero hay que decidir qué hacer con esos datos.
--
-- El orden importa (mismo motivo que la reversa de la 051): restaurar el CHECK
-- antes de quitar las filas de negocio_modulos haría fallar el ALTER, porque
-- Postgres valida la restricción contra las filas existentes.
\set ON_ERROR_STOP on

BEGIN;

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

COMMIT;
