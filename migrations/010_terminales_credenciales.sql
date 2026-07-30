-- ============================================================
-- XABOR Multiempresa — Migración 010
-- Extiende terminales (creada en la migración 003, sin ningún uso en
-- código de aplicación hasta hoy — confirmado por búsqueda en todo
-- src/ y panel/) con las columnas necesarias para autenticar
-- print-agents por terminal: token_hash, tipo, ultima_conexion.
--
-- Puramente aditiva. No modifica PK, FKs, UNIQUE(sucursal_id, nombre),
-- UNIQUE(sucursal_id, codigo) ni ninguna fila existente. No genera
-- ningún token real ni rellena terminales existentes con secretos
-- ficticios -- token_hash queda NULL para toda fila hasta que una fase
-- posterior (no autorizada todavía) emita una credencial real.
--
-- negocio_id NO se agrega aquí: se sigue resolviendo exclusivamente vía
-- terminales.sucursal_id → sucursales.negocio_id, sin denormalizar.
--
-- created_at y updated_at NO se agregan: ya existen desde la migración
-- 003 (TIMESTAMPTZ NOT NULL DEFAULT NOW()), confirmado antes de escribir
-- esta migración -- no se duplican.
--
-- Reejecutable.
-- ============================================================

-- ── Paso 1: token_hash -- nullable, sin default, sin backfill ────────
-- Nullable a propósito: permite migración gradual -- las terminales que
-- ya existan (o se creen antes de emitirles credencial) siguen siendo
-- filas válidas sin token hasta que se les asigne uno. Nunca contendrá
-- el token en texto plano, solo su hash (calculado y escrito por la
-- aplicación en una fase posterior; esta migración no calcula ni
-- almacena ningún valor aquí).
ALTER TABLE terminales ADD COLUMN IF NOT EXISTS token_hash TEXT;

-- ── Paso 2: tipo -- clasifica el rol de la terminal ───────────────────
-- Sin ENUM ni CHECK IN (...): mismo criterio que 'canal' en
-- integraciones_canal (008) -- agregar un tipo de terminal nuevo no debe
-- requerir otra migración. Valor inicial para todas las filas:
-- 'impresora' (print-agent, el único tipo que existe hoy). Queda abierto
-- para futuros tipos (p. ej. 'punto_venta', 'kiosko') sin bloquear con
-- una restricción rígida -- la validación de valores permitidos, si se
-- necesita, vive en la aplicación, no en el esquema.
ALTER TABLE terminales ADD COLUMN IF NOT EXISTS tipo TEXT NOT NULL DEFAULT 'impresora';

-- ── Paso 3: ultima_conexion -- última autenticación exitosa ──────────
-- Nullable (una terminal que nunca se ha conectado no tiene valor). Se
-- actualizará EXCLUSIVAMENTE por la aplicación en el momento exacto de
-- una autenticación válida (fase posterior, no autorizada todavía) --
-- deliberadamente SIN un trigger genérico, para que nunca se confunda
-- con un UPDATE administrativo cualquiera (renombrar, activar/
-- desactivar, asignar sucursal, etc.) que no sea una conexión real.
ALTER TABLE terminales ADD COLUMN IF NOT EXISTS ultima_conexion TIMESTAMP;

-- ── Paso 4: trigger updated_at -- ya existe desde la migración 003
-- (creado como "DROP TRIGGER IF EXISTS set_updated_at ON terminales;
-- CREATE TRIGGER set_updated_at BEFORE UPDATE ... FOR EACH ROW EXECUTE
-- FUNCTION set_updated_at();"). Se reafirma aquí de forma idempotente
-- únicamente por consistencia con el resto de esta migración y con el
-- patrón ya usado en 008 -- no crea una segunda función equivalente, no
-- duplica nada: set_updated_at() sigue siendo la única función, definida
-- en 003. Este trigger seguirá disparándose con cualquier UPDATE de la
-- fila (incluida una futura escritura de ultima_conexion), lo cual es
-- el comportamiento correcto y ya existente para updated_at -- distinto
-- de "un trigger que actualice ultima_conexion", que deliberadamente no
-- se crea (ver Paso 3).
DROP TRIGGER IF EXISTS set_updated_at ON terminales;
CREATE TRIGGER set_updated_at
  BEFORE UPDATE ON terminales
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ── Paso 5: índice único parcial sobre token_hash ─────────────────────
-- Solo indexa/restringe filas donde token_hash NO es NULL -- muchas
-- terminales seguirán sin credencial durante la migración gradual (una
-- UNIQUE completa permitiría igualmente múltiples NULL, ya que Postgres
-- los trata como distintos entre sí, pero el índice parcial es la forma
-- explícita y autodocumentada de dejar constancia de la intención: nunca
-- indexar ni restringir filas sin token). Garantiza, a nivel de base de
-- datos y no solo por la baja probabilidad de colisión del hash, que dos
-- terminales jamás puedan compartir accidentalmente el mismo token_hash
-- -- eso permitiría que una terminal se autenticara con la identidad de
-- otra. Mismo patrón que el índice parcial de
-- integraciones_canal.sucursal_id (008).
CREATE UNIQUE INDEX IF NOT EXISTS idx_terminales_token_hash_unique
  ON terminales (token_hash)
  WHERE token_hash IS NOT NULL;
