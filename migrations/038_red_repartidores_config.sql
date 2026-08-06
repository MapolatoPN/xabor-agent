-- ============================================================
-- XABOR Multiempresa — Migración 038 (LOCAL, no aplicada en producción)
-- Red de repartidores como servicio ACTIVABLE Y CONFIGURABLE por negocio.
-- Aditiva únicamente. Reejecutable. Sin backfill: un negocio SIN fila aquí
-- conserva EXACTAMENTE el comportamiento actual (modo de notificación por
-- claves de configuracion, sin cobertura ni horario) -- la fila solo
-- existe cuando el negocio configura su red explícitamente.
-- ============================================================

CREATE TABLE IF NOT EXISTS red_repartidores_config (
  negocio_id            UUID PRIMARY KEY REFERENCES negocios(id) ON DELETE CASCADE,
  red_activa            BOOLEAN NOT NULL DEFAULT false,
  -- Fuentes de reparto habilitadas para este negocio. Hoy solo 'propios'
  -- tiene motor real (repartidores del negocio vía WhatsApp); red_xabor y
  -- plataformas externas quedan declaradas para el roadmap sin inventar
  -- comportamiento: el motor las ignora mientras no exista implementación.
  fuentes               JSONB NOT NULL DEFAULT '{"propios": true, "red_xabor": false, "externas": false}'::jsonb,
  -- Horario de servicio de la red -- null en ambos = sin restricción (24h).
  -- Formato HH:MM 24h, interpretado en el huso del negocio (hoy la
  -- plataforma opera America/Matamoros; multi-huso queda fuera de alcance).
  horario_inicio        TEXT NULL,
  horario_fin           TEXT NULL,
  -- Cobertura: lista de zonas/colonias atendidas (texto normalizado en
  -- minúsculas al comparar). Lista vacía o null = sin restricción de
  -- cobertura (comportamiento actual). radio_km declarativo: sin geocoding
  -- hoy, el motor NO lo evalúa -- existe para capturar el dato comercial y
  -- para la evolución futura; la evaluación real es por zonas/colonias.
  zonas                 JSONB NOT NULL DEFAULT '[]'::jsonb,
  radio_km              NUMERIC(6,2) NULL,
  -- Costos del servicio de reparto. quien_absorbe: quién paga el costo del
  -- repartidor ('negocio' | 'cliente' | 'compartido').
  costo_base            NUMERIC(10,2) NOT NULL DEFAULT 0,
  costo_por_km          NUMERIC(10,2) NOT NULL DEFAULT 0,
  quien_absorbe         TEXT NOT NULL DEFAULT 'cliente' CHECK (quien_absorbe IN ('negocio','cliente','compartido')),
  -- Aceptación/reasignación: minutos de vida del token de oferta (hoy el
  -- motor usa 30 fijo; esta columna lo vuelve configurable) y qué hacer si
  -- nadie acepta ('reofertar' | 'manual' | 'ninguna').
  tiempo_max_aceptacion_min INT NOT NULL DEFAULT 30 CHECK (tiempo_max_aceptacion_min BETWEEN 5 AND 240),
  politica_reasignacion TEXT NOT NULL DEFAULT 'manual' CHECK (politica_reasignacion IN ('reofertar','manual','ninguna')),
  -- Operación: contacto del negocio para repartidores, instrucciones de
  -- recogida y tiempo estimado de preparación (minutos) que ve la oferta.
  contacto              TEXT NULL,
  instrucciones_recogida TEXT NULL,
  tiempo_preparacion_min INT NOT NULL DEFAULT 20 CHECK (tiempo_preparacion_min BETWEEN 0 AND 240),
  -- solicitud_automatica: true = cada pedido elegible dispara ofertas solo
  -- (comportamiento actual); false = el negocio solicita repartidor
  -- manualmente por pedido (POST /api/pedidos/:folio/solicitar-repartidor).
  solicitud_automatica  BOOLEAN NOT NULL DEFAULT true,
  -- Prioridad por modalidad (declarativo, para el panel y roadmap).
  prioridad_modalidad   JSONB NOT NULL DEFAULT '["entrega a domicilio"]'::jsonb,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
