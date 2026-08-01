-- ============================================================
-- XABOR Multiempresa — Migración 022
-- Fase 7 del panel comercial: seguimiento comercial interno por negocio
-- (plan, mensualidad, fechas de pago, estado del contrato). Exclusivo de
-- Superadmin -- nunca visible en el panel del propio negocio. No
-- automatiza cobros ni integra pasarela de pago (fuera de alcance de
-- esta fase, explícitamente pedido así) -- es solo registro/seguimiento
-- manual para el equipo de Xabor.
--
-- Tabla nueva (no se reutiliza `negocios.plan`, que es un enum operativo
-- de solo 4 valores sin precio ni fechas -- mezclar ambos conceptos
-- rompería la invariante ya documentada en la migración 011 de que
-- negocios.estado/plan son operativos, no comerciales).
--
-- Uno-a-uno con negocios (un solo registro comercial vigente por
-- negocio); el historial de cambios queda en auditoria_plataforma igual
-- que el resto de las acciones de Superadmin, no en esta tabla.
--
-- Reejecutable (CREATE TABLE IF NOT EXISTS, ON CONFLICT en el seed).
-- Ejecutar con: psql "$CONN" -v ON_ERROR_STOP=1 -f 022_plan_comercial_negocio.sql
-- ============================================================

BEGIN;

CREATE TABLE IF NOT EXISTS negocio_plan_comercial (
  negocio_id              UUID PRIMARY KEY REFERENCES negocios(id) ON DELETE CASCADE,
  plan                    TEXT NOT NULL DEFAULT 'prospecto',
  mensualidad             NUMERIC(10,2) NULL,
  costo_instalacion       NUMERIC(10,2) NULL,
  instalacion_pagada      BOOLEAN NOT NULL DEFAULT FALSE,
  fecha_inicio            DATE NULL,
  proxima_fecha_pago      DATE NULL,
  estado                  TEXT NOT NULL DEFAULT 'prospecto',
  notas                   TEXT NULL,
  responsable             TEXT NULL,
  fecha_ultimo_seguimiento DATE NULL,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT negocio_plan_comercial_estado_check
    CHECK (estado IN ('prospecto','prueba','activo','vencido','suspendido','cancelado'))
);

CREATE INDEX IF NOT EXISTS idx_negocio_plan_comercial_estado ON negocio_plan_comercial (estado);

COMMIT;
