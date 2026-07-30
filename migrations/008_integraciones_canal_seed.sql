-- ============================================================
-- XABOR Multiempresa Fase 5 — Seed Migración 008
-- Siembra ÚNICAMENTE identificadores reales ya confirmados en el
-- repositorio (código o configuración versionada) — nunca valores
-- inventados. Ningún secreto, token ni client_secret se guarda aquí.
-- Idempotente: reejecutable sin duplicar filas.
-- ============================================================

DO $$
DECLARE
  v_negocio_id UUID;
BEGIN
  SELECT id INTO v_negocio_id FROM negocios WHERE slug = 'nonna-maye';

  IF v_negocio_id IS NULL THEN
    RAISE NOTICE 'Seed 008 abortado: no existe negocio con slug ''nonna-maye''. Aplica 003/003_seed primero.';
    RETURN;
  END IF;

  -- ── Rappi ────────────────────────────────────────────────────────────
  -- Identificador confirmado en src/services/rappi-api.js:15
  -- ("const STORE_ID = process.env.RAPPI_STORE_ID || null; // PROD: 1930419809")
  -- y referenciado también en src/channels/rappi.js:92 como el
  -- store.internal_id real de la orden productiva ya recibida. No es un
  -- secreto (es un identificador de tienda, no una credencial).
  INSERT INTO integraciones_canal (negocio_id, canal, identificador, nombre)
  VALUES (v_negocio_id, 'rappi', '1930419809', 'Rappi — Nonna Maye')
  ON CONFLICT (canal, identificador) DO NOTHING;

  -- ── WhatsApp ─────────────────────────────────────────────────────────
  -- PENDIENTE — no se siembra. No hay ningún phone_number_id real en el
  -- repositorio: whatsapp-meta.js:64 solo referencia los NOMBRES de
  -- variable (META_PHONE_NUMBER_ID / wa_phone_id vía getIntegracion), y
  -- .env.example no trae un valor real, solo el placeholder de la
  -- variable. Sembrar un valor aquí sería inventarlo. Falta leer el
  -- phone_number_id real desde la configuración de Meta/Railway antes de
  -- poder completar este INSERT.

  -- ── Voz (Twilio) ─────────────────────────────────────────────────────
  -- PENDIENTE — no se siembra. .env.example solo trae
  -- TWILIO_PHONE_NUMBER=... como placeholder; no hay ningún número real
  -- confirmado en el código (voice.js nunca lee req.body.To hoy). Falta
  -- confirmar el número real de Twilio en uso antes de poder completar
  -- este INSERT.
END $$;
