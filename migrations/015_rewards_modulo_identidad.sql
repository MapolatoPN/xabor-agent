-- ============================================================
-- XABOR Multiempresa — Migración 015
-- Rewards pasa a ser módulo comercial real (negocio_modulos) y
-- rewards_accounts se convierte en la fuente de identidad propia por
-- negocio (nombre incluido) -- deja de depender de la tabla global
-- `clientes` para mostrar nombre/última visita en las pantallas de
-- Rewards. No toca clientes ni pedidos: solo agrega una columna
-- nueva y nula a rewards_accounts, y agrega 'rewards' a la lista de
-- módulos válidos de negocio_modulos.
--
-- Vocabulario de estados para Rewards (modelo aprobado en la
-- reorganización de módulos): activo | pendiente_configuracion |
-- suspendido | no_contratado. Se AMPLÍA el CHECK de
-- negocio_modulos.estado para admitir estos dos valores nuevos
-- (pendiente_configuracion, no_contratado) SIN remover ninguno de los
-- 5 valores heredados (no_configurado, pendiente, configurado, activo,
-- suspendido) que siguen usando el resto de los módulos (pos,
-- usuarios, caja, menu, impresion, whatsapp, voz, rappi, facturacion)
-- -- ninguna fila existente de esos módulos se toca ni se reinterpreta,
-- solo se amplía el conjunto de valores permitidos para que Rewards
-- pueda usar su propio vocabulario canónico.
--
-- Localización de negocios: esta migración NO asume ni exige un
-- número total de negocios en la base. Localiza cada uno de los 3
-- negocios que necesita sembrar por su propio slug (identificador
-- estable), permite que existan cualquier cantidad de otros tenants
-- sin efecto alguno sobre ellos, y solo aborta si alguno de esos 3
-- slugs específicos falta o es ambiguo (más de una fila con el mismo
-- slug) -- nunca por el conteo total de negocios registrados.
--
-- TODO el script corre en una sola transacción: si cualquier guard de
-- localización falla, TODO se revierte -- incluyendo los cambios de
-- constraint y la columna nueva -- no solo el propio RAISE. Un
-- DO $$ ... RAISE EXCEPTION $$ por sí solo NO detiene el resto de un
-- script psql (cada sentencia corre independiente salvo que estén en
-- la misma transacción) -- de ahí el BEGIN/COMMIT explícito.
--
-- Reejecutable (todo con IF NOT EXISTS / guardas explícitas / ON
-- CONFLICT DO NOTHING).
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 015_rewards_modulo_identidad.sql
-- (ON_ERROR_STOP=1 es una segunda red de seguridad: si CUALQUIER
-- sentencia de la transacción falla, psql aborta el script en vez de
-- seguir intentando las siguientes.)
-- ============================================================

BEGIN;

-- ── Paso 1: agregar 'rewards' al CHECK de negocio_modulos.modulo ──────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'negocio_modulos_modulo_check'
  ) THEN
    ALTER TABLE negocio_modulos DROP CONSTRAINT negocio_modulos_modulo_check;
  END IF;
  ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_modulo_check
    CHECK (modulo IN ('pos','usuarios','caja','menu','impresion','whatsapp','voz','rappi','facturacion','rewards'));
END $$;

-- ── Paso 1b: ampliar el CHECK de negocio_modulos.estado con el vocabulario
--    canónico (pendiente_configuracion, no_contratado), preservando los 5
--    valores heredados intactos para el resto de los módulos ─────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'negocio_modulos_estado_check'
  ) THEN
    ALTER TABLE negocio_modulos DROP CONSTRAINT negocio_modulos_estado_check;
  END IF;
  ALTER TABLE negocio_modulos ADD CONSTRAINT negocio_modulos_estado_check
    CHECK (estado IN (
      'no_configurado','pendiente','configurado','activo','suspendido',
      'pendiente_configuracion','no_contratado'
    ));
END $$;

-- ── Paso 2: columna de identidad propia en rewards_accounts ───────────────
-- Nula a propósito: el backfill del paso 5 la llena solo donde hay
-- certeza de propiedad; cualquier fila sin coincidencia segura queda en
-- NULL (nunca se inventa un nombre ni se copia de otro negocio).
ALTER TABLE rewards_accounts ADD COLUMN IF NOT EXISTS nombre VARCHAR(100);

-- ── Paso 3: localizar de forma segura, por slug, cada uno de los 3
--    negocios reales que esta migración necesita sembrar -- sin importar
--    cuántos otros negocios existan en la base. Aborta (revierte toda la
--    transacción) solo si un slug requerido falta o es ambiguo ──────────
DO $$
BEGIN
  IF (SELECT count(*) FROM negocios WHERE slug = 'nonna-maye') = 0 THEN
    RAISE EXCEPTION 'Migración 015 abortada: no se encontró el negocio con slug ''nonna-maye''. Transacción revertida.';
  END IF;
  IF (SELECT count(*) FROM negocios WHERE slug = 'nonna-maye') > 1 THEN
    RAISE EXCEPTION 'Migración 015 abortada: slug ''nonna-maye'' es ambiguo (más de un negocio). Transacción revertida.';
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT count(*) FROM negocios WHERE slug = 'alora-floreria-y-eventos') = 0 THEN
    RAISE EXCEPTION 'Migración 015 abortada: no se encontró el negocio con slug ''alora-floreria-y-eventos''. Transacción revertida.';
  END IF;
  IF (SELECT count(*) FROM negocios WHERE slug = 'alora-floreria-y-eventos') > 1 THEN
    RAISE EXCEPTION 'Migración 015 abortada: slug ''alora-floreria-y-eventos'' es ambiguo (más de un negocio). Transacción revertida.';
  END IF;
END $$;

DO $$
BEGIN
  IF (SELECT count(*) FROM negocios WHERE slug = 'mapolato-acuna') = 0 THEN
    RAISE EXCEPTION 'Migración 015 abortada: no se encontró el negocio con slug ''mapolato-acuna''. Transacción revertida.';
  END IF;
  IF (SELECT count(*) FROM negocios WHERE slug = 'mapolato-acuna') > 1 THEN
    RAISE EXCEPTION 'Migración 015 abortada: slug ''mapolato-acuna'' es ambiguo (más de un negocio). Transacción revertida.';
  END IF;
END $$;

-- ── Paso 4: negocio_modulos.rewards SOLO para estos 3 negocios,
--    localizados cada uno por su propio slug (nunca por posición ni por
--    conteo total) -- cualquier otro tenant existente queda intacto ────
-- Nonna Maye: 'activo' solo si su fila real en rewards_config existe y
-- está activa -- nunca se asume, se lee el valor real. Si por alguna
-- razón no lo está, el estado correcto es 'pendiente_configuracion'
-- (Rewards SÍ está contratado para ella, pero técnicamente no
-- configurado), nunca 'no_contratado'.
INSERT INTO negocio_modulos (negocio_id, modulo, estado)
SELECT n.id, 'rewards',
  CASE WHEN EXISTS (
    SELECT 1 FROM rewards_config rc WHERE rc.tenant_id = n.id::text AND rc.activo = true
  ) THEN 'activo' ELSE 'pendiente_configuracion' END
FROM negocios n WHERE n.slug = 'nonna-maye'
ON CONFLICT (negocio_id, modulo) DO NOTHING;

-- Alora y Mapolato Acuña: Rewards no está contratado comercialmente
-- para ninguno de los dos -- estado 'no_contratado', explícito y
-- literal (nunca 'no_configurado', que es el vocabulario heredado de
-- otros módulos con un significado distinto).
INSERT INTO negocio_modulos (negocio_id, modulo, estado)
SELECT n.id, 'rewards', 'no_contratado'
FROM negocios n WHERE n.slug IN ('alora-floreria-y-eventos','mapolato-acuna')
ON CONFLICT (negocio_id, modulo) DO NOTHING;

-- ── Paso 5: backfill seguro de rewards_accounts.nombre ─────────────────────
-- Solo copia clientes.nombre cuando negocio_id coincide EXACTAMENTE con el
-- tenant_id de la cuenta de Rewards (comparación real, nunca asumida por
-- coincidencia de teléfono). Cualquier cuenta sin esa coincidencia segura
-- se queda con nombre = NULL -- nunca hereda el nombre de otro negocio.
UPDATE rewards_accounts a
SET nombre = c.nombre
FROM clientes c
WHERE c.telefono = a.telefono
  AND c.negocio_id::text = a.tenant_id
  AND a.nombre IS NULL;

COMMIT;
