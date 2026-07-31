-- ============================================================
-- XABOR Multiempresa — Migración 017 (siembra de datos)
-- Copia el contenido actual de src/data/rules.json hacia
-- configuracion.reglas_atencion, asociado explícitamente al negocio_id
-- de Nonna Maye -- preserva su comportamiento operativo exacto una vez
-- que prompts.js deje de leer el archivo estático (Fase A).
--
-- Transaccional, idempotente (ON CONFLICT DO NOTHING -- si la clave
-- 'reglas_atencion' ya existe para Nonna Maye, esta migración NO la
-- sobrescribe; se detiene y dice explícitamente que no hizo nada, para
-- que se revise manualmente antes de forzar un cambio).
--
-- Localización de negocio: por slug específico, igual que 015/016 --
-- nunca por conteo total de negocios.
--
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 017_seed_reglas_nonna_maye.sql
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_nonna_id UUID;
  v_ya_existe BOOLEAN;
BEGIN
  IF (SELECT count(*) FROM negocios WHERE slug = 'nonna-maye') = 0 THEN
    RAISE EXCEPTION 'Migración 017 abortada: no se encontró el negocio con slug ''nonna-maye''. Transacción revertida.';
  END IF;
  IF (SELECT count(*) FROM negocios WHERE slug = 'nonna-maye') > 1 THEN
    RAISE EXCEPTION 'Migración 017 abortada: slug ''nonna-maye'' es ambiguo (más de un negocio). Transacción revertida.';
  END IF;

  SELECT id INTO v_nonna_id FROM negocios WHERE slug = 'nonna-maye';

  SELECT EXISTS(
    SELECT 1 FROM configuracion WHERE negocio_id = v_nonna_id AND clave = 'reglas_atencion'
  ) INTO v_ya_existe;

  IF v_ya_existe THEN
    RAISE NOTICE 'Migración 017: configuracion.reglas_atencion ya existe para nonna-maye -- NO se sobrescribe. Sin cambios.';
  ELSE
    INSERT INTO configuracion (negocio_id, clave, valor)
    VALUES (
      v_nonna_id,
      'reglas_atencion',
      '{"restaurante":"Xabor","horarios":{"lunes":{"abierto":true,"apertura":"11:00","cierre":"22:00"},"martes":{"abierto":true,"apertura":"11:00","cierre":"22:00"},"miercoles":{"abierto":true,"apertura":"11:00","cierre":"22:00"},"jueves":{"abierto":true,"apertura":"11:00","cierre":"22:00"},"viernes":{"abierto":true,"apertura":"11:00","cierre":"22:00"},"sabado":{"abierto":true,"apertura":"11:00","cierre":"22:00"},"domingo":{"abierto":false,"apertura":null,"cierre":null}},"pedidos":{"modalidades":["recoger en tienda","entrega a domicilio"],"tiempo_preparacion_minutos":20,"pedido_minimo_entrega":0,"costo_envio":60,"pago_aceptado":["efectivo","terminal (tarjeta presente)","enlace de pago"]},"cierres_especiales":[],"promociones":[],"politicas":["No se aceptan cambios ni cancelaciones una vez confirmado el pedido.","Los precios incluyen IVA.","El tiempo de entrega estimado es de 40 a 60 minutos.","No se aceptan pedidos fuera de horario."]}'
    )
    ON CONFLICT (negocio_id, clave) DO NOTHING;
    RAISE NOTICE 'Migración 017: configuracion.reglas_atencion sembrada para nonna-maye.';
  END IF;
END $$;

COMMIT;
