import pkg from 'pg';
import { createHmac, createHash, randomBytes } from 'crypto';
import { hashPassword } from './password.js';
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── Inicializar tablas ───────────────────────────────────────────────────────
export async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS clientes (
      telefono    VARCHAR(20) PRIMARY KEY,
      nombre      VARCHAR(100),
      ultima_visita TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pedidos (
      id             SERIAL PRIMARY KEY,
      folio          VARCHAR(20),
      telefono       VARCHAR(20) REFERENCES clientes(telefono),
      nombre_cliente VARCHAR(100),
      items          JSONB,
      total          DECIMAL(10,2),
      costo_envio    DECIMAL(10,2) DEFAULT 0,
      modalidad      VARCHAR(50),
      canal          VARCHAR(20),
      forma_pago     VARCHAR(50),
      created_at     TIMESTAMP DEFAULT NOW()
    );
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS folio VARCHAR(20);
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS nombre_cliente VARCHAR(100);
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS costo_envio DECIMAL(10,2) DEFAULT 0;
    ALTER TABLE pedidos ADD COLUMN IF NOT EXISTS forma_pago VARCHAR(50);
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS bot_pausado BOOLEAN DEFAULT FALSE;
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS pedido_pago_pendiente VARCHAR(20) DEFAULT NULL;
    ALTER TABLE clientes ADD COLUMN IF NOT EXISTS es_interno BOOLEAN DEFAULT FALSE;

    CREATE TABLE IF NOT EXISTS mensajes (
      id          SERIAL PRIMARY KEY,
      telefono    VARCHAR(20) NOT NULL,
      nombre      VARCHAR(100),
      direccion   VARCHAR(10) NOT NULL,
      texto       TEXT NOT NULL,
      timestamp   TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_mensajes_telefono ON mensajes(telefono);
    CREATE INDEX IF NOT EXISTS idx_mensajes_timestamp ON mensajes(timestamp DESC);

    CREATE TABLE IF NOT EXISTS pedidos_activos (
      folio       VARCHAR(20) PRIMARY KEY,
      estado      VARCHAR(30) DEFAULT 'nuevo',
      datos       JSONB NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW(),
      updated_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS pedidos_programados (
      folio          VARCHAR(20) PRIMARY KEY,
      datos          JSONB NOT NULL,
      programado_para TIMESTAMP NOT NULL,
      activado       BOOLEAN DEFAULT FALSE,
      created_at     TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS configuracion (
      clave  VARCHAR(50) PRIMARY KEY,
      valor  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS caja_fondos (
      id          SERIAL PRIMARY KEY,
      fecha       DATE NOT NULL UNIQUE,
      fondo       DECIMAL(10,2) NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS prompt_improvements (
      id          SERIAL PRIMARY KEY,
      semana      DATE NOT NULL,
      sugerencias JSONB NOT NULL,
      estado      VARCHAR(20) DEFAULT 'pendiente',
      aprobadas   JSONB,
      created_at  TIMESTAMP DEFAULT NOW(),
      applied_at  TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS prompt_overrides (
      id          SERIAL PRIMARY KEY,
      seccion     VARCHAR(100) NOT NULL,
      contenido   TEXT NOT NULL,
      activo      BOOLEAN DEFAULT TRUE,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS transcripciones_voz (
      id          SERIAL PRIMARY KEY,
      call_sid    VARCHAR(50) NOT NULL,
      from_num    VARCHAR(30),
      rol         VARCHAR(10) NOT NULL,
      texto       TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_transcripciones_call_sid ON transcripciones_voz(call_sid);
    CREATE INDEX IF NOT EXISTS idx_transcripciones_created_at ON transcripciones_voz(created_at DESC);

    CREATE TABLE IF NOT EXISTS menu_categorias (
      id         SERIAL PRIMARY KEY,
      nombre     VARCHAR(100) NOT NULL,
      orden      INTEGER DEFAULT 0,
      activa     BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE IF NOT EXISTS menu_productos (
      id           SERIAL PRIMARY KEY,
      categoria_id INTEGER REFERENCES menu_categorias(id) ON DELETE CASCADE,
      codigo       VARCHAR(20) UNIQUE,
      nombre       VARCHAR(150) NOT NULL,
      descripcion  TEXT,
      precio       DECIMAL(10,2) NOT NULL,
      disponible   BOOLEAN DEFAULT TRUE,
      opciones     JSONB,
      orden        INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id          SERIAL PRIMARY KEY,
      endpoint    TEXT NOT NULL UNIQUE,
      auth        TEXT NOT NULL,
      p256dh      TEXT NOT NULL,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS repartidores (
      id          SERIAL PRIMARY KEY,
      nombre      VARCHAR(100) NOT NULL,
      telefono    VARCHAR(20) NOT NULL UNIQUE,
      activo      BOOLEAN DEFAULT TRUE,
      token       VARCHAR(64) NOT NULL UNIQUE,
      created_at  TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions_repartidor (
      id              SERIAL PRIMARY KEY,
      repartidor_id   INTEGER NOT NULL REFERENCES repartidores(id) ON DELETE CASCADE,
      endpoint        TEXT NOT NULL UNIQUE,
      auth            TEXT NOT NULL,
      p256dh          TEXT NOT NULL,
      created_at      TIMESTAMP DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS campanas (
      id                  SERIAL PRIMARY KEY,
      restaurant_id       TEXT NOT NULL DEFAULT 'xabor-principal',
      nombre              TEXT NOT NULL,
      segmento            TEXT NOT NULL,
      mensaje             TEXT NOT NULL,
      total_destinatarios INTEGER NOT NULL DEFAULT 0,
      enviados            INTEGER NOT NULL DEFAULT 0,
      fallidos            INTEGER NOT NULL DEFAULT 0,
      respondidos         INTEGER NOT NULL DEFAULT 0,
      estado              TEXT NOT NULL DEFAULT 'pendiente',
      creada_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completada_at       TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_campanas_estado ON campanas (estado);
    CREATE INDEX IF NOT EXISTS idx_campanas_creada ON campanas (creada_at DESC);

    CREATE TABLE IF NOT EXISTS campana_envios (
      id          SERIAL PRIMARY KEY,
      campana_id  INTEGER NOT NULL REFERENCES campanas(id) ON DELETE CASCADE,
      telefono    TEXT NOT NULL,
      nombre      TEXT,
      estado      TEXT NOT NULL DEFAULT 'pendiente',
      enviado_at  TIMESTAMPTZ,
      respondio_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_campana_envios_campana  ON campana_envios (campana_id);
    CREATE INDEX IF NOT EXISTS idx_campana_envios_telefono ON campana_envios (telefono);
    CREATE INDEX IF NOT EXISTS idx_campana_envios_estado   ON campana_envios (estado);

    CREATE TABLE IF NOT EXISTS menu_modificadores_grupos (
      id          SERIAL PRIMARY KEY,
      producto_id INTEGER NOT NULL REFERENCES menu_productos(id) ON DELETE CASCADE,
      nombre      VARCHAR(100) NOT NULL,
      requerido   BOOLEAN DEFAULT FALSE,
      minimo      INTEGER DEFAULT 0,
      maximo      INTEGER DEFAULT 1,
      orden       INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mod_grupos_producto ON menu_modificadores_grupos (producto_id);

    CREATE TABLE IF NOT EXISTS menu_modificadores_opciones (
      id          SERIAL PRIMARY KEY,
      grupo_id    INTEGER NOT NULL REFERENCES menu_modificadores_grupos(id) ON DELETE CASCADE,
      nombre      VARCHAR(100) NOT NULL,
      precio_extra DECIMAL(10,2) DEFAULT 0,
      disponible  BOOLEAN DEFAULT TRUE,
      orden       INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_mod_opciones_grupo ON menu_modificadores_opciones (grupo_id);

    -- ─── Rewards ─────────────────────────────────────────────────────────────
    -- DEUDA TÉCNICA: clientes.telefono es PK actual y se usa como FK en rewards_accounts.
    -- Cuando se migre clientes a un UUID como clave primaria, rewards_accounts.telefono
    -- debe reemplazarse por cliente_id UUID. Las funciones de rewardsService.js están
    -- encapsuladas para facilitar esa migración sin reescribir la lógica de negocio.

    CREATE TABLE IF NOT EXISTS rewards_config (
      id              SERIAL PRIMARY KEY,
      tenant_id       TEXT NOT NULL DEFAULT 'xabor-principal',
      nombre_programa TEXT NOT NULL DEFAULT 'Xabor Rewards',
      activo          BOOLEAN DEFAULT TRUE,
      monto_por_punto DECIMAL(10,2) DEFAULT 10,
      puntos_por_peso DECIMAL(10,4) DEFAULT 0.5,
      canje_minimo    INTEGER DEFAULT 100,
      canal_mostrador BOOLEAN DEFAULT TRUE,
      canal_whatsapp  BOOLEAN DEFAULT TRUE,
      canal_telefono  BOOLEAN DEFAULT TRUE,
      canal_rappi     BOOLEAN DEFAULT FALSE,
      vigencia_dias   INTEGER DEFAULT NULL,
      created_at      TIMESTAMPTZ DEFAULT NOW(),
      updated_at      TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id)
    );
    -- Seed de rewards_config: ya NO se siembra aquí con el tenant legado
    -- 'xabor-principal' (incidente P0, seguimiento Rewards en el prompt).
    -- Tras la migración 013 los tenant_id reales son negocio_id (UUID); el
    -- seed por negocio vive más abajo, junto al seed de 'configuracion' de
    -- Nonna Maye, reusando el mismo negocioId ya resuelto por slug.

    CREATE TABLE IF NOT EXISTS rewards_accounts (
      id                      SERIAL PRIMARY KEY,
      telefono                VARCHAR(20) REFERENCES clientes(telefono) ON DELETE CASCADE,
      tenant_id               TEXT NOT NULL DEFAULT 'xabor-principal',
      puntos_balance          INTEGER NOT NULL DEFAULT 0,
      puntos_acumulados_total INTEGER NOT NULL DEFAULT 0,
      puntos_canjeados_total  INTEGER NOT NULL DEFAULT 0,
      activo                  BOOLEAN DEFAULT TRUE,
      created_at              TIMESTAMPTZ DEFAULT NOW(),
      updated_at              TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(telefono, tenant_id)
    );
    CREATE INDEX IF NOT EXISTS idx_rewards_accounts_telefono ON rewards_accounts(telefono);
    CREATE INDEX IF NOT EXISTS idx_rewards_accounts_tenant   ON rewards_accounts(tenant_id);

    CREATE TABLE IF NOT EXISTS rewards_movements (
      id               SERIAL PRIMARY KEY,
      account_id       INTEGER NOT NULL REFERENCES rewards_accounts(id) ON DELETE CASCADE,
      tenant_id        TEXT NOT NULL DEFAULT 'xabor-principal',
      tipo             TEXT NOT NULL CHECK (tipo IN (
                         'acumulacion','canje','ajuste_positivo',
                         'ajuste_negativo','expiracion','reverso')),
      puntos           INTEGER NOT NULL,
      balance_anterior INTEGER NOT NULL,
      balance_posterior INTEGER NOT NULL,
      folio_venta      VARCHAR(20),
      usuario          TEXT,
      motivo           TEXT,
      metadata         JSONB,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE(tenant_id, folio_venta, tipo)
    );
    -- Migración: reemplazar UNIQUE global por índice parcial que solo protege
    -- acumulacion y canje (un folio puede tener varios reversos).
    ALTER TABLE rewards_movements DROP CONSTRAINT IF EXISTS rewards_movements_tenant_id_folio_venta_tipo_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_rewards_movements_no_dup
      ON rewards_movements(tenant_id, folio_venta, tipo)
      WHERE tipo IN ('acumulacion','canje');
    CREATE INDEX IF NOT EXISTS idx_rewards_movements_account ON rewards_movements(account_id);
    CREATE INDEX IF NOT EXISTS idx_rewards_movements_folio   ON rewards_movements(folio_venta);
    CREATE INDEX IF NOT EXISTS idx_rewards_movements_tenant  ON rewards_movements(tenant_id, created_at DESC);
  `);

  // ─── Seed inicial de configuracion (Nonna Maye) ──────────────────────────
  // Requiere que el negocio 'nonna-maye' ya exista (migraciones 003/004).
  // initDB() debe seguir siendo seguro de llamar en cualquier estado de
  // migración y NUNCA debe bloquear el resto de la cadena de arranque
  // (seedMenuDesdeJSON/cargarPedidosDesdeDB/cargarConfig/cargarIntegraciones
  // corren después de initDB() en server.js) — por eso nunca se relanza el
  // error aquí. Nunca se hardcodea el UUID: siempre se resuelve por slug.
  try {
    const { rows } = await pool.query('SELECT id FROM negocios WHERE slug = $1', ['nonna-maye']);
    const negocioId = rows[0]?.id;
    if (negocioId) {
      await pool.query(
        `INSERT INTO configuracion (negocio_id, clave, valor) VALUES
           ($1, 'nombre',        'Restaurante Xabor'),
           ($1, 'nombre_corto',  'XABOR'),
           ($1, 'direccion',     'Lib. Manuel Perez Trevino 2416 Local 4'),
           ($1, 'ciudad',        'Col. Tecnologico, Piedras Negras, Coah.'),
           ($1, 'rfc',           'CAOM940122PTA'),
           ($1, 'telefono',      '(878) 109-1115'),
           ($1, 'whatsapp',      '(878) 109-1115'),
           ($1, 'horario',       'lunes a sabado 11am-10pm'),
           ($1, 'bot_avisos',    ''),
           ($1, 'print_agent_legacy_activo', 'true')
         ON CONFLICT (negocio_id, clave) DO NOTHING`,
        [negocioId]
      );

      // Seed de rewards_config por negocio (incidente P0, seguimiento
      // Rewards en el prompt) -- tenant_id = negocio_id real de Nonna Maye,
      // nunca 'xabor-principal'. DO NOTHING si ya existe: jamás pisa los
      // valores personalizados que Nonna Maye ya haya configurado desde el
      // panel (p. ej. puntos_por_peso/canje_minimo distintos de fábrica).
      // No siembra nada para ningún otro negocio -- este bloque solo corre
      // con el negocioId de Nonna Maye, resuelto arriba por slug.
      await pool.query(
        `INSERT INTO rewards_config (tenant_id) VALUES ($1) ON CONFLICT (tenant_id) DO NOTHING`,
        [negocioId]
      );
    } else {
      // La tabla 'negocios' existe pero no tiene un negocio con slug
      // 'nonna-maye' — esto SÍ es un problema real (migración 003 corrida
      // sin su seed, o slug cambiado). Falla de forma visible en el log,
      // pero controlada: no se relanza el error, initDB() continúa.
      console.error("[DB] ⚠ ADVERTENCIA: no existe un negocio con slug 'nonna-maye' — el seed de configuración inicial NO se aplicó. Verifica que 003_multiempresa_seed.sql haya sido ejecutada.");
    }
  } catch (e) {
    // Caso esperado antes de aplicar la migración 003: la tabla 'negocios'
    // todavía no existe. No es un error real — es un estado de migración
    // pendiente, no de un fallo silencioso de datos.
    console.log("[DB] Tabla 'negocios' aún no disponible — seed de configuración por negocio pendiente hasta aplicar las migraciones 003/004:", e.message);
  }

  // ─── Xabor Finanzas — tablas SAT (módulo independiente) ──────────────────
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sat_accounts (
      id                      SERIAL PRIMARY KEY,
      negocio_id              VARCHAR(50) NOT NULL DEFAULT 'default',
      rfc                     VARCHAR(13) NOT NULL,
      certificate_serial      VARCHAR(40),
      certificate_expiration  TIMESTAMP,
      encrypted_key_reference TEXT,
      active                  BOOLEAN DEFAULT TRUE,
      created_at              TIMESTAMP DEFAULT NOW(),
      updated_at              TIMESTAMP DEFAULT NOW(),
      UNIQUE(negocio_id, rfc)
    );

    CREATE TABLE IF NOT EXISTS sat_download_requests (
      id              SERIAL PRIMARY KEY,
      negocio_id      VARCHAR(50) NOT NULL DEFAULT 'default',
      sat_request_id  VARCHAR(100),
      fecha_inicial   TIMESTAMP NOT NULL,
      fecha_final     TIMESTAMP NOT NULL,
      download_type   VARCHAR(20) NOT NULL DEFAULT 'recibidos',
      status          VARCHAR(30) NOT NULL DEFAULT 'pendiente',
      requested_at    TIMESTAMP DEFAULT NOW(),
      last_checked_at TIMESTAMP,
      completed_at    TIMESTAMP,
      error_code      VARCHAR(20),
      error_message   TEXT
    );

    CREATE TABLE IF NOT EXISTS sat_packages (
      id                  SERIAL PRIMARY KEY,
      download_request_id INTEGER NOT NULL REFERENCES sat_download_requests(id) ON DELETE CASCADE,
      sat_package_id      VARCHAR(100) NOT NULL,
      status              VARCHAR(30) NOT NULL DEFAULT 'pendiente',
      storage_path        TEXT,
      downloaded_at       TIMESTAMP,
      processed_at        TIMESTAMP,
      error_message       TEXT,
      UNIQUE(sat_package_id)
    );

    CREATE TABLE IF NOT EXISTS invoices (
      id                     SERIAL PRIMARY KEY,
      negocio_id             VARCHAR(50) NOT NULL DEFAULT 'default',
      uuid                   VARCHAR(36) NOT NULL,
      version_cfdi           VARCHAR(5),
      fecha_emision          TIMESTAMP,
      fecha_timbrado         TIMESTAMP,
      rfc_emisor             VARCHAR(13),
      nombre_emisor          TEXT,
      rfc_receptor           VARCHAR(13),
      nombre_receptor        TEXT,
      subtotal               DECIMAL(14,2),
      descuento              DECIMAL(14,2) DEFAULT 0,
      impuestos_trasladados  DECIMAL(14,2) DEFAULT 0,
      impuestos_retenidos    DECIMAL(14,2) DEFAULT 0,
      total                  DECIMAL(14,2),
      moneda                 VARCHAR(3) DEFAULT 'MXN',
      tipo_cambio            DECIMAL(14,6) DEFAULT 1,
      tipo_comprobante       VARCHAR(1),
      metodo_pago            VARCHAR(3),
      forma_pago             VARCHAR(3),
      uso_cfdi               VARCHAR(4),
      serie                  VARCHAR(25),
      folio                  VARCHAR(40),
      exportacion            VARCHAR(2),
      fiscal_status          VARCHAR(30) DEFAULT 'vigente',
      xml_storage_path       TEXT,
      source                 VARCHAR(30) DEFAULT 'sat_descarga',
      imported_at            TIMESTAMP DEFAULT NOW(),
      CONSTRAINT uq_invoice_uuid UNIQUE (negocio_id, uuid)
    );

    CREATE TABLE IF NOT EXISTS invoice_items (
      id               SERIAL PRIMARY KEY,
      invoice_id       INTEGER NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
      clave_prod_serv  VARCHAR(8),
      no_identificacion VARCHAR(100),
      descripcion      TEXT,
      cantidad         DECIMAL(14,6),
      clave_unidad     VARCHAR(4),
      unidad           VARCHAR(20),
      valor_unitario   DECIMAL(14,6),
      importe          DECIMAL(14,2),
      descuento        DECIMAL(14,2) DEFAULT 0,
      objeto_impuesto  VARCHAR(2)
    );

    CREATE INDEX IF NOT EXISTS idx_invoices_negocio_fecha    ON invoices(negocio_id, fecha_emision DESC);
    CREATE INDEX IF NOT EXISTS idx_invoices_rfc_emisor       ON invoices(negocio_id, rfc_emisor);
    CREATE INDEX IF NOT EXISTS idx_invoices_tipo             ON invoices(negocio_id, tipo_comprobante);
    CREATE INDEX IF NOT EXISTS idx_sat_requests_negocio      ON sat_download_requests(negocio_id, requested_at DESC);
  `);

  console.log('[DB] Tablas listas');
}

// ─── Menú — seed desde JSON ───────────────────────────────────────────────────
// negocioId es OBLIGATORIO — nunca se inserta una categoría/producto sin
// negocio. Si no se entrega, la función se niega a insertar nada (falla
// controlada, no silenciosa) en vez de asumir un negocio por defecto.
export async function seedMenuDesdeJSON(menuJSON, negocioId) {
  if (!negocioId) {
    console.error('[DB] seedMenuDesdeJSON: negocioId requerido — no se sembró ningún dato.');
    return;
  }
  try {
    const { rows } = await pool.query('SELECT COUNT(*) FROM menu_categorias WHERE negocio_id = $1', [negocioId]);
    if (parseInt(rows[0].count) > 0) return; // Ya hay datos para este negocio, no sobreescribir
    for (let i = 0; i < menuJSON.categorias.length; i++) {
      const cat = menuJSON.categorias[i];
      const { rows: [{ id: catId }] } = await pool.query(
        'INSERT INTO menu_categorias (negocio_id, nombre, orden) VALUES ($1, $2, $3) RETURNING id',
        [negocioId, cat.nombre, i]
      );
      for (let j = 0; j < cat.productos.length; j++) {
        const p = cat.productos[j];
        const opciones = p.opciones ? JSON.stringify(p.opciones) : null;
        await pool.query(
          `INSERT INTO menu_productos (negocio_id, categoria_id, codigo, nombre, descripcion, precio, disponible, opciones, orden)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [negocioId, catId, p.id, p.nombre, p.descripcion || '', p.precio, p.disponible !== false, opciones, j]
        );
      }
    }
    console.log('[DB] Menú importado desde JSON');
  } catch(e) {
    console.error('[DB] Error seedMenuDesdeJSON:', e.message);
  }
}

// ─── Menú — lectura ───────────────────────────────────────────────────────────
export async function obtenerMenuCompleto(negocioId) {
  try {
    const id = negocioId || await resolverNegocioActualId();
    const cats = await pool.query(
      'SELECT * FROM menu_categorias WHERE activa = TRUE AND negocio_id = $1 ORDER BY orden',
      [id]
    );
    const prods = await pool.query(
      `SELECT p.* FROM menu_productos p
       JOIN menu_categorias c ON c.id = p.categoria_id
       WHERE c.activa = TRUE AND p.negocio_id = $1 ORDER BY p.orden`,
      [id]
    );
    // Cargar modificadores de todos los productos de una sola vez
    const prodIds = prods.rows.map(p => p.id);
    let gruposMap = {};
    if (prodIds.length) {
      const { rows: grupos } = await pool.query(
        `SELECT * FROM menu_modificadores_grupos WHERE producto_id = ANY($1) AND negocio_id = $2 ORDER BY producto_id, orden, id`,
        [prodIds, id]
      );
      const grupoIds = grupos.map(g => g.id);
      let opcionesMap = {};
      if (grupoIds.length) {
        const { rows: opciones } = await pool.query(
          `SELECT * FROM menu_modificadores_opciones WHERE grupo_id = ANY($1) AND disponible=TRUE AND negocio_id = $2 ORDER BY grupo_id, orden, id`,
          [grupoIds, id]
        );
        for (const o of opciones) {
          if (!opcionesMap[o.grupo_id]) opcionesMap[o.grupo_id] = [];
          opcionesMap[o.grupo_id].push(o);
        }
      }
      for (const g of grupos) {
        g.opciones = opcionesMap[g.id] || [];
        if (!gruposMap[g.producto_id]) gruposMap[g.producto_id] = [];
        gruposMap[g.producto_id].push(g);
      }
    }
    return cats.rows.map(c => ({
      ...c,
      productos: prods.rows
        .filter(p => p.categoria_id === c.id)
        .map(p => ({ ...p, modificadores: gruposMap[p.id] || [] }))
    }));
  } catch(e) {
    console.error('[DB] obtenerMenuCompleto:', e.message);
    return [];
  }
}

// ─── Menú — CRUD modificadores ────────────────────────────────────────────────
// Todas reciben negocioId opcional; si no se entrega, usan el negocio actual
// (resolverNegocioActualId), igual que obtenerConfiguracion/obtenerMenuCompleto.
export async function obtenerModificadoresProducto(productoId, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();

  const { rows: prodRows } = await pool.query(
    'SELECT id FROM menu_productos WHERE id=$1 AND negocio_id=$2', [productoId, negId]
  );
  if (!prodRows[0]) return [];

  const { rows: grupos } = await pool.query(
    `SELECT * FROM menu_modificadores_grupos WHERE producto_id=$1 AND negocio_id=$2 ORDER BY orden, id`,
    [productoId, negId]
  );
  for (const g of grupos) {
    const { rows } = await pool.query(
      `SELECT * FROM menu_modificadores_opciones WHERE grupo_id=$1 AND negocio_id=$2 ORDER BY orden, id`,
      [g.id, negId]
    );
    g.opciones = rows;
  }
  return grupos;
}

export async function crearGrupoModificador(productoId, { nombre, requerido=false, minimo=0, maximo=1 }, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();

  // negocio_id se deriva del producto padre — nunca se acepta suelto
  const { rows: prodRows } = await pool.query('SELECT negocio_id FROM menu_productos WHERE id=$1', [productoId]);
  if (!prodRows[0]) {
    throw new Error('crearGrupoModificador: producto no encontrado');
  }
  if (prodRows[0].negocio_id !== negId) {
    throw new Error('crearGrupoModificador: el producto no pertenece al negocio actual');
  }

  const { rows } = await pool.query(
    `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
     VALUES ($1,$2,$3,$4,$5,$6,(SELECT COALESCE(MAX(orden)+1,0) FROM menu_modificadores_grupos WHERE producto_id=$2))
     RETURNING *`,
    [negId, productoId, nombre, requerido, minimo, maximo]
  );
  return rows[0];
}

export async function actualizarGrupoModificador(grupoId, campos, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  const sets = [], vals = [];
  if (campos.nombre    !== undefined) { sets.push(`nombre=$${sets.length+1}`);    vals.push(campos.nombre); }
  if (campos.requerido !== undefined) { sets.push(`requerido=$${sets.length+1}`); vals.push(campos.requerido); }
  if (campos.minimo    !== undefined) { sets.push(`minimo=$${sets.length+1}`);    vals.push(campos.minimo); }
  if (campos.maximo    !== undefined) { sets.push(`maximo=$${sets.length+1}`);    vals.push(campos.maximo); }
  if (!sets.length) return;
  vals.push(grupoId, negId);
  await pool.query(`UPDATE menu_modificadores_grupos SET ${sets.join(',')} WHERE id=$${vals.length-1} AND negocio_id=$${vals.length}`, vals);
}

export async function eliminarGrupoModificador(grupoId, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  await pool.query('DELETE FROM menu_modificadores_grupos WHERE id=$1 AND negocio_id=$2', [grupoId, negId]);
}

export async function crearOpcionModificador(grupoId, { nombre, precio_extra=0, disponible=true }, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();

  // negocio_id se deriva del grupo padre — nunca se acepta suelto
  const { rows: grupoRows } = await pool.query('SELECT negocio_id FROM menu_modificadores_grupos WHERE id=$1', [grupoId]);
  if (!grupoRows[0]) {
    throw new Error('crearOpcionModificador: grupo no encontrado');
  }
  if (grupoRows[0].negocio_id !== negId) {
    throw new Error('crearOpcionModificador: el grupo no pertenece al negocio actual');
  }

  const { rows } = await pool.query(
    `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
     VALUES ($1,$2,$3,$4,$5,(SELECT COALESCE(MAX(orden)+1,0) FROM menu_modificadores_opciones WHERE grupo_id=$2))
     RETURNING *`,
    [negId, grupoId, nombre, precio_extra, disponible]
  );
  return rows[0];
}

export async function actualizarOpcionModificador(opcionId, campos, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  const sets = [], vals = [];
  if (campos.nombre       !== undefined) { sets.push(`nombre=$${sets.length+1}`);       vals.push(campos.nombre); }
  if (campos.precio_extra !== undefined) { sets.push(`precio_extra=$${sets.length+1}`); vals.push(campos.precio_extra); }
  if (campos.disponible   !== undefined) { sets.push(`disponible=$${sets.length+1}`);   vals.push(campos.disponible); }
  if (!sets.length) return;
  vals.push(opcionId, negId);
  await pool.query(`UPDATE menu_modificadores_opciones SET ${sets.join(',')} WHERE id=$${vals.length-1} AND negocio_id=$${vals.length}`, vals);
}

export async function eliminarOpcionModificador(opcionId, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  await pool.query('DELETE FROM menu_modificadores_opciones WHERE id=$1 AND negocio_id=$2', [opcionId, negId]);
}

// ─── Menú — CRUD categorías ───────────────────────────────────────────────────
export async function crearCategoria(nombre, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  const { rows } = await pool.query(
    `INSERT INTO menu_categorias (negocio_id, nombre, orden)
     VALUES ($1, $2, (SELECT COALESCE(MAX(orden)+1,0) FROM menu_categorias WHERE negocio_id=$1))
     RETURNING *`,
    [negId, nombre]
  );
  return rows[0];
}

export async function actualizarCategoria(id, campos, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  const sets = [], vals = [];
  if (campos.nombre    !== undefined) { sets.push(`nombre=$${sets.length+1}`);  vals.push(campos.nombre); }
  if (campos.activa    !== undefined) { sets.push(`activa=$${sets.length+1}`);  vals.push(campos.activa); }
  if (campos.orden     !== undefined) { sets.push(`orden=$${sets.length+1}`);   vals.push(campos.orden); }
  if (!sets.length) return;
  vals.push(id, negId);
  await pool.query(`UPDATE menu_categorias SET ${sets.join(',')} WHERE id=$${vals.length-1} AND negocio_id=$${vals.length}`, vals);
}

export async function eliminarCategoria(id, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  await pool.query('DELETE FROM menu_categorias WHERE id=$1 AND negocio_id=$2', [id, negId]);
}

// ─── Menú — CRUD productos ────────────────────────────────────────────────────
export async function crearProducto(datos, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  const { categoria_id, nombre, descripcion, precio, disponible, opciones, agotado, destacado } = datos;

  // negocio_id se deriva de la categoría padre — nunca se acepta suelto desde datos
  const { rows: catRows } = await pool.query('SELECT negocio_id FROM menu_categorias WHERE id=$1', [categoria_id]);
  if (!catRows[0]) {
    throw new Error('crearProducto: categoría no encontrada');
  }
  if (catRows[0].negocio_id !== negId) {
    throw new Error('crearProducto: la categoría no pertenece al negocio actual');
  }

  const { rows } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, descripcion, precio, disponible, opciones, orden, agotado, destacado)
     VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(orden)+1,0) FROM menu_productos WHERE categoria_id=$2),$8,$9)
     RETURNING *`,
    [negId, categoria_id, nombre, descripcion||'', precio, disponible!==false, opciones ? JSON.stringify(opciones) : null, agotado===true, destacado===true]
  );
  return rows[0];
}

export async function actualizarProducto(id, campos, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();

  // Si se intenta mover el producto a otra categoría, esa categoría debe ser del mismo negocio
  if (campos.categoria_id !== undefined) {
    const { rows: catRows } = await pool.query('SELECT negocio_id FROM menu_categorias WHERE id=$1', [campos.categoria_id]);
    if (!catRows[0]) {
      throw new Error('actualizarProducto: categoría destino no encontrada');
    }
    if (catRows[0].negocio_id !== negId) {
      throw new Error('actualizarProducto: la categoría destino no pertenece al negocio actual');
    }
  }

  const sets = [], vals = [];
  if (campos.nombre       !== undefined) { sets.push(`nombre=$${sets.length+1}`);       vals.push(campos.nombre); }
  if (campos.descripcion  !== undefined) { sets.push(`descripcion=$${sets.length+1}`);  vals.push(campos.descripcion); }
  if (campos.precio       !== undefined) { sets.push(`precio=$${sets.length+1}`);       vals.push(campos.precio); }
  if (campos.disponible   !== undefined) { sets.push(`disponible=$${sets.length+1}`);   vals.push(campos.disponible); }
  if (campos.categoria_id !== undefined) { sets.push(`categoria_id=$${sets.length+1}`); vals.push(campos.categoria_id); }
  if (campos.agotado      !== undefined) { sets.push(`agotado=$${sets.length+1}`);      vals.push(campos.agotado === true); }
  if (campos.destacado    !== undefined) { sets.push(`destacado=$${sets.length+1}`);    vals.push(campos.destacado === true); }
  if (campos.orden        !== undefined) { sets.push(`orden=$${sets.length+1}`);        vals.push(campos.orden); }
  if (!sets.length) return;
  vals.push(id, negId);
  await pool.query(`UPDATE menu_productos SET ${sets.join(',')} WHERE id=$${vals.length-1} AND negocio_id=$${vals.length}`, vals);
}

export async function eliminarProducto(id, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  await pool.query('DELETE FROM menu_productos WHERE id=$1 AND negocio_id=$2', [id, negId]);
}

// Duplica un producto (Fase 3: acción "duplicar") junto con sus grupos y
// opciones de modificadores -- copia completa, no solo el registro base,
// para que un producto con variantes complejas no se tenga que rearmar a
// mano. El nuevo producto queda "Copia de <nombre>" y disponible=false
// por defecto: el negocio debe revisarlo/activarlo, nunca aparece
// automáticamente en el catálogo que ve el bot.
export async function duplicarProducto(id, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  const { rows: [original] } = await pool.query(
    'SELECT * FROM menu_productos WHERE id=$1 AND negocio_id=$2', [id, negId]
  );
  if (!original) throw new Error('duplicarProducto: producto no encontrado');

  const { rows: [copia] } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, descripcion, precio, disponible, opciones, orden, agotado, destacado)
     VALUES ($1,$2,$3,$4,$5,FALSE,$6,(SELECT COALESCE(MAX(orden)+1,0) FROM menu_productos WHERE categoria_id=$2),FALSE,FALSE)
     RETURNING *`,
    [negId, original.categoria_id, `Copia de ${original.nombre}`, original.descripcion, original.precio, original.opciones]
  );

  const { rows: grupos } = await pool.query(
    'SELECT * FROM menu_modificadores_grupos WHERE producto_id=$1 AND negocio_id=$2 ORDER BY orden, id', [id, negId]
  );
  for (const g of grupos) {
    const { rows: [grupoCopia] } = await pool.query(
      `INSERT INTO menu_modificadores_grupos (negocio_id, producto_id, nombre, requerido, minimo, maximo, orden)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [negId, copia.id, g.nombre, g.requerido, g.minimo, g.maximo, g.orden]
    );
    const { rows: opciones } = await pool.query(
      'SELECT * FROM menu_modificadores_opciones WHERE grupo_id=$1 AND negocio_id=$2 ORDER BY orden, id', [g.id, negId]
    );
    for (const o of opciones) {
      await pool.query(
        `INSERT INTO menu_modificadores_opciones (negocio_id, grupo_id, nombre, precio_extra, disponible, orden)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [negId, grupoCopia.id, o.nombre, o.precio_extra, o.disponible, o.orden]
      );
    }
  }
  return copia;
}

// ─── Push Notifications ───────────────────────────────────────────────────────
// negocioId OBLIGATORIO — falla cerrado (Auditoría P0 complementaria, push).
// ON CONFLICT (endpoint) SÍ reescribe negocio_id a propósito, a diferencia
// de clientes/repartidores: el endpoint es prueba de que la request viene
// de una sesión autenticada real (requireAuthSeguro ya validó negocioId
// antes de llamar aquí) -- si el mismo navegador se resuscribe bajo otro
// negocio (cambio de negocio legítimo), es correcto que la fila se
// reasigne, no es un vector de secuestro como sí lo sería con un teléfono
// que cualquiera puede enviar sin probar nada.
export async function guardarSuscripcionPush({ endpoint, auth, p256dh }, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] guardarSuscripcionPush: negocioId inválido u omitido — rechazado, no se guarda sin negocio');
    return false;
  }
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, auth, p256dh, negocio_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (endpoint) DO UPDATE SET auth=$2, p256dh=$3, negocio_id=$4`,
    [endpoint, auth, p256dh, negocioId.trim()]
  );
  return true;
}

export async function obtenerSuscripcionesPush(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerSuscripcionesPush: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  const { rows } = await pool.query(
    'SELECT endpoint, auth, p256dh FROM push_subscriptions WHERE negocio_id = $1',
    [negocioId.trim()]
  );
  return rows;
}

// Borra solo si el endpoint pertenece al negocio indicado -- nunca borra
// una suscripción ajena aunque el endpoint coincida (no debería, es un
// valor único, pero se valida en vez de asumir).
export async function eliminarSuscripcionPush(endpoint, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] eliminarSuscripcionPush: negocioId inválido u omitido — rechazado, no se borra sin negocio');
    return false;
  }
  const { rowCount } = await pool.query(
    'DELETE FROM push_subscriptions WHERE endpoint=$1 AND negocio_id=$2',
    [endpoint, negocioId.trim()]
  );
  return rowCount > 0;
}

// ─── Obtener cliente por teléfono ─────────────────────────────────────────────
// negocioId OBLIGATORIO — falla cerrado (Incidente P0 de aislamiento).
// Compatibilidad TEMPORAL y limitada a Nonna Maye para los 2 clientes con
// negocio_id NULL (mismo criterio que _esNonnaMaye en mensajes) — no se
// reasignan todavía, solo siguen visibles para Nonna Maye.
export async function obtenerCliente(telefono, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerCliente: negocioId inválido u omitido — rechazado, sin consulta global');
    return null;
  }
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;
    const result = await pool.query(
      'SELECT * FROM clientes WHERE telefono = $1 AND (negocio_id = $2 OR ($3::boolean AND negocio_id IS NULL))',
      [telefono, negocioId, incluirNull]
    );
    return result.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerCliente:', e.message);
    return null;
  }
}

// ─── Crear o actualizar cliente ───────────────────────────────────────────────
// negocioId (Fase 5 — threading operativo): clientes.telefono sigue siendo
// la única PK, global (sin negocio_id en la llave) — no se cambia aquí, no
// hay migración en esta tarea. Por eso el UPDATE del ON CONFLICT NUNCA
// reescribe negocio_id: si dos negocios llegaran a compartir un mismo
// teléfono real (posible hoy porque la tabla no aísla clientes por
// negocio), sobreescribir el dueño en cada visita mezclaría datos entre
// negocios. Solo el INSERT (primera vez que se ve ese teléfono) fija
// negocio_id. Para Rappi esto es seguro sin excepción: su teléfono
// sintético `rappi-{orderId}` es único por diseño (Rappi nunca repite un
// order_id entre tiendas), así que un mismo teléfono nunca pertenece a dos
// pedidos de negocios distintos — el caso de "conflicto entre negocios"
// solo podría darse con números reales de WhatsApp, fuera del alcance de
// esta tarea. BLOQUEO DOCUMENTADO: un aislamiento real de clientes por
// negocio requeriría que la identidad del cliente deje de depender solo de
// telefono (p. ej. clave compuesta o tabla puente cliente↔negocio) — eso
// es una migración de esquema, no se hace aquí.
export async function upsertCliente(telefono, nombre, negocioId) {
  try {
    await pool.query(`
      INSERT INTO clientes (telefono, nombre, ultima_visita, negocio_id)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (telefono) DO UPDATE SET
        nombre = COALESCE(NULLIF($2, ''), clientes.nombre),
        ultima_visita = NOW()
    `, [telefono, nombre || null, negocioId || null]);
  } catch (e) {
    console.error('[DB] Error upsertCliente:', e.message);
  }
}

// ─── Control manual del bot por conversación ──────────────────────────────────
// negocioId OBLIGATORIO — falla cerrado (Incidente P0). Antes cualquier
// negocio podía pausar/reactivar el bot de un cliente de OTRO negocio con
// solo conocer su teléfono, y de paso creaba clientes nuevos con
// negocio_id NULL. El WHERE del ON CONFLICT hace que la escritura sea un
// no-op si el teléfono ya pertenece a otro negocio (nunca lo reasigna).
export async function setBotPausado(telefono, pausado, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] setBotPausado: negocioId inválido u omitido — rechazado, no se escribe sin negocio');
    return false;
  }
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;
    const { rowCount } = await pool.query(`
      INSERT INTO clientes (telefono, bot_pausado, negocio_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (telefono) DO UPDATE SET bot_pausado = $2
        WHERE clientes.negocio_id = $3 OR ($4::boolean AND clientes.negocio_id IS NULL)
    `, [telefono, pausado, negocioId, incluirNull]);
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Error setBotPausado:', e.message);
    return false;
  }
}

// negocioId OBLIGATORIO — falla cerrado (Incidente P0). Sin esto, cualquier
// negocio podía marcar/desmarcar como "interno" al cliente de OTRO negocio
// con solo conocer su teléfono (escritura sin validar dueño).
export async function toggleClienteInterno(telefono, esInterno, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] toggleClienteInterno: negocioId inválido u omitido — rechazado, no se escribe sin negocio');
    return false;
  }
  const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
  const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;
  const { rowCount } = await pool.query(
    'UPDATE clientes SET es_interno = $1 WHERE telefono = $2 AND (negocio_id = $3 OR ($4::boolean AND negocio_id IS NULL))',
    [esInterno, telefono, negocioId, incluirNull]
  );
  return rowCount > 0;
}

// Fase de piloto (auditoría de aislamiento del chat manual): antes
// consultaba bot_pausado por teléfono SIN filtrar por negocio -- un
// staff de cualquier negocio con el módulo whatsapp podía consultar el
// estado de pausa de un teléfono de OTRO negocio. negocioId ahora es
// obligatorio; mismo criterio de compatibilidad que obtenerConversacion
// para los clientes de Nonna Maye anteriores a la migración 007 (única
// excepción real de negocio_id NULL en clientes).
export async function getBotPausado(telefono, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] getBotPausado: negocioId inválido u omitido — rechazado (fail closed)');
    return false;
  }
  try {
    const incluirNull = await _esNonnaMaye(negocioId);
    const result = await pool.query(
      'SELECT bot_pausado FROM clientes WHERE telefono = $1 AND (negocio_id = $2 OR ($3::boolean AND negocio_id IS NULL))',
      [telefono, negocioId.trim(), incluirNull]
    );
    return result.rows[0]?.bot_pausado || false;
  } catch (e) {
    console.error('[DB] Error getBotPausado:', e.message);
    return false;
  }
}

// ─── Link de pago pendiente (pedidos por voz/WhatsApp) ───────────────────────
// negocioId OBLIGATORIO — falla cerrado (Incidente P0, causa raíz confirmada
// del enlace de pago de Nonna Maye enviado a un cliente de Alora). Mismo
// patrón que setBotPausado/obtenerCliente: clientes.telefono sigue siendo
// la única PK real (global), así que sin este chequeo de dueño cualquier
// negocio podía leer o pisar el "pago pendiente" del cliente de OTRO
// negocio con solo compartir número de teléfono real.
export async function setPagoPendiente(telefono, pedidoId, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] setPagoPendiente: negocioId inválido u omitido — rechazado, no se escribe sin negocio');
    return false;
  }
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;
    const { rowCount } = await pool.query(`
      INSERT INTO clientes (telefono, pedido_pago_pendiente, negocio_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (telefono) DO UPDATE SET pedido_pago_pendiente = $2
        WHERE clientes.negocio_id = $3 OR ($4::boolean AND clientes.negocio_id IS NULL)
    `, [telefono, pedidoId, negocioId, incluirNull]);
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Error setPagoPendiente:', e.message);
    return false;
  }
}

export async function getPagoPendiente(telefono, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] getPagoPendiente: negocioId inválido u omitido — rechazado, sin consulta global');
    return null;
  }
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;
    const result = await pool.query(
      'SELECT pedido_pago_pendiente FROM clientes WHERE telefono = $1 AND (negocio_id = $2 OR ($3::boolean AND negocio_id IS NULL))',
      [telefono, negocioId, incluirNull]
    );
    return result.rows[0]?.pedido_pago_pendiente || null;
  } catch (e) {
    console.error('[DB] Error getPagoPendiente:', e.message);
    return null;
  }
}

export async function clearPagoPendiente(telefono, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] clearPagoPendiente: negocioId inválido u omitido — rechazado, no se escribe sin negocio');
    return false;
  }
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;
    const { rowCount } = await pool.query(
      'UPDATE clientes SET pedido_pago_pendiente = NULL WHERE telefono = $1 AND (negocio_id = $2 OR ($3::boolean AND negocio_id IS NULL))',
      [telefono, negocioId, incluirNull]
    );
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Error clearPagoPendiente:', e.message);
    return false;
  }
}

// ─── Guardar pedido ───────────────────────────────────────────────────────────
// negocioId (Fase 5): pedidos.id es SERIAL (PK autogenerada) y no hay
// ninguna restricción UNIQUE real sobre folio en esta tabla — el
// ON CONFLICT DO NOTHING existente no se toca ni se le inventa un target,
// solo se agrega negocio_id a la lista de columnas del INSERT.
export async function guardarPedido(telefono, pedido, negocioId) {
  try {
    await pool.query(`
      INSERT INTO pedidos (telefono, items, total, modalidad, canal, forma_pago, nombre_cliente, costo_envio, folio, negocio_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      ON CONFLICT DO NOTHING
    `, [
      telefono,
      JSON.stringify(pedido.items),
      pedido.total,
      pedido.modalidad,
      pedido.canal,
      pedido.forma_pago || pedido.cliente?.forma_pago || null,
      pedido.cliente?.nombre || null,
      pedido.costo_envio || 0,
      pedido.id || null,
      negocioId || null
    ]);
  } catch (e) {
    console.error('[DB] Error guardarPedido:', e.message);
  }
}

// ─── Historial de pedidos entregados ─────────────────────────────────────────
// negocioId OBLIGATORIO — falla cerrado (sin consulta global) si falta.
export async function obtenerPedidosEntregados(limite = 100, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerPedidosEntregados: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  const negocioIdNorm = negocioId.trim();
  try {
    const result = await pool.query(`
      SELECT folio, estado, datos, updated_at
      FROM pedidos_activos
      WHERE estado IN ('entregado', 'cancelado')
        AND negocio_id = $2
      ORDER BY updated_at DESC
      LIMIT $1
    `, [limite, negocioIdNorm]);
    return result.rows.map(r => ({ ...r.datos, entregado_at: r.updated_at, _estado: r.estado }));
  } catch (e) {
    console.error('[DB] Error obtenerPedidosEntregados:', e.message);
    return [];
  }
}

// ─── Cancelar pedido activo ────────────────────────────────────────────────────
// negocioId OBLIGATORIO — falla cerrado (Auditoría P0, mutaciones por folio).
// El folio por sí solo nunca autoriza: la fila solo se toca si además
// pertenece al negocio de la sesión. Un folio ajeno se comporta idéntico
// a un folio inexistente (false), para que la ruta responda 404 sin
// revelar cuál de los dos casos ocurrió.
export async function cancelarPedidoActivo(folio, motivo, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] cancelarPedidoActivo: negocioId inválido u omitido — rechazado, no se modifica sin negocio');
    return false;
  }
  try {
    const { rowCount } = await pool.query(`
      UPDATE pedidos_activos
      SET estado = 'cancelado',
          datos  = jsonb_set(datos, '{cancelacion}', $2::jsonb),
          updated_at = NOW()
      WHERE folio = $1 AND negocio_id = $3 AND estado NOT IN ('entregado', 'cancelado')
    `, [folio, JSON.stringify({ motivo, timestamp: new Date().toISOString() }), negocioId.trim()]);
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Error cancelarPedidoActivo:', e.message);
    return false;
  }
}

// ─── Registrar devolución en pedido entregado ─────────────────────────────────
// negocioId OBLIGATORIO — mismo criterio que cancelarPedidoActivo.
export async function registrarDevolucion(folio, monto, motivo, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] registrarDevolucion: negocioId inválido u omitido — rechazado, no se modifica sin negocio');
    return false;
  }
  try {
    const { rowCount } = await pool.query(`
      UPDATE pedidos_activos
      SET datos = jsonb_set(datos, '{devolucion}', $2::jsonb),
          updated_at = NOW()
      WHERE folio = $1 AND negocio_id = $3 AND estado = 'entregado'
    `, [folio, JSON.stringify({ monto: parseFloat(monto), motivo, timestamp: new Date().toISOString() }), negocioId.trim()]);
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Error registrarDevolucion:', e.message);
    return false;
  }
}

// ─── Consultas para POS ───────────────────────────────────────────────────────
// negocioId OBLIGATORIO — falla cerrado (sin consulta global) si falta.
export async function obtenerVentas(desde, hasta, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerVentas: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  const negocioIdNorm = negocioId.trim();
  try {
    const result = await pool.query(`
      SELECT
        folio                                                              AS id,
        folio,
        estado,
        datos->'cliente'->>'telefono'                                      AS telefono,
        datos->'cliente'->>'nombre'                                        AS nombre_cliente,
        datos->'items'                                                     AS items,
        (datos->>'total')::decimal                                         AS total,
        datos->>'modalidad'                                                AS modalidad,
        datos->>'canal'                                                    AS canal,
        COALESCE(datos->>'forma_pago','no especificado')                   AS forma_pago,
        COALESCE((datos->>'costo_envio')::decimal, 0)                     AS costo_envio,
        COALESCE((datos->'devolucion'->>'monto')::decimal, 0)             AS devolucion_monto,
        datos->'devolucion'->>'motivo'                                     AS devolucion_motivo,
        datos->'cancelacion'->>'motivo'                                    AS cancelacion_motivo,
        created_at
      FROM pedidos_activos
      WHERE created_at >= $1 AND created_at <= $2
        AND estado != 'cancelado'
        AND negocio_id = $3
      ORDER BY created_at DESC
    `, [desde, hasta, negocioIdNorm]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerVentas:', e.message);
    return [];
  }
}

export async function obtenerResumenVentas(desde, hasta, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerResumenVentas: negocioId inválido u omitido — rechazado, sin consulta global');
    return {};
  }
  const negocioIdNorm = negocioId.trim();
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int                                                                              AS num_pedidos,
        COALESCE(SUM((datos->>'total')::decimal), 0)::float                                       AS total_ventas,
        COALESCE(SUM(COALESCE((datos->'devolucion'->>'monto')::decimal, 0)), 0)::float            AS total_devoluciones,
        COALESCE(AVG((datos->>'total')::decimal), 0)::float                                       AS promedio,
        COALESCE(SUM((datos->>'costo_envio')::decimal), 0)::float                                 AS total_envios,
        COUNT(*) FILTER (WHERE datos->>'modalidad' ILIKE '%domicilio%')::int                      AS domicilios,
        COUNT(*) FILTER (WHERE datos->>'modalidad' ILIKE '%recoger%'
                            OR datos->>'modalidad' ILIKE '%tienda%')::int                         AS recoger,
        COUNT(*) FILTER (WHERE estado = 'cancelado')::int                                         AS cancelados
      FROM pedidos_activos
      WHERE created_at >= $1 AND created_at <= $2
        AND estado != 'cancelado'
        AND negocio_id = $3
    `, [desde, hasta, negocioIdNorm]);
    return result.rows[0];
  } catch (e) {
    console.error('[DB] Error obtenerResumenVentas:', e.message);
    return {};
  }
}

// negocioId OBLIGATORIO — mismo criterio que cancelarPedidoActivo (Auditoría P0).
export async function actualizarFormaPago(folio, formaPago, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] actualizarFormaPago: negocioId inválido u omitido — rechazado, no se modifica sin negocio');
    return false;
  }
  try {
    const { rowCount } = await pool.query(`
      UPDATE pedidos_activos
      SET datos = jsonb_set(datos, '{forma_pago}', $2::jsonb), updated_at = NOW()
      WHERE folio = $1 AND negocio_id = $3
    `, [folio, JSON.stringify(formaPago), negocioId.trim()]);
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Error actualizarFormaPago:', e.message);
    return false;
  }
}

// ─── Mensajes WhatsApp ───────────────────────────────────────────────────────
// negocioId OBLIGATORIO en escritura y lectura — falla cerrado (Incidente P0
// de aislamiento, julio 2026). El negocio SIEMPRE viene de la sesión del
// llamador (req.negocioId) o de la resolución de canal (integraciones_canal),
// nunca de un valor enviado por el frontend.
// origen: 'cliente' | 'bot' | 'humano' | null (desconocido -- nunca se
// adivina). messageIdExterno: wamid de Meta, solo para entrantes --
// si Meta reentrega el mismo webhook, el índice único parcial
// (migración 020) hace que el segundo INSERT no inserte nada; se
// detecta por ON CONFLICT y se devuelve la fila ya existente en vez
// de null, para que el llamador pueda seguir su flujo normal sin
// tratarlo como error.
export async function guardarMensaje(telefono, nombre, direccion, texto, negocioId, origen = null, messageIdExterno = null, tipo = 'texto', documentoId = null) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] guardarMensaje: negocioId inválido u omitido — rechazado, no se escribe sin negocio');
    return null;
  }
  try {
    const result = await pool.query(`
      INSERT INTO mensajes (telefono, nombre, direccion, texto, negocio_id, origen, message_id_externo, tipo, documento_id)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (message_id_externo) WHERE message_id_externo IS NOT NULL DO NOTHING
      RETURNING *
    `, [telefono, nombre || null, direccion, texto, negocioId.trim(), origen || null, messageIdExterno || null, tipo, documentoId]);
    if (result.rows[0]) return result.rows[0];
    if (messageIdExterno) {
      // ON CONFLICT no insertó nada -- ya existía este message_id (Meta
      // reentregó el webhook). Devolvemos la fila existente, no null,
      // para que el llamador no lo trate como un fallo de guardado.
      const existente = await pool.query(`SELECT * FROM mensajes WHERE message_id_externo = $1`, [messageIdExterno]);
      if (existente.rows[0]) {
        console.log(`[DB] guardarMensaje: mensaje duplicado ignorado (message_id_externo ya existía)`);
        return existente.rows[0];
      }
    }
    return null;
  } catch (e) {
    console.error('[DB] Error guardarMensaje:', e.message);
    return null;
  }
}

// Compatibilidad TEMPORAL y estrictamente limitada a Nonna Maye: los 90
// mensajes con negocio_id NULL (previos a que WhatsApp empezara a escribir
// negocio_id) siguen siendo visibles solo para Nonna Maye — nunca para un
// negocio nuevo. No es un COALESCE global ni una conversión automática de
// NULL: la condición solo se activa si negocioId coincide exactamente con
// el id real de Nonna Maye, resuelto por slug (nunca hardcodeado). Instrucción
// explícita del incidente P0 — no reasignar esos registros todavía.
async function _esNonnaMaye(negocioId) {
  const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
  return !!nonnaMayeId && negocioId === nonnaMayeId;
}

export async function obtenerConversacion(telefono, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerConversacion: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  try {
    const incluirNull = await _esNonnaMaye(negocioId);
    const result = await pool.query(`
      SELECT m.*, d.id AS documento_id_real, d.filename AS documento_filename, d.size_bytes AS documento_size_bytes,
             d.estado AS documento_estado, d.caption AS documento_caption
      FROM mensajes m
      LEFT JOIN documentos d ON d.id = m.documento_id
      WHERE m.telefono = $1 AND (m.negocio_id = $2 OR ($3::boolean AND m.negocio_id IS NULL))
      ORDER BY m.timestamp ASC
    `, [telefono, negocioId, incluirNull]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerConversacion:', e.message);
    return [];
  }
}

// Clasifica la pertenencia antes de operar el control de una conversación.
// No crea clientes implícitamente: una conversación debe existir en mensajes
// o en clientes y pertenecer al negocio autenticado.
export async function obtenerPertenenciaConversacion(telefono, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return 'inexistente';
  const incluirNull = await _esNonnaMaye(negocioId);
  const { rows } = await pool.query(`
    SELECT
      EXISTS (SELECT 1 FROM mensajes WHERE telefono = $1 AND (negocio_id = $2 OR ($3::boolean AND negocio_id IS NULL)))
      OR EXISTS (SELECT 1 FROM clientes WHERE telefono = $1 AND (negocio_id = $2 OR ($3::boolean AND negocio_id IS NULL))) AS propia,
      EXISTS (SELECT 1 FROM mensajes WHERE telefono = $1)
      OR EXISTS (SELECT 1 FROM clientes WHERE telefono = $1) AS existe
  `, [telefono, negocioId.trim(), incluirNull]);
  return rows[0]?.propia ? 'propia' : (rows[0]?.existe ? 'ajena' : 'inexistente');
}

// ─── Documentos PDF en el chat ───────────────────────────────────────────────
// Mismo criterio de pertenencia que obtenerPertenenciaConversacion: nunca se
// confía en negocioId enviado por el frontend para decidir qué documento es
// visible -- siempre se resuelve contra la fila real en `documentos`.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function obtenerPertenenciaDocumento(documentoId, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return 'inexistente';
  if (typeof documentoId !== 'string' || !UUID_RE.test(documentoId)) return 'inexistente';
  const { rows } = await pool.query(
    `SELECT negocio_id FROM documentos WHERE id = $1`,
    [documentoId]
  );
  if (!rows[0]) return 'inexistente';
  return rows[0].negocio_id === negocioId.trim() ? 'propia' : 'ajena';
}

export async function obtenerDocumento(documentoId, negocioId) {
  const pertenencia = await obtenerPertenenciaDocumento(documentoId, negocioId);
  if (pertenencia !== 'propia') return null;
  const { rows } = await pool.query(`SELECT * FROM documentos WHERE id = $1`, [documentoId]);
  return rows[0] || null;
}

// Se llama ANTES de cualquier descarga/red (principio ya usado en el gate de
// atención automática: guardar primero). Dedup por wamid igual que
// guardarMensaje -- una reentrega del mismo webhook de Meta devuelve la fila
// existente en vez de duplicar.
export async function crearDocumentoPendiente({ negocioId, telefono, direccion, origen = null, filename, mimeType = 'application/pdf', caption = null, wamid = null, createdBy = null }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('crearDocumentoPendiente: negocioId requerido');
  const result = await pool.query(`
    INSERT INTO documentos (negocio_id, telefono, direccion, origen, estado, filename, mime_type, caption, wamid, created_by)
    VALUES ($1,$2,$3,$4,'pendiente',$5,$6,$7,$8,$9)
    ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING
    RETURNING *
  `, [negocioId.trim(), telefono, direccion, origen, filename, mimeType, caption, wamid, createdBy]);
  if (result.rows[0]) return result.rows[0];
  if (wamid) {
    const existente = await pool.query(`SELECT * FROM documentos WHERE wamid = $1`, [wamid]);
    if (existente.rows[0]) return existente.rows[0];
  }
  throw new Error('crearDocumentoPendiente: no se pudo insertar ni recuperar la fila existente');
}

// Documento saliente: a diferencia del entrante (que se crea 'pendiente'
// antes de descargar), el saliente ya tiene el archivo validado y subido a
// Meta antes de registrarse -- se crea directamente en 'listo'.
export async function crearDocumentoSaliente({ negocioId, telefono, filename, mimeType = 'application/pdf', sizeBytes, storageKey, caption = null, wamid = null, createdBy = null }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('crearDocumentoSaliente: negocioId requerido');
  const { rows } = await pool.query(`
    INSERT INTO documentos (negocio_id, telefono, direccion, origen, estado, filename, mime_type, size_bytes, storage_key, caption, wamid, created_by)
    VALUES ($1,$2,'saliente','humano','listo',$3,$4,$5,$6,$7,$8,$9)
    RETURNING *
  `, [negocioId.trim(), telefono, filename, mimeType, sizeBytes, storageKey, caption, wamid, createdBy]);
  return rows[0];
}

export async function marcarDocumentoListo(documentoId, { sizeBytes, storageKey }) {
  await pool.query(
    `UPDATE documentos SET estado = 'listo', size_bytes = $2, storage_key = $3 WHERE id = $1`,
    [documentoId, sizeBytes, storageKey]
  );
}

export async function marcarDocumentoError(documentoId, detalle) {
  await pool.query(
    `UPDATE documentos SET estado = 'error', error_detalle = $2 WHERE id = $1`,
    [documentoId, detalle]
  );
}

export async function vincularDocumentoACotizacion(documentoId, cotizacionId) {
  await pool.query(`UPDATE documentos SET cotizacion_id = $2 WHERE id = $1`, [documentoId, cotizacionId]);
}

export async function eliminarDocumentoRegistro(documentoId) {
  await pool.query(`DELETE FROM documentos WHERE id = $1`, [documentoId]);
}

// ─── Cotizaciones ────────────────────────────────────────────────────────────
export async function obtenerPertenenciaCotizacion(cotizacionId, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return 'inexistente';
  if (typeof cotizacionId !== 'string' || !UUID_RE.test(cotizacionId)) return 'inexistente';
  const { rows } = await pool.query(`SELECT negocio_id FROM cotizaciones WHERE id = $1`, [cotizacionId]);
  if (!rows[0]) return 'inexistente';
  return rows[0].negocio_id === negocioId.trim() ? 'propia' : 'ajena';
}

async function _obtenerItemsCotizacion(client, cotizacionId) {
  const { rows } = await client.query(
    `SELECT id, tipo, descripcion, cantidad, precio_unitario, descuento, orden
     FROM cotizacion_items WHERE cotizacion_id = $1 ORDER BY orden, id`,
    [cotizacionId]
  );
  return rows;
}

// Acepta tanto items en forma de fila de DB (precio_unitario) como items tal
// como llegan del body de la API (precioUnitario) -- ambas formas conviven
// según el llamador (crearCotizacion recibe la forma de API; actualizarCotizacion
// puede recibir cualquiera de las dos cuando reusa actual.items).
function _precioUnitario(it) { return Number(it.precio_unitario ?? it.precioUnitario ?? 0); }

function _calcularTotales(items, { impuestosPct = 0 } = {}) {
  const subtotal = items.reduce((acc, it) => acc + (Number(it.cantidad) * _precioUnitario(it) - Number(it.descuento || 0)), 0);
  const descuentos = items.reduce((acc, it) => acc + Number(it.descuento || 0), 0);
  const impuestos = Math.round(subtotal * (Number(impuestosPct) / 100) * 100) / 100;
  const total = Math.round((subtotal + impuestos) * 100) / 100;
  return { subtotal: Math.round(subtotal * 100) / 100, impuestos, descuentos, total };
}

export async function obtenerCotizacion(cotizacionId, negocioId) {
  const pertenencia = await obtenerPertenenciaCotizacion(cotizacionId, negocioId);
  if (pertenencia !== 'propia') return null;
  const { rows } = await pool.query(`SELECT * FROM cotizaciones WHERE id = $1`, [cotizacionId]);
  if (!rows[0]) return null;
  const items = await _obtenerItemsCotizacion(pool, cotizacionId);
  return { ...rows[0], items };
}

export async function listarCotizaciones(negocioId, { telefono = null } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const { rows } = await pool.query(
    `SELECT * FROM cotizaciones WHERE negocio_id = $1 AND ($2::varchar IS NULL OR telefono = $2)
     ORDER BY created_at DESC`,
    [negocioId.trim(), telefono]
  );
  return rows;
}

// Folio secuencial POR NEGOCIO (nunca global) -- reintenta ante una
// colisión de UNIQUE(negocio_id, folio) en vez de asumir concurrencia cero;
// las cotizaciones son un evento de baja frecuencia (creadas manualmente por
// un administrador), así que 3 reintentos con un COUNT fresco es suficiente
// sin necesitar una secuencia dedicada por negocio.
export async function crearCotizacion({ negocioId, telefono, createdBy, evento = {}, vigenciaHasta = null, anticipoRequerido = null, notas = null, terminos = null, items = [], impuestosPct = 0, origen = 'panel' }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('crearCotizacion: negocioId requerido');
  if (!Array.isArray(items) || items.length === 0) throw new Error('crearCotizacion: al menos un item requerido');
  const totales = _calcularTotales(items, { impuestosPct });
  if (!Number.isFinite(totales.total)) throw new Error('crearCotizacion: totales inválidos (revisar cantidad/precioUnitario de los items)');

  for (let intento = 0; intento < 3; intento++) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // MAX del sufijo numérico (no COUNT): un COUNT colisiona en cuanto una
      // cotización se borra o el conteo no refleja el folio más alto usado
      // alguna vez -- MAX sobre el número real ya asignado es monótono
      // incluso con huecos.
      const { rows: maximo } = await client.query(
        `SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM 5) AS INTEGER)), 0)::int AS n
         FROM cotizaciones WHERE negocio_id = $1 AND folio ~ '^COT-[0-9]+$'`,
        [negocioId.trim()]
      );
      const folio = `COT-${String(maximo[0].n + 1).padStart(4, '0')}`;
      const { rows } = await client.query(`
        INSERT INTO cotizaciones (
          negocio_id, telefono, folio, evento_nombre, fecha_evento, lugar, cantidad_personas,
          vigencia_hasta, subtotal, impuestos, descuentos, total, anticipo_requerido, notas, terminos, created_by, origen
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
        RETURNING *
      `, [
        negocioId.trim(), telefono, folio, evento.nombre || null, evento.fecha || null, evento.lugar || null,
        evento.cantidadPersonas || null, vigenciaHasta, totales.subtotal, totales.impuestos, totales.descuentos,
        totales.total, anticipoRequerido, notas, terminos, createdBy, origen,
      ]);
      const cotizacion = rows[0];
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        await client.query(`
          INSERT INTO cotizacion_items (cotizacion_id, tipo, descripcion, cantidad, precio_unitario, descuento, orden)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [cotizacion.id, it.tipo, it.descripcion, it.cantidad, it.precioUnitario, it.descuento || 0, i]);
      }
      await client.query('COMMIT');
      return { ...cotizacion, items: await _obtenerItemsCotizacion(pool, cotizacion.id) };
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505' && intento < 2) continue; // folio duplicado -- reintentar con conteo fresco
      throw e;
    } finally {
      client.release();
    }
  }
}

// Edición = nueva versión: el estado ANTERIOR completo (cotización + items)
// se guarda en cotizaciones_historial antes de mutar la fila viva -- nunca se
// sobrescribe sin conservar el snapshot previo.
export async function actualizarCotizacion(cotizacionId, negocioId, cambios = {}, items = null, impuestosPct = 0) {
  const actual = await obtenerCotizacion(cotizacionId, negocioId);
  if (!actual) return null;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO cotizaciones_historial (cotizacion_id, version, snapshot_json, pdf_storage_key)
       VALUES ($1,$2,$3,$4)`,
      [cotizacionId, actual.version, JSON.stringify(actual), actual.pdf_storage_key]
    );
    const itemsFinal = items || actual.items;
    const totales = _calcularTotales(itemsFinal, { impuestosPct });
    if (items) {
      await client.query(`DELETE FROM cotizacion_items WHERE cotizacion_id = $1`, [cotizacionId]);
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        await client.query(`
          INSERT INTO cotizacion_items (cotizacion_id, tipo, descripcion, cantidad, precio_unitario, descuento, orden)
          VALUES ($1,$2,$3,$4,$5,$6,$7)
        `, [cotizacionId, it.tipo, it.descripcion, it.cantidad, it.precioUnitario, it.descuento || 0, i]);
      }
    }
    const { rows } = await client.query(`
      UPDATE cotizaciones SET
        version = version + 1, estado = 'modificada', pdf_storage_key = NULL,
        evento_nombre = COALESCE($2, evento_nombre), fecha_evento = COALESCE($3, fecha_evento),
        lugar = COALESCE($4, lugar), cantidad_personas = COALESCE($5, cantidad_personas),
        vigencia_hasta = COALESCE($6, vigencia_hasta), anticipo_requerido = COALESCE($7, anticipo_requerido),
        notas = COALESCE($8, notas), terminos = COALESCE($9, terminos),
        subtotal = $10, impuestos = $11, descuentos = $12, total = $13
      WHERE id = $1
      RETURNING *
    `, [
      cotizacionId, cambios.evento?.nombre, cambios.evento?.fecha, cambios.evento?.lugar, cambios.evento?.cantidadPersonas,
      cambios.vigenciaHasta, cambios.anticipoRequerido, cambios.notas, cambios.terminos,
      totales.subtotal, totales.impuestos, totales.descuentos, totales.total,
    ]);
    await client.query('COMMIT');
    return { ...rows[0], items: await _obtenerItemsCotizacion(pool, cotizacionId) };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function guardarPdfCotizacion(cotizacionId, storageKey) {
  await pool.query(`UPDATE cotizaciones SET pdf_storage_key = $2 WHERE id = $1`, [cotizacionId, storageKey]);
}

export async function marcarCotizacionEnviada(cotizacionId) {
  const { rows } = await pool.query(
    `UPDATE cotizaciones SET estado = 'enviada', sent_at = NOW() WHERE id = $1 RETURNING *`,
    [cotizacionId]
  );
  return rows[0] || null;
}

export async function obtenerConversacionesRecientes(negocioId, limite = 20) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerConversacionesRecientes: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  try {
    const incluirNull = await _esNonnaMaye(negocioId);
    const result = await pool.query(`
      SELECT
        t.telefono,
        (SELECT nombre FROM mensajes WHERE telefono = t.telefono AND nombre IS NOT NULL
           AND (negocio_id = $1 OR ($2::boolean AND negocio_id IS NULL))
           ORDER BY timestamp DESC LIMIT 1) AS nombre,
        t.texto,
        t.direccion,
        t.timestamp
      FROM (
        SELECT DISTINCT ON (telefono) telefono, texto, direccion, timestamp
        FROM mensajes
        WHERE negocio_id = $1 OR ($2::boolean AND negocio_id IS NULL)
        ORDER BY telefono, timestamp DESC
      ) t
      ORDER BY t.timestamp DESC
      LIMIT $3
    `, [negocioId, incluirNull, limite]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerConversacionesRecientes:', e.message);
    return [];
  }
}

// ─── Pedidos activos del panel (sobreviven reinicios) ────────────────────────
// negocioId (Fase 5): folio es la PK real de esta tabla y un mismo folio
// pertenece al mismo negocio durante toda su vida (se fija una sola vez,
// en el primer INSERT) — por eso el UPDATE del ON CONFLICT (reutilizado en
// cada cambio de estado) no reescribe negocio_id; sería redundante, no
// arriesgado, pero se omite para mantener el UPDATE mínimo y explícito.
export async function guardarPedidoActivo(pedido, negocioId) {
  try {
    await pool.query(`
      INSERT INTO pedidos_activos (folio, estado, datos, negocio_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (folio) DO UPDATE SET datos = $3, updated_at = NOW()
    `, [pedido.id, pedido.estado || 'nuevo', JSON.stringify(pedido), negocioId || null]);
  } catch (e) {
    console.error('[DB] Error guardarPedidoActivo:', e.message);
  }
}

export async function actualizarEstadoPedidoDB(folio, estado) {
  try {
    await pool.query(`
      UPDATE pedidos_activos SET estado = $1, updated_at = NOW()
      WHERE folio = $2
    `, [estado, folio]);
  } catch (e) {
    console.error('[DB] Error actualizarEstadoPedidoDB:', e.message);
  }
}

export async function obtenerPedidosActivos() {
  try {
    const result = await pool.query(`
      SELECT datos, negocio_id FROM pedidos_activos
      WHERE estado != 'entregado'
      ORDER BY created_at ASC
    `);
    // Fallback para pedidos activos pre-migración: su JSON nunca tuvo
    // negocioId (se guardó antes de que ese concepto existiera), pero la
    // columna SQL sí quedó backfilleada por la migración 007. Sin este
    // fallback, orderManager.js los filtra como si no pertenecieran a
    // ningún negocio y desaparecen del panel. Nunca se sobrescribe un
    // negocioId ya presente en el JSON, nunca se inventa un negocio por
    // defecto, y el JSON guardado en DB nunca se modifica (solo se ajusta
    // el objeto devuelto en memoria).
    return result.rows.map(r => {
      const datos = r.datos || {};
      return { ...datos, negocioId: datos.negocioId || r.negocio_id || null };
    });
  } catch (e) {
    console.error('[DB] Error obtenerPedidosActivos:', e.message);
    return [];
  }
}

// Devuelve el número más alto de folio guardado (ej. 3 si el último es XAB-0003)
// Sirve para que el contador nunca repita un folio tras un reinicio
export async function obtenerMaxFolioNum() {
  try {
    const result = await pool.query(`
      SELECT COALESCE(MAX(CAST(REPLACE(folio, 'XAB-', '') AS INTEGER)), 0) AS max_num
      FROM pedidos_activos
    `);
    return result.rows[0]?.max_num || 0;
  } catch (e) {
    console.error('[DB] Error obtenerMaxFolioNum:', e.message);
    return 0;
  }
}

// Guarda el Clip payment_request_id en el pedido para reconciliación.
// negocioId OBLIGATORIO — falla cerrado (Incidente P0): el llamador
// siempre conoce el negocio en este punto (viene de la misma conversación
// que generó el link), así que no hay razón para permitir escribir en el
// folio de otro negocio (folios son secuenciales y adivinables).
export async function guardarLinkPago(folio, negocioId, clipLinkId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] guardarLinkPago: negocioId inválido u omitido — rechazado, no se escribe sin negocio');
    return false;
  }
  try {
    const { rowCount } = await pool.query(`
      UPDATE pedidos_activos
      SET datos = datos || $3::jsonb, updated_at = NOW()
      WHERE folio = $1 AND negocio_id = $2
    `, [folio, negocioId.trim(), JSON.stringify({ clip_link_id: clipLinkId })]);
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Error guardarLinkPago:', e.message);
    return false;
  }
}

// Devuelve pedidos con pago pendiente que tienen un clip_link_id guardado.
// Incluye negocio_id (Incidente P0): la reconciliación en background
// necesita saber a qué negocio pertenece cada folio para consultar Clip
// con LAS credenciales de ESE negocio, nunca una cuenta global.
export async function obtenerPagosPendientesConLink() {
  try {
    const result = await pool.query(`
      SELECT folio, negocio_id, datos->>'clip_link_id' AS clip_link_id
      FROM pedidos_activos
      WHERE datos->>'forma_pago' = 'enlace de pago'
        AND (datos->>'pago_confirmado')::boolean IS NOT TRUE
        AND datos->>'clip_link_id' IS NOT NULL
        AND estado != 'entregado'
    `);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerPagosPendientesConLink:', e.message);
    return [];
  }
}

// ─── Tabla `pagos` (Fase 9/10/11 -- arquitectura de pagos multiempresa) ──────
// Reemplaza, para pagos NUEVOS, el JSONB suelto de pedidos_activos.datos
// (forma_pago/clip_link_id/pago_confirmado) por una fuente de verdad real
// con idempotencia y versión del pedido. Los campos legacy en
// pedidos_activos.datos NO se tocan -- pedidos ya en curso al desplegar
// esto siguen funcionando exactamente igual.
export function calcularVersionPedidoHash(pedido) {
  // Hash de (total, modalidad) -- pedidos_activos no tiene una columna de
  // versión real y no se le agrega una (tabla protegida, ver CLAUDE.md).
  // El ejemplo del encargo (domicilio $560 vs recoger $500) ya queda
  // cubierto: cambiar modalidad implica un total distinto en la práctica.
  const base = `${Number(pedido?.total || 0).toFixed(2)}|${pedido?.modalidad || ''}`;
  return createHash('sha256').update(base).digest('hex').slice(0, 16);
}

/** Pago "vigente" (creando/pendiente) para un pedido+tipo, o null. Nunca cruza negocio. */
// 'requiere_revision' cuenta como vigente (transferencia manual sin
// conciliar todavía) -- sin esto, una transferencia pedida dos veces
// generaría una fila nueva cada vez en vez de reutilizar/informar la
// misma instrucción pendiente de revisión.
export async function obtenerPagoVigente(negocioId, pedidoFolio, tipo = 'enlace_pago') {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2 AND tipo = $3 AND estado IN ('creando','pendiente','requiere_revision')`,
    [negocioId.trim(), pedidoFolio, tipo]
  );
  return rows[0] || null;
}

export async function crearRegistroPago({ negocioId, pedidoFolio, clienteTelefono, proveedor, integracionId, referenciaInterna, tipo = 'enlace_pago', moneda = 'MXN', monto, versionPedidoHash, idempotencyKey, createdBy }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('crearRegistroPago: negocioId requerido');
  const { rows } = await pool.query(`
    INSERT INTO pagos (negocio_id, pedido_folio, cliente_telefono, proveedor, integracion_id, referencia_interna, tipo, moneda, monto, version_pedido_hash, idempotency_key, created_by, estado)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'creando')
    RETURNING *
  `, [negocioId.trim(), pedidoFolio, clienteTelefono, proveedor, integracionId, referenciaInterna, tipo, moneda, monto, versionPedidoHash, idempotencyKey || null, createdBy || null]);
  return rows[0];
}

export async function actualizarPagoCreado(pagoId, { referenciaExterna, url, estado }) {
  const { rows } = await pool.query(
    `UPDATE pagos SET referencia_externa = $2, url = $3, estado = $4 WHERE id = $1 RETURNING *`,
    [pagoId, referenciaExterna || null, url || null, estado]
  );
  return rows[0] || null;
}

export async function marcarPagoFallido(pagoId, motivo) {
  await pool.query(`UPDATE pagos SET estado = 'fallido', metadata_sanitizada = metadata_sanitizada || $2::jsonb WHERE id = $1`,
    [pagoId, JSON.stringify({ motivo_fallo: motivo })]);
}

/** Invalida todo pago vigente de un pedido (Fase 11): el pedido cambió, el enlace ya no es válido. Nunca se reutiliza. */
export async function invalidarPagosVigentesDePedido(negocioId, pedidoFolio, motivo) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return 0;
  const { rowCount } = await pool.query(
    `UPDATE pagos SET estado = 'invalidado', invalidated_at = NOW(), motivo_invalidacion = $3
     WHERE negocio_id = $1 AND pedido_folio = $2 AND estado IN ('creando','pendiente','requiere_revision')`,
    [negocioId.trim(), pedidoFolio, motivo || 'pedido modificado']
  );
  return rowCount;
}

/** Lee un pago por negocio+referencia interna -- para el webhook: NUNCA busca solo por referencia global. */
export async function obtenerPagoPorReferenciaInterna(negocioId, referenciaInterna) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id = $1 AND referencia_interna = $2`,
    [negocioId.trim(), referenciaInterna]
  );
  return rows[0] || null;
}

/** Confirma un pago de forma idempotente (segunda notificación del mismo evento no duplica ni retrocede el estado). */
export async function confirmarPagoIdempotente(pagoId, { referenciaExterna } = {}) {
  const { rows } = await pool.query(
    `UPDATE pagos SET estado = 'pagado', paid_at = COALESCE(paid_at, NOW()), referencia_externa = COALESCE($2, referencia_externa)
     WHERE id = $1 AND estado NOT IN ('pagado','cancelado','invalidado','reembolsado')
     RETURNING *`,
    [pagoId, referenciaExterna || null]
  );
  return rows[0] || null;
}

/**
 * Conciliación manual de transferencia (Fase 12/13): a diferencia de
 * confirmarPagoIdempotente (uso interno del webhook de Clip, sin
 * negocio_id en el WHERE porque el negocio ya se resolvió antes de
 * llamarla), esta función SÍ exige negocio_id -- se expone directo a un
 * endpoint HTTP de admin, así que sin ese filtro un admin de un negocio
 * podría confirmar (o cancelar) el pago de otro con solo adivinar un
 * pagoId. Restringida a tipo='transferencia' y estado='requiere_revision'
 * -- nunca se usa para "saltarse" la verificación real de un enlace Clip.
 */
export async function confirmarPagoManual(negocioId, pagoId, actualizadoPor) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows } = await pool.query(
    `UPDATE pagos SET estado = 'pagado', paid_at = COALESCE(paid_at, NOW())
     WHERE id = $1 AND negocio_id = $2 AND tipo = 'transferencia' AND estado = 'requiere_revision'
     RETURNING *`,
    [pagoId, negocioId.trim()]
  );
  if (rows[0]) {
    await registrarAuditoriaPlataforma({
      superadminId: actualizadoPor, negocioId: negocioId.trim(),
      accion: 'pago_transferencia_confirmado_manual', estadoNuevo: { pagoId, estado: 'pagado' }, contexto: {},
    });
  }
  return rows[0] || null;
}

export async function rechazarPagoManual(negocioId, pagoId, motivo, actualizadoPor) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows } = await pool.query(
    `UPDATE pagos SET estado = 'cancelado', cancelled_at = NOW(), motivo_invalidacion = $3
     WHERE id = $1 AND negocio_id = $2 AND tipo = 'transferencia' AND estado = 'requiere_revision'
     RETURNING *`,
    [pagoId, negocioId.trim(), motivo || 'no se recibió la transferencia']
  );
  if (rows[0]) {
    await registrarAuditoriaPlataforma({
      superadminId: actualizadoPor, negocioId: negocioId.trim(),
      accion: 'pago_transferencia_rechazado_manual', estadoNuevo: { pagoId, estado: 'cancelado' }, contexto: { motivo },
    });
  }
  return rows[0] || null;
}

export async function listarPagosPorPedido(negocioId, pedidoFolio) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const { rows } = await pool.query(
    `SELECT * FROM pagos WHERE negocio_id = $1 AND pedido_folio = $2 ORDER BY created_at DESC`,
    [negocioId.trim(), pedidoFolio]
  );
  return rows;
}

// ─── Métodos de pago por negocio (Fase 6) ────────────────────────────────────
const TIPOS_METODO_VALIDOS = ['efectivo', 'terminal', 'enlace_pago', 'transferencia', 'pago_en_sucursal', 'otro_autorizado'];

export async function listarMetodosPagoNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const { rows } = await pool.query(
    `SELECT * FROM metodos_pago WHERE negocio_id = $1 ORDER BY orden, tipo`,
    [negocioId.trim()]
  );
  return rows;
}

/**
 * Habilita (nunca deshabilita) el método de pago que un proveedor recién
 * marcado como principal hace posible -- sin esto, marcar Clip (o
 * manual_transfer) como principal en Superadmin no bastaría para que el
 * agente pueda ofrecerlo: metodos_pago.habilitado seguiría en FALSE hasta
 * un segundo paso manual en el panel del negocio (el mismo tipo de brecha
 * que causó el incidente original). Solo toca habilitado/integracion_id
 * -- nunca pisa instrucciones/orden ya configuradas por el admin del
 * negocio, y nunca deshabilita OTRO método (varios pueden convivir
 * habilitados a la vez).
 */
export async function habilitarMetodoPagoPorProveedorPrincipal(negocioId, tipo, integracionId) {
  if (typeof negocioId !== 'string' || !negocioId.trim() || !TIPOS_METODO_VALIDOS.includes(tipo)) return null;
  const { rows } = await pool.query(`
    INSERT INTO metodos_pago (negocio_id, tipo, habilitado, integracion_id)
    VALUES ($1, $2, TRUE, $3)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET habilitado = TRUE, integracion_id = $3, updated_at = NOW()
    RETURNING *
  `, [negocioId.trim(), tipo, integracionId || null]);
  return rows[0] || null;
}

export async function guardarMetodoPagoNegocio(negocioId, tipo, cambios = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('guardarMetodoPagoNegocio: negocioId requerido');
  if (!TIPOS_METODO_VALIDOS.includes(tipo)) throw new Error(`guardarMetodoPagoNegocio: tipo "${tipo}" inválido`);
  const { habilitado = false, integracionId = null, instrucciones = {}, orden = 0, disponibleParaBot = true, disponibleParaOperador = true } = cambios;
  const { rows } = await pool.query(`
    INSERT INTO metodos_pago (negocio_id, tipo, habilitado, integracion_id, instrucciones, orden, disponible_para_bot, disponible_para_operador)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (negocio_id, tipo) DO UPDATE SET
      habilitado = $3, integracion_id = $4, instrucciones = $5, orden = $6,
      disponible_para_bot = $7, disponible_para_operador = $8, updated_at = NOW()
    RETURNING *
  `, [negocioId.trim(), tipo, habilitado, integracionId, JSON.stringify(instrucciones), orden, disponibleParaBot, disponibleParaOperador]);
  return rows[0];
}

/**
 * Métodos REALMENTE disponibles para un negocio (Fase 6/7) -- fuente de
 * verdad que reemplaza la lista libre reglas_atencion.pago_aceptado para
 * decidir qué puede ofrecer el agente. enlace_pago solo se incluye si
 * además hay un proveedor principal activo (nunca solo por estar
 * "habilitado" en la config editable).
 */
export async function obtenerMetodosPagoDisponibles(negocioId, { paraBot = false } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const { rows } = await pool.query(`
    SELECT mp.tipo, mp.instrucciones, mp.disponible_para_bot, mp.disponible_para_operador,
           ic.estado AS proveedor_estado, ic.proveedor
    FROM metodos_pago mp
    LEFT JOIN integraciones_canal ic ON ic.id = mp.integracion_id AND ic.principal = TRUE
    WHERE mp.negocio_id = $1 AND mp.habilitado = TRUE
    ORDER BY mp.orden
  `, [negocioId.trim()]);
  return rows
    .filter(r => {
      if (paraBot && !r.disponible_para_bot) return false;
      if (r.tipo === 'enlace_pago') return r.proveedor_estado === 'activo';
      return true;
    })
    .map(r => ({ tipo: r.tipo, instrucciones: r.tipo === 'transferencia' ? r.instrucciones : undefined }));
}

// negocioId OBLIGATORIO — falla cerrado (Incidente P0, defensa en
// profundidad): folios son secuenciales/adivinables, así que confirmar un
// pago sin verificar dueño permitiría marcar como pagado el pedido de
// OTRO negocio.
export async function confirmarPagoPedido(folio, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] confirmarPagoPedido: negocioId inválido u omitido — rechazado, no se escribe sin negocio');
    return false;
  }
  try {
    const { rowCount } = await pool.query(`
      UPDATE pedidos_activos
      SET datos = datos || '{"pago_confirmado": true}', updated_at = NOW()
      WHERE folio = $1 AND negocio_id = $2
    `, [folio, negocioId.trim()]);
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Error confirmarPagoPedido:', e.message);
    return false;
  }
}

// negocioId OBLIGATORIO — falla cerrado (Auditoría P0). Un folio de otro
// negocio se comporta idéntico a un folio inexistente (null).
export async function obtenerPedidoActivoPorFolio(folio, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerPedidoActivoPorFolio: negocioId inválido u omitido — rechazado, sin consulta global');
    return null;
  }
  try {
    const result = await pool.query(
      `SELECT datos FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2 AND estado != 'entregado'`,
      [folio, negocioId.trim()]
    );
    return result.rows[0]?.datos || null;
  } catch (e) {
    console.error('[DB] Error obtenerPedidoActivoPorFolio:', e.message);
    return null;
  }
}

// Busca en activos Y en programados — útil para enlace de pago anticipado.
// negocioId OBLIGATORIO — falla cerrado (Auditoría P0, Categoría C: un
// cliente de WhatsApp de un negocio nunca debe poder consultar el folio de
// otro escribiéndolo a mano). Un folio de otro negocio se comporta
// idéntico a un folio inexistente (null) en ambas tablas.
export async function obtenerPedidoPorFolioAmplio(folio, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerPedidoPorFolioAmplio: negocioId inválido u omitido — rechazado, sin consulta global');
    return null;
  }
  const negocioIdNorm = negocioId.trim();
  try {
    // Primero en activos
    const activo = await pool.query(
      `SELECT datos, 'activo' AS origen FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2 AND estado != 'entregado'`,
      [folio, negocioIdNorm]
    );
    if (activo.rows[0]) return { ...activo.rows[0].datos, _origen: 'activo' };

    // Si no, en programados
    const prog = await pool.query(
      `SELECT datos, programado_para FROM pedidos_programados WHERE folio = $1 AND negocio_id = $2 AND activado = FALSE`,
      [folio, negocioIdNorm]
    );
    if (prog.rows[0]) return { ...prog.rows[0].datos, _origen: 'programado', programado_para: prog.rows[0].programado_para };

    return null;
  } catch (e) {
    console.error('[DB] Error obtenerPedidoPorFolioAmplio:', e.message);
    return null;
  }
}

// negocioId OBLIGATORIO — falla cerrado (Incidente P0). Antes buscaba solo
// por teléfono: la consulta de "en qué va mi pedido" de un cliente de
// Alora podía devolver el pedido activo de OTRO negocio si ese mismo
// teléfono real también tenía un pedido abierto ahí. Un pedido de otro
// negocio se comporta idéntico a "no tiene pedidos activos".
export async function obtenerPedidosActivosPorTelefono(telefono, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerPedidosActivosPorTelefono: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  try {
    const result = await pool.query(
      `SELECT folio, estado, datos, created_at
       FROM pedidos_activos
       WHERE datos->'cliente'->>'telefono' = $1
         AND negocio_id = $2
         AND estado NOT IN ('entregado', 'cancelado')
       ORDER BY created_at DESC
       LIMIT 3`,
      [telefono, negocioId.trim()]
    );
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerPedidosActivosPorTelefono:', e.message);
    return [];
  }
}

export async function archivarPedidoActivo(folio) {
  try {
    await pool.query(`
      UPDATE pedidos_activos SET estado = 'entregado', updated_at = NOW()
      WHERE folio = $1
    `, [folio]);
  } catch (e) {
    console.error('[DB] Error archivarPedidoActivo:', e.message);
  }
}

export async function eliminarPedido(folio) {
  try {
    await pool.query(`DELETE FROM pedidos_activos WHERE folio = $1`, [folio]);
    await pool.query(`DELETE FROM pedidos WHERE folio = $1`, [folio]);
  } catch (e) {
    console.error('[DB] Error eliminarPedido:', e.message);
    throw e;
  }
}

// ─── Pedidos programados ──────────────────────────────────────────────────────
export async function guardarPedidoProgramado(folio, datos, programadoPara) {
  try {
    await pool.query(`
      INSERT INTO pedidos_programados (folio, datos, programado_para)
      VALUES ($1, $2, $3)
      ON CONFLICT (folio) DO NOTHING
    `, [folio, JSON.stringify(datos), programadoPara]);
  } catch (e) {
    console.error('[DB] Error guardarPedidoProgramado:', e.message);
  }
}

// Devuelve pedidos cuya hora de activación ya llegó (programado_para <= ahora + 1h) y no han sido activados
export async function obtenerPedidosPorActivar() {
  try {
    const result = await pool.query(`
      SELECT folio, datos, negocio_id, programado_para FROM pedidos_programados
      WHERE activado = FALSE
        AND programado_para <= NOW() + INTERVAL '1 hour'
      ORDER BY programado_para ASC
    `);
    // Mismo fallback y mismo motivo que obtenerPedidosActivos(): un
    // pedido programado creado antes de la migración 007 no tiene
    // negocioId en su JSON, aunque la columna sí lo tenga. Sin esto,
    // activarPedidosProgramados() (server.js) lo rechaza para siempre por
    // su propia guarda fail-closed. row.negocio_id nunca se expone aparte
    // -- se pliega dentro de datos.negocioId, que es lo único que lee el
    // consumidor.
    return result.rows.map(r => {
      const datos = r.datos || {};
      return {
        folio: r.folio,
        programado_para: r.programado_para,
        datos: { ...datos, negocioId: datos.negocioId || r.negocio_id || null }
      };
    });
  } catch (e) {
    console.error('[DB] Error obtenerPedidosPorActivar:', e.message);
    return [];
  }
}

export async function marcarPedidoProgramadoActivado(folio) {
  try {
    await pool.query(`UPDATE pedidos_programados SET activado = TRUE WHERE folio = $1`, [folio]);
  } catch (e) {
    console.error('[DB] Error marcarPedidoProgramadoActivado:', e.message);
  }
}

// negocioId OBLIGATORIO — falla cerrado (Auditoría P0, Categoría A).
export async function obtenerPedidosProgramadosPendientes(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerPedidosProgramadosPendientes: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  try {
    const result = await pool.query(`
      SELECT folio, datos, programado_para FROM pedidos_programados
      WHERE activado = FALSE AND negocio_id = $1
      ORDER BY programado_para ASC
    `, [negocioId.trim()]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerPedidosProgramadosPendientes:', e.message);
    return [];
  }
}

// Último pedido entregado de un teléfono — para generarle factura.
// negocioId OBLIGATORIO — falla cerrado (Incidente P0): sin esto, un
// cliente de Alora podía terminar facturando el pedido entregado de OTRO
// negocio si compartía teléfono real con un cliente de ahí.
export async function obtenerUltimoPedidoEntregadoPorTelefono(telefono, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerUltimoPedidoEntregadoPorTelefono: negocioId inválido u omitido — rechazado, sin consulta global');
    return null;
  }
  try {
    const result = await pool.query(
      `SELECT folio, datos FROM pedidos_activos
       WHERE datos->'cliente'->>'telefono' = $1
         AND negocio_id = $2
         AND estado = 'entregado'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [telefono, negocioId.trim()]
    );
    if (!result.rows[0]) return null;
    return { folio: result.rows[0].folio, ...result.rows[0].datos };
  } catch (e) {
    console.error('[DB] Error obtenerUltimoPedidoEntregadoPorTelefono:', e.message);
    return null;
  }
}

// ─── Transcripciones de voz ───────────────────────────────────────────────────
// negocioId OBLIGATORIO en escritura y lectura — falla cerrado (Incidente P0).
// 0 filas con negocio_id NULL en el diagnóstico de producción, así que no
// hace falta ninguna cláusula de compatibilidad aquí (a diferencia de
// mensajes/clientes).
export async function guardarTranscripcionVoz(callSid, fromNum, rol, texto, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] guardarTranscripcionVoz: negocioId inválido u omitido — rechazado, no se escribe sin negocio');
    return;
  }
  try {
    await pool.query(`
      INSERT INTO transcripciones_voz (call_sid, from_num, rol, texto, negocio_id)
      VALUES ($1, $2, $3, $4, $5)
    `, [callSid, fromNum || null, rol, texto, negocioId.trim()]);
  } catch (e) {
    console.error('[DB] Error guardarTranscripcionVoz:', e.message);
  }
}

export async function obtenerTranscripcionPorLlamada(callSid, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerTranscripcionPorLlamada: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  try {
    const result = await pool.query(`
      SELECT rol, texto, created_at FROM transcripciones_voz
      WHERE call_sid = $1 AND negocio_id = $2
      ORDER BY created_at ASC
    `, [callSid, negocioId]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerTranscripcionPorLlamada:', e.message);
    return [];
  }
}

export async function obtenerLlamadasRecientes(negocioId, limite = 20) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerLlamadasRecientes: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (call_sid)
        call_sid, from_num,
        MIN(created_at) OVER (PARTITION BY call_sid) AS inicio,
        MAX(created_at) OVER (PARTITION BY call_sid) AS fin,
        COUNT(*) OVER (PARTITION BY call_sid) AS num_mensajes
      FROM transcripciones_voz
      WHERE negocio_id = $1
      ORDER BY call_sid, created_at DESC
      LIMIT $2
    `, [negocioId, limite]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerLlamadasRecientes:', e.message);
    return [];
  }
}

// ─── Prompt improvements ─────────────────────────────────────────────────────
export async function guardarSugerencias(semana, sugerencias) {
  try {
    const result = await pool.query(`
      INSERT INTO prompt_improvements (semana, sugerencias)
      VALUES ($1, $2) RETURNING id
    `, [semana, JSON.stringify(sugerencias)]);
    return result.rows[0].id;
  } catch (e) {
    console.error('[DB] Error guardarSugerencias:', e.message);
    return null;
  }
}

export async function obtenerSugerenciasPendientes() {
  try {
    const result = await pool.query(`
      SELECT * FROM prompt_improvements
      WHERE estado = 'pendiente'
      ORDER BY created_at DESC LIMIT 1
    `);
    return result.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerSugerenciasPendientes:', e.message);
    return null;
  }
}

export async function aprobarSugerencias(id, indices) {
  try {
    await pool.query(`
      UPDATE prompt_improvements
      SET estado = 'aprobado', aprobadas = $2, applied_at = NOW()
      WHERE id = $1
    `, [id, JSON.stringify(indices)]);
  } catch (e) {
    console.error('[DB] Error aprobarSugerencias:', e.message);
  }
}

// Fase A (aislamiento de WhatsApp): negocioId obligatorio -- desde la
// migración 016, prompt_overrides.negocio_id es NOT NULL. Sin un
// negocioId válido, nunca se guarda un override "huérfano" que
// terminaría filtrándose al prompt de cualquier negocio.
export async function guardarOverride(seccion, contenido, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.error('[DB] guardarOverride: negocioId inválido u omitido — rechazado, no se guarda sin negocio');
    return;
  }
  try {
    // Desactivar overrides anteriores de la misma sección, SOLO de este negocio
    await pool.query(`UPDATE prompt_overrides SET activo = FALSE WHERE seccion = $1 AND negocio_id = $2`, [seccion, negocioId.trim()]);
    await pool.query(`
      INSERT INTO prompt_overrides (seccion, contenido, negocio_id) VALUES ($1, $2, $3)
    `, [seccion, contenido, negocioId.trim()]);
  } catch (e) {
    console.error('[DB] Error guardarOverride:', e.message);
  }
}

// Fase A: negocioId obligatorio -- sin él, nunca se devuelven overrides
// de ningún negocio (fail-closed, nunca cae a "todos" ni a Nonna Maye).
export async function obtenerOverridesActivos(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  try {
    const result = await pool.query(`
      SELECT seccion, contenido FROM prompt_overrides WHERE activo = TRUE AND negocio_id = $1
    `, [negocioId.trim()]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerOverridesActivos:', e.message);
    return [];
  }
}

export async function obtenerMensajesRango(desde, hasta) {
  try {
    const result = await pool.query(`
      SELECT telefono, nombre, direccion, texto, timestamp
      FROM mensajes
      WHERE timestamp BETWEEN $1 AND $2
      ORDER BY telefono, timestamp ASC
    `, [desde, hasta]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerMensajesRango:', e.message);
    return [];
  }
}

// ─── Obtener últimos pedidos de un cliente ────────────────────────────────────
// Fase A (aislamiento de WhatsApp): negocioId obligatorio -- esta consulta
// alimenta directamente el contexto que se inyecta al bot (clienteCtx.pedidos
// en prompts.js). Sin filtrar por negocio_id (columna ya agregada por la
// migración 007, pero nunca antes usada en esta consulta), el bot de
// cualquier negocio veía el historial de pedidos del mismo teléfono en
// TODOS los negocios.
export async function obtenerUltimosPedidos(telefono, negocioId, limite = 3) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  try {
    const result = await pool.query(`
      SELECT items, total, modalidad, created_at
      FROM pedidos
      WHERE telefono = $1 AND negocio_id = $2
      ORDER BY created_at DESC
      LIMIT $3
    `, [telefono, negocioId.trim(), limite]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerUltimosPedidos:', e.message);
    return [];
  }
}

// ─── Fondo de caja ────────────────────────────────────────────────────────────
// Guarda el fondo inicial del día (una sola vez por fecha MX)
// ─── Multiempresa — resolución del negocio actual ────────────────────────────
// Temporal: sin autenticación multiempresa todavía, todo el sistema opera sobre
// un único "negocio actual" resuelto por slug (ver migrations/003_multiempresa*
// y 004_config_menu_negocio*). Nunca hardcodear el UUID: siempre se resuelve
// consultando negocios.slug.
const NEGOCIO_ACTUAL_SLUG = 'nonna-maye';
let _negocioActualIdCache = null;

export async function obtenerNegocioIdPorSlug(slug) {
  try {
    const { rows } = await pool.query('SELECT id FROM negocios WHERE slug = $1', [slug]);
    return rows[0]?.id || null;
  } catch (e) {
    console.error('[DB] Error obtenerNegocioIdPorSlug:', e.message);
    return null;
  }
}

// Chequeo de solo lectura para el envío de push (Auditoría P0
// complementaria): la sesión ya se rechaza al suscribirse si el negocio
// está inactivo (obtenerMembresiaUsuarioNegocio lo exige), pero un negocio
// puede suspenderse DESPUÉS de que ya existan filas de suscripción
// guardadas -- este chequeo se hace también al momento de ENVIAR, no solo
// al suscribirse.
export async function negocioEstaActivo(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return false;
  try {
    const { rows } = await pool.query('SELECT activo FROM negocios WHERE id = $1', [negocioId.trim()]);
    return rows[0]?.activo === true;
  } catch (e) {
    console.error('[DB] Error negocioEstaActivo:', e.message);
    return false;
  }
}

async function resolverNegocioActualId() {
  if (!_negocioActualIdCache) {
    _negocioActualIdCache = await obtenerNegocioIdPorSlug(NEGOCIO_ACTUAL_SLUG);
  }
  return _negocioActualIdCache;
}

// ─── Multiempresa — mapeo canal → negocio (Fase 5, migración 008) ──────────
// Resuelve el negocio (y sucursal, si aplica) dueño de un identificador de
// integración externo (store_id de Rappi, phone_number_id de WhatsApp,
// número de Twilio en voz) contra integraciones_canal. Función de SOLO
// LECTURA: no crea ni modifica filas, no lee variables de entorno, no
// acepta negocioId directamente (el negocio se deriva exclusivamente del
// identificador del canal, nunca de un valor que el llamador pudiera
// manipular) y NO tiene fallback a Nonna Maye ni a ningún negocio por
// defecto — un identificador sin coincidencia siempre devuelve null.
// Ningún canal (WhatsApp/Rappi/voz) la usa todavía; se agrega sola, sin
// conectar nada, como preparación para una fase posterior.
//
// A diferencia de la mayoría de las funciones de este archivo, aquí NO se
// atrapa el error de la consulta: un fallo real de base de datos debe
// propagarse al llamador (mismo criterio que crearProducto/
// actualizarProducto/crearUsuarioConPassword) — "no encontrado" y "error
// real" son casos distintos y no deben confundirse devolviendo null en
// ambos.
export async function obtenerIntegracionCanal(canal, identificador) {
  if (typeof canal !== 'string' || !canal.trim()) return null;
  if (typeof identificador !== 'string' || !identificador.trim()) return null;

  // canal se normaliza agresivamente (trim + minúsculas): es un valor
  // interno controlado por nosotros, los canales conocidos ('whatsapp',
  // 'rappi', 'voice') siempre se siembran en minúsculas. identificador NO
  // cambia de mayúsculas/minúsculas — viene tal cual del proveedor externo
  // en cada webhook y se sembró en la migración 008 con su capitalización
  // original; forzar un case distinto podría dejar de coincidir con lo que
  // Rappi/Meta/Twilio realmente envían.
  const canalNorm = canal.trim().toLowerCase();
  const identificadorNorm = identificador.trim();

  const { rows } = await pool.query(
    `SELECT
       ic.id AS integracion_id,
       ic.negocio_id, n.slug AS negocio_slug, n.nombre AS negocio_nombre,
       ic.sucursal_id, s.nombre AS sucursal_nombre,
       ic.canal, ic.identificador, ic.configuracion
     FROM integraciones_canal ic
     JOIN negocios n ON n.id = ic.negocio_id
     LEFT JOIN sucursales s ON s.id = ic.sucursal_id
     WHERE ic.canal = $1 AND ic.identificador = $2 AND ic.activo = TRUE`,
    [canalNorm, identificadorNorm]
  );

  if (rows.length === 0) return null;

  if (rows.length > 1) {
    // UNIQUE(canal, identificador) debería impedir esto. Si ocurre de
    // todos modos, es un error estructural real -- no un "no encontrado"
    // -- y debe tratarse como tal, no devolverse silenciosamente como null.
    throw new Error(
      `obtenerIntegracionCanal: se encontraron ${rows.length} integraciones activas para canal='${canalNorm}' identificador='${identificadorNorm}' — se esperaba a lo sumo 1 (violación de UNIQUE)`
    );
  }

  const r = rows[0];
  return {
    integracionId: r.integracion_id,
    negocioId: r.negocio_id,
    negocioSlug: r.negocio_slug,
    negocioNombre: r.negocio_nombre,
    sucursalId: r.sucursal_id,
    sucursalNombre: r.sucursal_nombre,
    canal: r.canal,
    identificador: r.identificador,
    configuracion: r.configuracion,
  };
}

// ─── Multiempresa — membresía usuario↔negocio (Fase 2, autenticación) ───────
// Mecanismo real: la pertenencia de un usuario a uno o más negocios vive en
// la tabla usuario_negocios (migración 005). El middleware de autenticación
// en server.js usa obtenerMembresiaUsuarioNegocio para decidir si una
// request autenticada puede operar sobre el negocio que pide su sesión —
// nunca confía en un slug/ID que el cliente envíe directamente.
// Exige negocio.activo además de membresía.activo -- mismo criterio que ya
// usa obtenerNegociosDeUsuario() para el login. Sin esto, una sesión emitida
// antes de desactivar un negocio seguía siendo válida indefinidamente en
// cada request protegida (resolverNegocioSeguro/requireSesionNegocio/
// autenticarUpgradePanel), porque solo revalidaban usuario_negocios.activo.
// Un negocio inactivo con membresía.activo=true en la fila ahora devuelve
// null (misma forma de "sin membresía válida" que ya usan los llamadores),
// nunca un objeto con negocio_activo=false que el llamador tendría que
// interpretar aparte.
// Exige también usuarios.activo, por el mismo motivo que ya exige
// negocios.activo (ver comentario arriba): sin esto, un usuario
// desactivado con sesión ya emitida seguía con acceso indefinidamente en
// cada request protegida, porque nada revalidaba usuarios.activo fuera del
// momento de login. usuarios.activo=false ahora produce el mismo null
// (ausencia de membresía válida) que ya interpretan los 3 llamadores.
export async function obtenerMembresiaUsuarioNegocio(usuarioId, negocioId) {
  try {
    const { rows } = await pool.query(
      `SELECT un.rol, un.activo
       FROM usuario_negocios un
       JOIN negocios n ON n.id = un.negocio_id
       JOIN usuarios u ON u.id = un.usuario_id
       WHERE un.usuario_id = $1
         AND un.negocio_id = $2
         AND un.activo = true
         AND n.activo = true
         AND u.activo = true`,
      [usuarioId, negocioId]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerMembresiaUsuarioNegocio:', e.message);
    return null;
  }
}

// Lista los negocios a los que pertenece un usuario (para elegir negocio
// activo al iniciar sesión). Solo membresías activas.
export async function obtenerNegociosDeUsuario(usuarioId) {
  try {
    const { rows } = await pool.query(
      `SELECT un.negocio_id, un.rol, n.nombre, n.slug
       FROM usuario_negocios un
       JOIN negocios n ON n.id = un.negocio_id
       WHERE un.usuario_id = $1 AND un.activo = TRUE AND n.activo = TRUE
       ORDER BY n.nombre`,
      [usuarioId]
    );
    return rows;
  } catch (e) {
    console.error('[DB] Error obtenerNegociosDeUsuario:', e.message);
    return [];
  }
}

export async function obtenerUsuarioPorId(usuarioId) {
  try {
    const { rows } = await pool.query(
      `SELECT id, negocio_id, nombre, email, activo FROM usuarios WHERE id = $1`,
      [usuarioId]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerUsuarioPorId:', e.message);
    return null;
  }
}

// email es único globalmente desde la migración 006 — a lo sumo una fila.
// Incluye password_hash porque la usa el login para verificar la
// contraseña; el llamador nunca debe reenviarlo al cliente.
export async function obtenerUsuarioPorEmail(email) {
  try {
    const { rows } = await pool.query(
      `SELECT id, negocio_id, nombre, email, password_hash, activo FROM usuarios WHERE email = $1`,
      [email]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerUsuarioPorEmail:', e.message);
    return null;
  }
}

// Crea un usuario CON contraseña y su membresía inicial en un negocio, de
// forma atómica (transacción). Pensado para el script de administrador
// inicial (scripts/crear-admin-local.js) y para futuras altas de usuario.
// Nunca acepta un hash ya calculado — siempre recibe la contraseña en
// texto plano y la hashea aquí mismo, para que no exista otra forma de
// insertar un usuario sin pasar por hashPassword().
export async function crearUsuarioConPassword({ negocioId, nombre, email, password, rol = 'admin' }) {
  const client = await pool.connect();
  try {
    const hash = hashPassword(password);
    await client.query('BEGIN');
    const { rows: [usuario] } = await client.query(
      `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, negocio_id, nombre, email`,
      [negocioId, nombre, email, hash]
    );
    await client.query(
      `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,$3)
       ON CONFLICT (usuario_id, negocio_id) DO UPDATE SET rol = $3, activo = TRUE`,
      [usuario.id, negocioId, rol]
    );
    await client.query('COMMIT');
    return usuario;
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Error crearUsuarioConPassword:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ─── Módulo de Usuarios del panel (Fase 5) ──────────────────────────────────
// Lista los usuarios de UN negocio (siempre el de la sesión del llamador,
// nunca uno arbitrario) con su rol y estado de membresía. Nunca incluye
// password_hash ni ninguna otra columna sensible -- la consulta ni siquiera
// la selecciona.
export async function obtenerUsuariosDeNegocio(negocioId) {
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.nombre, u.email, un.rol, un.activo, u.created_at
       FROM usuarios u
       JOIN usuario_negocios un ON un.usuario_id = u.id
       WHERE un.negocio_id = $1
       ORDER BY u.created_at DESC`,
      [negocioId]
    );
    return rows;
  } catch (e) {
    console.error('[DB] Error obtenerUsuariosDeNegocio:', e.message);
    return [];
  }
}

// A diferencia de obtenerMembresiaUsuarioNegocio (que exige activo=true en
// las tres tablas, pensada para autorizar requests), esta variante devuelve
// la membresía exista o no esté activa -- la necesita POST /api/admin/usuarios
// para distinguir "ya tiene cuenta en este negocio, solo desactivada" de
// "el correo es de otro negocio o no tiene ninguna membresía aquí todavía".
export async function obtenerMembresiaCualquierEstado(usuarioId, negocioId) {
  try {
    const { rows } = await pool.query(
      `SELECT rol, activo FROM usuario_negocios WHERE usuario_id = $1 AND negocio_id = $2`,
      [usuarioId, negocioId]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerMembresiaCualquierEstado:', e.message);
    return null;
  }
}

// Activa/desactiva la membresía de un usuario a UN negocio específico --
// nunca toca usuarios.activo (que es global, afectaría a otros negocios del
// mismo usuario) ni membresías de otros negocios. El WHERE con ambos IDs es
// lo que hace imposible que un admin de negocio A afecte una fila de
// negocio B, incluso si adivinara el usuario_id correcto.
export async function actualizarEstadoMembresia(usuarioId, negocioId, activo) {
  try {
    const { rowCount } = await pool.query(
      `UPDATE usuario_negocios SET activo = $3 WHERE usuario_id = $1 AND negocio_id = $2`,
      [usuarioId, negocioId, activo]
    );
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Error actualizarEstadoMembresia:', e.message);
    return false;
  }
}

// Retirada a propósito: no existe una función para que un admin de negocio
// cambie la contraseña de otro usuario. usuarios.email es una identidad
// global (migración 006) que puede pertenecer a varios negocios -- un admin
// de UN negocio no debe poder afectar el acceso de esa persona a otros. La
// recuperación de contraseña se resolverá con un flujo personal (correo o
// enlace seguro), no desde el panel de administración de un negocio.

// ─── Configuración del negocio ───────────────────────────────────────────────
export async function obtenerConfiguracion(negocioId) {
  try {
    const id = negocioId || await resolverNegocioActualId();
    const result = await pool.query('SELECT clave, valor FROM configuracion WHERE negocio_id = $1', [id]);
    const config = {};
    result.rows.forEach(r => { config[r.clave] = r.valor; });
    return config;
  } catch (e) {
    console.error('[DB] Error obtenerConfiguracion:', e.message);
    return {};
  }
}

export async function actualizarConfiguracion(cambios, negocioId) {
  try {
    const id = negocioId || await resolverNegocioActualId();
    for (const [clave, valor] of Object.entries(cambios)) {
      await pool.query(
        'INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1, $2, $3) ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3',
        [id, clave, valor]
      );
    }
    return true;
  } catch (e) {
    console.error('[DB] Error actualizarConfiguracion:', e.message);
    return false;
  }
}

// ─── WhatsApp por negocio (fix seguridad: eliminar fallback global a
// Nonna Maye) ────────────────────────────────────────────────────────────
// Dos fuentes posibles de credenciales, en este orden:
//
// 1) Integración propia guardada en configuracion.int_wa_* para ESTE
//    negocio_id -- obtenerConfiguracion(negocioId) ya es negocio-scoped
//    cuando se le pasa un id explícito. Sirve para cualquier negocio
//    futuro con su propia integración (Alora el día que la tenga,
//    negocios sintéticos de prueba, etc).
//
// 2) Variables de entorno de Railway (META_PHONE_NUMBER_ID/TOKEN, con
//    WHATSAPP_PHONE_ID/TOKEN como alias legado -- el mismo orden exacto
//    que ya usa whatsapp-meta.js:getPhoneNumberId()/getAccessToken()) --
//    pero NUNCA como fallback genérico para "cualquier negocio sin
//    integración propia". Antes de usarlas se confirma contra
//    integraciones_canal que ESE phone_number_id de entorno está
//    vinculado exactamente a ESTE negocio_id (fail-closed: sin fila,
//    inactiva, o vinculada a otro negocio -> null, nunca se usan). No es
//    "Nonna Maye como caso especial": es "quien sea que
//    integraciones_canal diga que es dueño de ese número", que hoy
//    resuelve a Nonna Maye porque es la única fila real que existe.
//
// En ambos casos: solo se considera "configurado" si AMBAS claves
// (phone_number_id y token) están presentes -- nunca un envío con una
// credencial a medias.
// Fase B (integraciones por negocio, cifradas): se agrega una TERCERA
// fuente, consultada PRIMERO -- el almacenamiento cifrado nuevo
// (integraciones_canal + integraciones_canal_credenciales, vía
// integracionesService.js). Import dinámico a propósito: evita
// cualquier riesgo de dependencia circular estática (integracionesService.js
// importa `pool` de este mismo archivo) y sigue el mismo patrón ya usado
// en esta base de código para este tipo de import cruzado (ver
// rewardsService.js). Las dos fuentes heredadas NO se tocan ni se
// reordenan entre sí -- el fallback verificado de Nonna Maye hacia las
// variables de entorno de Railway sigue exactamente igual mientras no
// se migren sus credenciales reales a este modelo nuevo (Fase F).
export async function obtenerCredencialesWhatsappNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const id = negocioId.trim();

  try {
    const { obtenerCredencialesDescifradas } = await import('./integracionesService.js');
    const credencialesCifradas = await obtenerCredencialesDescifradas(id, 'whatsapp', 'meta');
    if (credencialesCifradas) return credencialesCifradas;
  } catch (e) {
    console.error('[DB] Error consultando integraciones cifradas (negocio ocultado):', e.message);
  }

  const cfg = await obtenerConfiguracion(id);
  if (cfg.int_wa_phone_id && cfg.int_wa_token) {
    return { phoneNumberId: cfg.int_wa_phone_id, accessToken: cfg.int_wa_token };
  }

  const envPhoneId = process.env.WHATSAPP_PHONE_ID || process.env.META_PHONE_NUMBER_ID || '';
  const envToken = process.env.WHATSAPP_TOKEN || process.env.META_WHATSAPP_TOKEN || '';
  if (!envPhoneId || !envToken) return null;

  const propietario = await obtenerIntegracionCanal('whatsapp', envPhoneId);
  if (propietario && propietario.negocioId === id) {
    return { phoneNumberId: envPhoneId, accessToken: envToken };
  }
  return null;
}

// ─── Impresión: modo por negocio y resolución de sucursal ───────────────────
// Solo lectura, fail-closed. Nunca usan resolverNegocioActualId() ni ningún
// negocio por defecto: negocioId debe llegar explícito del llamador. Un
// resultado ambiguo se traduce en modo/sucursalId = null con una "razon"
// explícita -- nunca en un valor adivinado. No se atrapan errores de
// consulta aquí: se propagan tal cual para que el llamador nunca los
// confunda con "configuración ausente" y jamás caiga a legacy por un fallo
// de DB.
export async function resolverModoImpresion(negocioId) {
  if (typeof negocioId !== 'string' || negocioId === '') {
    throw new Error('resolverModoImpresion: negocioId inválido u omitido');
  }
  const { rows } = await pool.query(
    `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = 'print_agent_legacy_activo'`,
    [negocioId]
  );
  if (rows.length === 0) {
    return { modo: null, configurado: false, razon: 'configuracion_ausente' };
  }
  const valor = rows[0].valor;
  if (valor === 'true')  return { modo: 'legacy', configurado: true };
  if (valor === 'false') return { modo: 'autenticado', configurado: true };
  // Cualquier otro texto es ambiguo -- no se compara con variantes
  // ('TRUE', '1', etc.) ni se registra el valor recibido.
  return { modo: null, configurado: false, razon: 'configuracion_invalida' };
}

export async function resolverSucursalParaImpresion(negocioId, sucursalIdPedido = null) {
  if (typeof negocioId !== 'string' || negocioId === '') {
    throw new Error('resolverSucursalParaImpresion: negocioId inválido u omitido');
  }
  if (sucursalIdPedido !== null && sucursalIdPedido !== undefined && typeof sucursalIdPedido !== 'string') {
    throw new Error('resolverSucursalParaImpresion: sucursalIdPedido debe ser string, null o undefined');
  }
  const tieneSucursalPedido = typeof sucursalIdPedido === 'string' && sucursalIdPedido.length > 0;

  // Caso A: el pedido trae sucursalId -- se valida contra DB (nunca por
  // formato/regex). Si no hay fila, es un error explícito: NO se cae a la
  // resolución de "sucursal única" del caso B.
  if (tieneSucursalPedido) {
    const { rows } = await pool.query(
      `SELECT id FROM sucursales WHERE id = $1 AND negocio_id = $2 AND activo = true`,
      [sucursalIdPedido, negocioId]
    );
    if (rows.length === 1) {
      return { sucursalId: rows[0].id, resueltaPor: 'pedido' };
    }
    return { sucursalId: null, resueltaPor: null, razon: 'sucursal_invalida' };
  }

  // Caso B: sin sucursalId -- resuelve solo si hay EXACTAMENTE una sucursal
  // activa del negocio. Nunca LIMIT 1, nunca la primera arbitrariamente.
  const { rows } = await pool.query(
    `SELECT id FROM sucursales WHERE negocio_id = $1 AND activo = true ORDER BY id`,
    [negocioId]
  );
  if (rows.length === 1) {
    return { sucursalId: rows[0].id, resueltaPor: 'unica_activa' };
  }
  if (rows.length === 0) {
    return { sucursalId: null, resueltaPor: null, razon: 'sin_sucursales_activas' };
  }
  return { sucursalId: null, resueltaPor: null, razon: 'multiples_sucursales_activas' };
}

// ─── Repartidores ─────────────────────────────────────────────────────────────
// Normaliza teléfonos mexicanos a formato local 10 dígitos (sin prefijo 52/521)
function normalizarTelefono(tel) {
  tel = String(tel).replace(/\D/g, ''); // solo dígitos
  if (tel.startsWith('521') && tel.length === 13) return tel.slice(3); // 521XXXXXXXXXX → XXXXXXXXXX
  if (tel.startsWith('52') && tel.length === 12) return tel.slice(2);  // 52XXXXXXXXXX → XXXXXXXXXX
  return tel;
}

// negocioId (Incidente P0): opcional en la escritura porque el registro
// público del repartidor (/api/repartidor/registro, sin sesión) hoy no
// carga negocio -- mismo hueco de arquitectura ya documentado para
// _negocioFallbackId en pedidos. Cuando SÍ se conoce (registro por
// WhatsApp, negocioId resuelto vía integraciones_canal) se escribe. El
// ON CONFLICT nunca reescribe negocio_id -- mismo criterio que
// upsertCliente: la primera vez que se ve ese teléfono fija al dueño.
export async function registrarRepartidor(nombre, telefono, negocioId) {
  const token = randomBytes(16).toString('hex');
  const telNorm = normalizarTelefono(telefono);
  try {
    const result = await pool.query(
      `INSERT INTO repartidores (nombre, telefono, token, negocio_id)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telefono) DO UPDATE SET nombre = $1, activo = TRUE
       RETURNING *`,
      [nombre, telNorm, token, negocioId || null]
    );
    return result.rows[0];
  } catch (e) {
    console.error('[DB] Error registrarRepartidor:', e.message);
    return null;
  }
}

export async function obtenerRepartidorPorToken(token) {
  try {
    const r = await pool.query('SELECT * FROM repartidores WHERE token = $1 AND activo = TRUE', [token]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

// negocioId opcional: cuando se pasa (flujo de WhatsApp, para decidir si el
// remitente es un repartidor DE ESE negocio) filtra con el mismo criterio de
// compatibilidad NULL limitado a Nonna Maye. Cuando se omite (login público
// del propio repartidor por teléfono) es autoservicio -- el repartidor solo
// puede obtener su propio registro por su propio teléfono, no hay negocio
// ajeno que exponer aquí.
export async function obtenerRepartidorPorTelefono(telefono, negocioId) {
  try {
    const telNorm = normalizarTelefono(telefono);
    if (negocioId) {
      const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
      const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;
      const r = await pool.query(
        'SELECT * FROM repartidores WHERE telefono = $1 AND (negocio_id = $2 OR ($3::boolean AND negocio_id IS NULL))',
        [telNorm, negocioId, incluirNull]
      );
      return r.rows[0] || null;
    }
    const r = await pool.query('SELECT * FROM repartidores WHERE telefono = $1', [telNorm]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

// negocioId OBLIGATORIO — falla cerrado (Incidente P0). Lista de repartidores
// del panel admin; era la fuga confirmada por el diagnóstico de producción.
export async function obtenerRepartidores(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerRepartidores: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;
    const r = await pool.query(`
      SELECT r.*,
        COALESCE((
          SELECT COUNT(*) FROM pedidos_activos
          WHERE datos->>'repartidor_id' = r.id::text
            AND estado = 'entregado'
        ), 0)::int AS pedidos_entregados
      FROM repartidores r
      WHERE r.negocio_id = $1 OR ($2::boolean AND r.negocio_id IS NULL)
      ORDER BY r.activo DESC, r.nombre ASC
    `, [negocioId, incluirNull]);
    return r.rows;
  } catch (e) { return []; }
}

// negocioId OBLIGATORIO — falla cerrado (Auditoría P0 complementaria,
// push). El llamador debe derivarlo del propio repartidor autenticado
// (req.repartidor.negocio_id), nunca de un valor enviado aparte.
export async function guardarPushRepartidor(repartidorId, subscription, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] guardarPushRepartidor: negocioId inválido u omitido — rechazado, no se guarda sin negocio');
    return false;
  }
  try {
    await pool.query(
      `INSERT INTO push_subscriptions_repartidor (repartidor_id, endpoint, auth, p256dh, negocio_id)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (endpoint) DO UPDATE SET auth = $3, p256dh = $4, negocio_id = $5`,
      [repartidorId, subscription.endpoint, subscription.keys.auth, subscription.keys.p256dh, negocioId.trim()]
    );
    return true;
  } catch (e) { console.error('[DB] Error guardarPushRepartidor:', e.message); return false; }
}

export async function obtenerPushRepartidores(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerPushRepartidores: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  try {
    const r = await pool.query(
      `SELECT p.endpoint, p.auth, p.p256dh
       FROM push_subscriptions_repartidor p
       JOIN repartidores rep ON rep.id = p.repartidor_id
       WHERE rep.activo = TRUE AND p.negocio_id = $1`,
      [negocioId.trim()]
    );
    return r.rows.map(r => ({ endpoint: r.endpoint, keys: { auth: r.auth, p256dh: r.p256dh } }));
  } catch (e) { return []; }
}

// negocioId OBLIGATORIO — falla cerrado (Auditoría P0, Categoría B). Un
// repartidor de un negocio no puede aceptar el folio de otro -- se
// comporta idéntico a "ya lo tomó otro" (false), nunca revela ni modifica
// el pedido ajeno.
export async function asignarRepartidor(folio, repartidorId, nombreRepartidor, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] asignarRepartidor: negocioId inválido u omitido — rechazado, no se modifica sin negocio');
    return false;
  }
  try {
    // Asignación atómica — solo si aún no tiene repartidor y el pedido es
    // del mismo negocio que el repartidor autenticado
    const result = await pool.query(
      `UPDATE pedidos_activos
       SET datos = jsonb_set(jsonb_set(datos, '{repartidor_id}', $2::jsonb), '{repartidor_nombre}', $3::jsonb),
           updated_at = NOW()
       WHERE folio = $1
         AND negocio_id = $4
         AND (datos->>'repartidor_id') IS NULL
         AND estado NOT IN ('entregado','cancelado')
       RETURNING folio`,
      [folio, JSON.stringify(repartidorId), JSON.stringify(nombreRepartidor), negocioId.trim()]
    );
    return result.rows.length > 0; // true = asignado, false = ya lo tomó otro (o es de otro negocio)
  } catch (e) {
    console.error('[DB] Error asignarRepartidor:', e.message);
    return false;
  }
}

// negocioId OBLIGATORIO — falla cerrado (Auditoría P0, Categoría A). El
// llamador lo deriva del propio repartidor autenticado
// (req.repartidor.negocio_id), nunca de un valor enviado aparte.
export async function obtenerPedidosParaRepartidor(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerPedidosParaRepartidor: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  try {
    const r = await pool.query(
      `SELECT folio, datos, estado FROM pedidos_activos
       WHERE estado IN ('nuevo','en_preparacion','listo')
         AND datos->>'modalidad' = 'entrega a domicilio'
         AND (datos->>'repartidor_id') IS NULL
         AND negocio_id = $1
       ORDER BY created_at ASC`,
      [negocioId.trim()]
    );
    return r.rows;
  } catch (e) { return []; }
}

export async function obtenerPedidosAsignadosARepartidor(repartidorId) {
  try {
    const r = await pool.query(
      `SELECT folio, datos, estado FROM pedidos_activos
       WHERE estado NOT IN ('entregado','cancelado')
         AND datos->>'modalidad' = 'entrega a domicilio'
         AND datos->>'repartidor_id' = $1
       ORDER BY created_at ASC`,
      [String(repartidorId)]
    );
    return r.rows;
  } catch (e) { return []; }
}

// negocioId OBLIGATORIO — falla cerrado (Incidente P0). Sin esto, cualquier
// negocio podía borrar el repartidor de OTRO negocio con solo conocer su id
// (escritura sin validar dueño).
export async function eliminarRepartidor(id, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] eliminarRepartidor: negocioId inválido u omitido — rechazado, no se borra sin negocio');
    return false;
  }
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;
    const { rowCount } = await pool.query(
      'DELETE FROM repartidores WHERE id = $1 AND (negocio_id = $2 OR ($3::boolean AND negocio_id IS NULL))',
      [id, negocioId, incluirNull]
    );
    return rowCount > 0;
  } catch(e) { return false; }
}

// negocioId OBLIGATORIO — falla cerrado (Incidente P0). Consulta la misma
// tabla mensajes que guardarMensaje/obtenerConversacion, mismo criterio de
// compatibilidad NULL limitado a Nonna Maye.
export async function obtenerCandidatosRepartidor(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerCandidatosRepartidor: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  try {
    const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
    const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;
    const r = await pool.query(`
      SELECT DISTINCT ON (telefono) telefono, nombre, texto, timestamp
      FROM mensajes
      WHERE LOWER(texto) LIKE '%repartidor%'
        AND direccion = 'entrante'
        AND timestamp > NOW() - INTERVAL '72 hours'
        AND (negocio_id = $1 OR ($2::boolean AND negocio_id IS NULL))
      ORDER BY telefono, timestamp DESC
    `, [negocioId, incluirNull]);
    return r.rows;
  } catch(e) { return []; }
}

// negocioId OBLIGATORIO — falla cerrado (sin escritura global) si falta.
export async function guardarFondoCaja(fechaMX, monto, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] guardarFondoCaja: negocioId inválido u omitido — rechazado, sin escritura global');
    return false;
  }
  const negocioIdNorm = negocioId.trim();
  try {
    await pool.query(`
      INSERT INTO caja_fondos (fecha, fondo, negocio_id)
      VALUES ($1, $2, $3)
      ON CONFLICT (negocio_id, fecha) DO NOTHING
    `, [fechaMX, monto, negocioIdNorm]);
    return true;
  } catch (e) {
    console.error('[DB] Error guardarFondoCaja:', e.message);
    return false;
  }
}

// Obtiene el fondo registrado para una fecha MX (formato 'YYYY-MM-DD').
// negocioId OBLIGATORIO — falla cerrado (sin lectura global) si falta.
export async function obtenerFondoCaja(fechaMX, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerFondoCaja: negocioId inválido u omitido — rechazado, sin lectura global');
    return null;
  }
  const negocioIdNorm = negocioId.trim();
  try {
    const result = await pool.query(
      `SELECT fondo, created_at FROM caja_fondos WHERE fecha = $1 AND negocio_id = $2`,
      [fechaMX, negocioIdNorm]
    );
    return result.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerFondoCaja:', e.message);
    return null;
  }
}

// ─── Campañas WA ──────────────────────────────────────────────────────────────

// negocioId: a diferencia de pedidos/clientes/rewards, las campañas se
// crean EXCLUSIVAMENTE desde esta función (ningún canal en vivo las
// escribe) — es seguro filtrar su listado por negocio_id sin riesgo de que
// una campaña nueva "desaparezca" por no tener la columna poblada.
export async function crearCampana({ nombre, segmento, mensaje, totalDestinatarios, negocioId }) {
  const { rows } = await pool.query(
    `INSERT INTO campanas (nombre, segmento, mensaje, total_destinatarios, estado, negocio_id)
     VALUES ($1, $2, $3, $4, 'enviando', $5)
     RETURNING id`,
    [nombre, segmento, mensaje, totalDestinatarios, negocioId || null]
  );
  return rows[0].id;
}

export async function registrarEnvioCampana(campanaId, telefono, nombre, ok) {
  await pool.query(
    `INSERT INTO campana_envios (campana_id, telefono, nombre, estado, enviado_at)
     VALUES ($1, $2, $3, $4, NOW())`,
    [campanaId, telefono, nombre || null, ok ? 'enviado' : 'fallido']
  );
  // Incrementar contador en la cabecera
  const col = ok ? 'enviados' : 'fallidos';
  await pool.query(`UPDATE campanas SET ${col} = ${col} + 1 WHERE id = $1`, [campanaId]);
}

export async function completarCampana(campanaId) {
  await pool.query(
    `UPDATE campanas SET estado = 'completada', completada_at = NOW() WHERE id = $1`,
    [campanaId]
  );
}

// negocioId es obligatorio: sin él se devuelve una lista vacía en vez de
// filtrar "todas las campañas" por accidente (falla cerrado, mismo
// criterio que seedMenuDesdeJSON).
export async function obtenerCampanas(negocioId, limit = 20) {
  if (!negocioId) {
    console.error('[DB] obtenerCampanas: negocioId requerido — devolviendo lista vacía.');
    return [];
  }
  const { rows } = await pool.query(
    `SELECT id, nombre, segmento, total_destinatarios, enviados, fallidos, respondidos,
            estado, creada_at, completada_at
     FROM campanas
     WHERE negocio_id = $1
     ORDER BY creada_at DESC
     LIMIT $2`,
    [negocioId, limit]
  );
  return rows;
}

export async function marcarRespuestaCampana(telefono) {
  // Si este teléfono recibió una campaña en las últimas 48h y no había respondido, marcarlo
  await pool.query(`
    UPDATE campana_envios SET respondio_at = NOW()
    WHERE telefono = $1
      AND estado = 'enviado'
      AND respondio_at IS NULL
      AND enviado_at > NOW() - INTERVAL '48 hours'
  `, [telefono]);

  // Actualizar contador de respondidos en las campañas afectadas
  await pool.query(`
    UPDATE campanas SET respondidos = (
      SELECT COUNT(*) FROM campana_envios
      WHERE campana_id = campanas.id AND respondio_at IS NOT NULL
    )
    WHERE id IN (
      SELECT DISTINCT campana_id FROM campana_envios
      WHERE telefono = $1 AND respondio_at IS NOT NULL
    )
  `, [telefono]);
}

// negocioId OBLIGATORIO — falla cerrado (Incidente P0). Antes no filtraba
// por negocio en absoluto: una campaña creada desde cualquier negocio podía
// mandar WhatsApp a los clientes reales de otro negocio. tenant_id de
// rewards_accounts ahora es el negocio_id real (migración 013), nunca
// 'xabor-principal' hardcodeado. Mismo criterio de compatibilidad NULL
// limitado a Nonna Maye que en mensajes/clientes (los 2 clientes con
// negocio_id NULL). De paso se parametriza segmento — antes se interpolaba
// directo en el SQL (inyección posible desde un admin autenticado).
export async function obtenerDestinatariosCampana(segmento, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerDestinatariosCampana: negocioId inválido u omitido — rechazado, sin consulta global');
    return [];
  }
  const nonnaMayeId = await obtenerNegocioIdPorSlug('nonna-maye');
  const incluirNull = !!nonnaMayeId && negocioId === nonnaMayeId;

  // Segmentos Rewards — clientes con N+ puntos de saldo activo
  if (segmento?.startsWith('rewards_')) {
    const minPts = parseInt(segmento.replace('rewards_', '')) || 0;
    const { rows } = await pool.query(`
      SELECT c.telefono, c.nombre
      FROM clientes c
      JOIN rewards_accounts a ON a.telefono = c.telefono AND a.tenant_id = $2
      LEFT JOIN repartidores r ON r.telefono = c.telefono
      WHERE c.telefono != '—'
        AND c.telefono NOT LIKE 'rappi-%'
        AND r.telefono IS NULL
        AND NOT COALESCE(c.es_interno, FALSE)
        AND (c.negocio_id = $2 OR ($3::boolean AND c.negocio_id IS NULL))
        AND a.puntos_balance >= $1
      ORDER BY a.puntos_balance DESC
    `, [minPts, negocioId, incluirNull]);
    return rows;
  }

  // Segmentos CRM estándar
  const { rows } = await pool.query(`
    SELECT c.telefono, c.nombre
    FROM clientes c
    LEFT JOIN perfiles_clientes p ON p.telefono = c.telefono
    LEFT JOIN repartidores r ON r.telefono = c.telefono
    WHERE c.telefono != '—'
      AND c.telefono NOT LIKE 'rappi-%'
      AND r.telefono IS NULL
      AND NOT COALESCE(c.es_interno, FALSE)
      AND (c.negocio_id = $1 OR ($3::boolean AND c.negocio_id IS NULL))
      AND ($2 = 'todos' OR COALESCE(p.segmento, 'nuevo') = $2)
    ORDER BY COALESCE(p.total_gastado, 0) DESC
  `, [negocioId, segmento, incluirNull]);
  return rows;
}

// ─── Superadmin de plataforma (Fase 6) ──────────────────────────────────────
// Todo lo de aquí abajo opera FUERA del concepto de "negocio de la sesión":
// un superadmin ve y toca varios negocios a la vez por diseño. Ninguna
// función acepta negocioId sin validarlo contra la fila real en `negocios`
// (existe/no existe), pero a diferencia del resto del archivo, aquí SÍ se
// opera deliberadamente sobre cualquier negocio -- ese es el propósito de
// este módulo, no un descuido de aislamiento.

const MODULOS_VALIDOS = [
  'pos', 'usuarios', 'caja', 'menu', 'impresion', 'whatsapp', 'voz', 'rappi', 'facturacion', 'rewards',
  'chat_imagenes', 'chat_documentos_pdf', 'cotizaciones', 'generador_cotizaciones', 'pagos', 'repartidores',
];
// Incluye tanto el vocabulario heredado (usado por pos/usuarios/caja/menu/
// impresion/whatsapp/voz/rappi/facturacion) como el vocabulario canónico
// aprobado para Rewards (pendiente_configuracion, no_contratado) -- ambos
// conjuntos son válidos a la vez, igual que en el CHECK de negocio_modulos
// (migración 015); ningún módulo existente cambia de vocabulario aquí.
const ESTADOS_MODULO_VALIDOS = ['no_configurado', 'pendiente', 'configurado', 'activo', 'suspendido', 'pendiente_configuracion', 'no_contratado'];
const ESTADOS_NEGOCIO_VALIDOS = ['pendiente', 'activo', 'suspendido'];
const PLANES_VALIDOS = ['prueba', 'basico', 'pro', 'personalizado'];

// ─── Control real de módulos por negocio (fase "módulos") ──────────────────
// Criterio de disponibilidad, documentado explícitamente (no se inventan
// estados nuevos -- son exactamente los 5 que ya define el CHECK de
// negocio_modulos.estado, ver migración 011):
//   'activo' o 'configurado'  -> módulo DISPONIBLE
//   'pendiente' | 'no_configurado' | 'suspendido' | (sin fila)  -> BLOQUEADO
// 'configurado' cuenta como disponible porque ya lo usa así el flujo real de
// facturación (Nonna Maye tiene facturacion='configurado' en producción,
// nunca 'activo', y ya emite facturas hoy -- tratarlo como bloqueado sería
// una regresión real, no una corrección).
const MODULO_ESTADOS_DISPONIBLES = ['activo', 'configurado'];

export async function moduloHabilitado(negocioId, modulo) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return false;
  if (!MODULOS_VALIDOS.includes(modulo)) return false;
  try {
    const { rows } = await pool.query(
      'SELECT estado FROM negocio_modulos WHERE negocio_id = $1 AND modulo = $2',
      [negocioId.trim(), modulo]
    );
    return !!rows[0] && MODULO_ESTADOS_DISPONIBLES.includes(rows[0].estado);
  } catch (e) {
    console.error('[DB] Error moduloHabilitado:', e.message);
    return false;
  }
}

// Estado crudo del módulo (o null si no hay fila) -- a diferencia de
// moduloHabilitado (que colapsa todo a true/false), esto se usa donde el
// llamador necesita distinguir POR QUÉ está bloqueado (no contratado vs
// pendiente de configurar vs suspendido) para responder con un código
// estructurado, no solo un texto genérico.
export async function obtenerEstadoModulo(negocioId, modulo) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  if (!MODULOS_VALIDOS.includes(modulo)) return null;
  try {
    const { rows } = await pool.query(
      'SELECT estado FROM negocio_modulos WHERE negocio_id = $1 AND modulo = $2',
      [negocioId.trim(), modulo]
    );
    return rows[0]?.estado ?? null;
  } catch (e) {
    console.error('[DB] Error obtenerEstadoModulo:', e.message);
    return null;
  }
}

// Lista de módulos disponibles para el negocio de la sesión -- usada por
// /api/auth/me para que el frontend construya su navegación. Nunca incluye
// el estado crudo (activo vs configurado) ni ningún otro dato de
// negocio_modulos -- solo los nombres ya filtrados a "disponible".
export async function obtenerModulosHabilitados(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  try {
    const { rows } = await pool.query(
      'SELECT modulo FROM negocio_modulos WHERE negocio_id = $1 AND estado = ANY($2) ORDER BY modulo',
      [negocioId.trim(), MODULO_ESTADOS_DISPONIBLES]
    );
    return rows.map(r => r.modulo);
  } catch (e) {
    console.error('[DB] Error obtenerModulosHabilitados:', e.message);
    return [];
  }
}

// Único punto de verdad de "¿esta persona es superadmin?" -- tabla separada
// de `usuarios` a propósito (ver migración 011 para el razonamiento
// completo). activo=true además de la fila existir: revocar el privilegio
// nunca borra el registro histórico, solo lo desactiva.
export async function esSuperadmin(usuarioId) {
  if (!usuarioId) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM administradores_plataforma WHERE usuario_id = $1 AND activo = true`,
      [usuarioId]
    );
    return rows.length > 0;
  } catch (e) {
    console.error('[DB] Error esSuperadmin:', e.message);
    return false;
  }
}

function slugify(texto) {
  return String(texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[̀-ͯ]/g, '') // quitar acentos
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export async function registrarAuditoriaPlataforma({ superadminId, accion, negocioId = null, usuarioId = null, estadoAnterior = null, estadoNuevo = null, contexto = null }, client = pool) {
  await client.query(
    `INSERT INTO auditoria_plataforma (superadmin_id, accion, negocio_id, usuario_id, estado_anterior, estado_nuevo, contexto)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [superadminId, accion, negocioId, usuarioId, estadoAnterior, estadoNuevo, contexto]
  );
}

export async function obtenerDashboardSuperadmin() {
  const [totales, recientes, sinAdmin, sinTerminalOMenu] = await Promise.all([
    pool.query(`
      SELECT
        count(*) AS total_negocios,
        count(*) FILTER (WHERE estado = 'activo')      AS activos,
        count(*) FILTER (WHERE estado = 'pendiente')    AS pendientes,
        count(*) FILTER (WHERE estado = 'suspendido')   AS suspendidos,
        (SELECT count(*) FROM usuarios)                 AS total_usuarios,
        (SELECT count(*) FROM sucursales)                AS total_sucursales
      FROM negocios
    `),
    pool.query(`SELECT id, nombre, slug, estado, plan, created_at FROM negocios ORDER BY created_at DESC LIMIT 5`),
    pool.query(`
      SELECT n.id, n.nombre, n.slug
      FROM negocios n
      WHERE NOT EXISTS (
        SELECT 1 FROM usuario_negocios un WHERE un.negocio_id = n.id AND un.rol = 'admin' AND un.activo = true
      )
      ORDER BY n.created_at DESC
    `),
    pool.query(`
      SELECT n.id, n.nombre, n.slug,
        NOT EXISTS (SELECT 1 FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id WHERE s.negocio_id = n.id) AS sin_terminal,
        NOT EXISTS (SELECT 1 FROM menu_productos mp WHERE mp.negocio_id = n.id) AS sin_menu
      FROM negocios n
    `)
  ]);
  const t = totales.rows[0];
  return {
    totalNegocios: Number(t.total_negocios),
    activos: Number(t.activos),
    pendientes: Number(t.pendientes),
    suspendidos: Number(t.suspendidos),
    totalUsuarios: Number(t.total_usuarios),
    totalSucursales: Number(t.total_sucursales),
    recientes: recientes.rows,
    onboardingIncompleto: recientes.rows.filter(n => n.estado === 'pendiente'),
    sinAdministrador: sinAdmin.rows,
    sinTerminalOMenu: sinTerminalOMenu.rows.filter(n => n.sin_terminal || n.sin_menu),
  };
}

// limit siempre acotado (máx 100) -- "todas las consultas globales deben
// estar limitadas y ordenadas" (requisito de seguridad de esta tarea).
export async function obtenerNegociosParaSuperadmin({ buscar = '', estado = '', plan = '', limit = 50, offset = 0 } = {}) {
  const limitSeguro = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const offsetSeguro = Math.max(Number(offset) || 0, 0);
  const condiciones = [];
  const params = [];
  if (buscar) {
    params.push(`%${buscar}%`);
    condiciones.push(`(n.nombre ILIKE $${params.length} OR n.slug ILIKE $${params.length})`);
  }
  if (estado && ESTADOS_NEGOCIO_VALIDOS.includes(estado)) {
    params.push(estado);
    condiciones.push(`n.estado = $${params.length}`);
  }
  if (plan && PLANES_VALIDOS.includes(plan)) {
    params.push(plan);
    condiciones.push(`n.plan = $${params.length}`);
  }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  params.push(limitSeguro, offsetSeguro);

  const { rows } = await pool.query(`
    SELECT
      n.id, n.nombre, n.slug, n.estado, n.plan, n.created_at,
      (SELECT u.nombre FROM usuario_negocios un JOIN usuarios u ON u.id = un.usuario_id WHERE un.negocio_id = n.id AND un.rol = 'admin' ORDER BY un.created_at ASC LIMIT 1) AS admin_nombre,
      (SELECT u.email FROM usuario_negocios un JOIN usuarios u ON u.id = un.usuario_id WHERE un.negocio_id = n.id AND un.rol = 'admin' ORDER BY un.created_at ASC LIMIT 1) AS admin_email,
      (SELECT count(*) FROM sucursales s WHERE s.negocio_id = n.id) AS num_sucursales,
      (SELECT count(*) FROM usuario_negocios un WHERE un.negocio_id = n.id) AS num_usuarios,
      n.checklist
    FROM negocios n
    ${where}
    ORDER BY n.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  return rows;
}

export async function obtenerNegocioDetalleSuperadmin(negocioId) {
  const negocio = await pool.query(`SELECT id, nombre, slug, estado, plan, checklist, created_at, updated_at FROM negocios WHERE id = $1`, [negocioId]);
  if (!negocio.rows.length) return null;

  const [usuarios, sucursales, terminales, integraciones, modulos, auditoria] = await Promise.all([
    pool.query(`SELECT u.id, u.nombre, u.email, un.rol, un.activo, u.created_at FROM usuarios u JOIN usuario_negocios un ON un.usuario_id = u.id WHERE un.negocio_id = $1 ORDER BY u.created_at ASC`, [negocioId]),
    pool.query(`SELECT id, nombre, activo, created_at FROM sucursales WHERE negocio_id = $1 ORDER BY created_at ASC`, [negocioId]),
    // Nunca token_hash -- solo metadatos.
    pool.query(`SELECT t.id, t.nombre, t.codigo, t.tipo, t.activo, (t.token_hash IS NOT NULL) AS credencial_emitida, s.nombre AS sucursal_nombre FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id WHERE s.negocio_id = $1 ORDER BY t.created_at ASC`, [negocioId]),
    // Nunca el identificador crudo completo -- enmascarado a los últimos 4 caracteres.
    pool.query(`SELECT canal, nombre, activo, created_at, RIGHT(identificador, 4) AS identificador_enmascarado FROM integraciones_canal WHERE negocio_id = $1 ORDER BY created_at ASC`, [negocioId]),
    pool.query(`SELECT modulo, estado, updated_at FROM negocio_modulos WHERE negocio_id = $1 ORDER BY modulo`, [negocioId]),
    pool.query(`
      SELECT a.id, a.accion, a.estado_anterior, a.estado_nuevo, a.contexto, a.created_at, u.nombre AS superadmin_nombre
      FROM auditoria_plataforma a JOIN usuarios u ON u.id = a.superadmin_id
      WHERE a.negocio_id = $1 ORDER BY a.created_at DESC LIMIT 20
    `, [negocioId]),
  ]);

  return {
    ...negocio.rows[0],
    usuarios: usuarios.rows,
    sucursales: sucursales.rows,
    terminales: terminales.rows,
    integraciones: integraciones.rows,
    modulos: modulos.rows,
    auditoriaReciente: auditoria.rows,
  };
}

// Checklist previo a activar el bot de WhatsApp (piloto -- preparación
// para primeros clientes). Los ítems "automáticos" se derivan de datos
// que YA existen (integración, configuracion.nombre/horario,
// configuracion.reglas_atencion, menú) -- nunca se inventan claves nuevas
// para representarlos. Los 3 ítems sin ningún campo existente que los
// respalde (mensaje inicial revisado / prueba manual confirmada /
// aceptación del administrador) son confirmaciones manuales del
// superadmin, guardadas como nuevas claves en el mismo negocios.checklist
// JSONB ya usado por el checklist de instalación (migración 011) --
// reutiliza actualizarChecklistNegocioSuperadmin, sin tabla nueva.
export async function obtenerChecklistActivacionBot(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const [negocioRows, integracionRows, cfg, menu] = await Promise.all([
    pool.query(`SELECT bot_whatsapp_activo, checklist FROM negocios WHERE id = $1`, [negocioId]),
    pool.query(`SELECT estado FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'whatsapp' ORDER BY created_at DESC LIMIT 1`, [negocioId]),
    obtenerConfiguracion(negocioId),
    obtenerMenuCompleto(negocioId),
  ]);
  if (!negocioRows.rows.length) return null;

  // configuracion.reglas_atencion se guarda como TEXT (JSON serializado,
  // igual que lo lee agent/prompts.js#cargarReglas) -- nunca es un objeto
  // ya parseado al salir de obtenerConfiguracion.
  let reglas = null;
  if (cfg.reglas_atencion) {
    try { reglas = JSON.parse(cfg.reglas_atencion); } catch { reglas = null; }
  }
  const pedidos = reglas?.pedidos || {};
  const checklist = negocioRows.rows[0].checklist || {};

  const automaticos = {
    integracion_conectada: integracionRows.rows[0]?.estado === 'activo',
    bot_apagado: negocioRows.rows[0].bot_whatsapp_activo === false,
    nombre_negocio: !!(cfg.nombre && String(cfg.nombre).trim()),
    horarios: !!(cfg.horario && String(cfg.horario).trim()) || !!(reglas?.horarios && Object.keys(reglas.horarios).length > 0),
    productos_servicios: Array.isArray(menu) && menu.some(cat => Array.isArray(cat.productos) && cat.productos.length > 0),
    metodos_pago: Array.isArray(pedidos.pago_aceptado) && pedidos.pago_aceptado.length > 0,
    modalidades_entrega: Array.isArray(pedidos.modalidades) && pedidos.modalidades.length > 0,
    reglas_operativas: !!reglas,
  };
  const manuales = {
    mensaje_inicial_revisado: checklist.mensaje_inicial_revisado === true,
    prueba_manual_confirmada: checklist.prueba_manual_confirmada === true,
    aceptacion_administrador: checklist.aceptacion_administrador === true,
  };
  const listoParaActivar = Object.values(automaticos).every(Boolean) && Object.values(manuales).every(Boolean);
  return { automaticos, manuales, listoParaActivar };
}

// Diagnóstico y soporte (Fase 6 -- panel comercial). Agrega datos que YA
// existen en varias tablas (integraciones_canal, mensajes, negocio_modulos,
// bot_whatsapp_activo, checklist) en una sola lectura de solo lectura.
// Nunca incluye tokens/IVs/auth tags -- reutiliza COLUMNAS_SEGURAS de
// integracionesService.js (recibida ya filtrada por el llamador) y aquí
// mismo nunca hace SELECT * sobre integraciones_canal_credenciales.
export async function obtenerDiagnosticoNegocio(negocioId, integracionWhatsapp) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;

  const [botActivo, ultimoEntrante, ultimoSaliente, conversacionesRecientes, modulosRows, checklist] = await Promise.all([
    obtenerBotWhatsappActivoNegocio(negocioId),
    pool.query(`SELECT timestamp FROM mensajes WHERE negocio_id = $1 AND direccion = 'entrante' ORDER BY timestamp DESC LIMIT 1`, [negocioId]),
    pool.query(`SELECT timestamp FROM mensajes WHERE negocio_id = $1 AND direccion = 'saliente' ORDER BY timestamp DESC LIMIT 1`, [negocioId]),
    obtenerConversacionesRecientes(negocioId, 20),
    pool.query(`SELECT modulo, estado FROM negocio_modulos WHERE negocio_id = $1`, [negocioId]),
    obtenerChecklistActivacionBot(negocioId),
  ]);

  const modulos = {};
  for (const row of modulosRows.rows) modulos[row.modulo] = row.estado;

  const requierenAtencion = conversacionesRecientes.filter(c => c.direccion === 'entrante').length;

  return {
    whatsapp: {
      estado: integracionWhatsapp?.estado || 'no_configurado',
      botActivo,
      ultimaRecepcion: ultimoEntrante.rows[0]?.timestamp || null,
      ultimoEnvioExitoso: ultimoSaliente.rows[0]?.timestamp || null,
      ultimoErrorCodigo: integracionWhatsapp?.ultimo_error_codigo || null,
      ultimoErrorAt: integracionWhatsapp?.ultimo_error_at || null,
    },
    chats: {
      conversacionesRecientes: conversacionesRecientes.length,
      requierenAtencion,
    },
    operacion: checklist ? checklist.automaticos : null,
    integraciones: modulos,
  };
}

// Plan comercial (Fase 7 -- exclusivo de Superadmin, nunca visible en el
// panel del propio negocio). Un registro por negocio (PK = negocio_id);
// se crea con defaults seguros ('prospecto') la primera vez que se
// consulta, para que la pantalla nunca tenga que inventar valores en el
// frontend.
export async function obtenerPlanComercial(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { rows } = await pool.query('SELECT * FROM negocio_plan_comercial WHERE negocio_id = $1', [negocioId]);
  if (rows[0]) return rows[0];
  const { rows: negocioRows } = await pool.query('SELECT id FROM negocios WHERE id = $1', [negocioId]);
  if (!negocioRows[0]) return null;
  return { negocio_id: negocioId, plan: 'prospecto', estado: 'prospecto', mensualidad: null, costo_instalacion: null, instalacion_pagada: false, fecha_inicio: null, proxima_fecha_pago: null, notas: null, responsable: null, fecha_ultimo_seguimiento: null };
}

const CAMPOS_PLAN_COMERCIAL = ['plan','mensualidad','costo_instalacion','instalacion_pagada','fecha_inicio','proxima_fecha_pago','estado','notas','responsable','fecha_ultimo_seguimiento'];
const ESTADOS_PLAN_COMERCIAL = ['prospecto','prueba','activo','vencido','suspendido','cancelado'];
export async function actualizarPlanComercial(negocioId, cambios, superadminId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  if (cambios.estado !== undefined && !ESTADOS_PLAN_COMERCIAL.includes(cambios.estado)) {
    const err = new Error('estado de plan comercial inválido'); err.code = 'ESTADO_INVALIDO'; throw err;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existente } = await client.query('SELECT * FROM negocio_plan_comercial WHERE negocio_id = $1 FOR UPDATE', [negocioId]);
    const anterior = existente[0] || null;
    const claves = Object.keys(cambios).filter(k => CAMPOS_PLAN_COMERCIAL.includes(k));
    if (!claves.length) { await client.query('ROLLBACK'); return anterior; }
    const cols = ['negocio_id', ...claves];
    const placeholders = cols.map((_, i) => `$${i+1}`);
    const updates = claves.map(k => `${k} = EXCLUDED.${k}`).join(', ') + ', updated_at = NOW()';
    const { rows } = await client.query(
      `INSERT INTO negocio_plan_comercial (${cols.join(',')}) VALUES (${placeholders.join(',')})
       ON CONFLICT (negocio_id) DO UPDATE SET ${updates} RETURNING *`,
      [negocioId, ...claves.map(k => cambios[k])]
    );
    await registrarAuditoriaPlataforma({
      superadminId, accion: 'cambiar_plan_comercial_negocio', negocioId,
      estadoAnterior: anterior, estadoNuevo: rows[0],
    }, client);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code === 'ESTADO_INVALIDO') throw e;
    console.error('[DB] Error actualizarPlanComercial:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// Creación completa y transaccional de un negocio nuevo. Reutiliza
// hashPassword (mismo mecanismo que crearUsuarioConPassword) -- nunca un
// segundo camino para generar un hash. Si CUALQUIER paso falla, ROLLBACK
// total: nunca queda un negocio sin sucursal, sin admin o sin membresía.
export async function crearNegocioCompleto({ nombre, slugDeseado, nombrePropietario, emailAdmin, telefono, nombreSucursal, ciudad, plan, modulosIniciales, estadoInicial, superadminId }) {
  const slugBase = slugify(slugDeseado || nombre);
  if (!slugBase) {
    const err = new Error('No se pudo generar un slug válido a partir del nombre'); err.code = 'SLUG_INVALIDO'; throw err;
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows: slugExistente } = await client.query('SELECT 1 FROM negocios WHERE slug = $1', [slugBase]);
    if (slugExistente.length) {
      const err = new Error('El slug ya está en uso'); err.code = 'SLUG_DUPLICADO'; throw err;
    }

    // Correo existente: identidad global (migración 006) -- nunca se
    // vincula en silencio (mismo criterio que POST /api/admin/usuarios).
    const emailNorm = emailAdmin.trim().toLowerCase();
    const { rows: usuarioExistente } = await client.query('SELECT id FROM usuarios WHERE email = $1', [emailNorm]);
    if (usuarioExistente.length) {
      const err = new Error('Ya existe una cuenta con este correo. No se puede crear automáticamente desde aquí.'); err.code = 'EMAIL_EXISTENTE'; throw err;
    }

    const { rows: [negocio] } = await client.query(
      `INSERT INTO negocios (nombre, slug, activo, estado, plan) VALUES ($1,$2,$3,$4,$5) RETURNING id, nombre, slug, estado, plan, created_at`,
      [nombre, slugBase, estadoInicial === 'activo', estadoInicial, plan]
    );

    const { rows: [sucursal] } = await client.query(
      `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,$2) RETURNING id, nombre`,
      [negocio.id, nombreSucursal]
    );

    // password_hash NULL a propósito (la columna es nullable desde la
    // migración 006, exactamente para este caso: "un usuario sin
    // password_hash simplemente no puede iniciar sesión todavía"). Nunca se
    // genera una contraseña aleatoria que nadie conoce -- el flujo de
    // invitación (ver abajo) es el único camino para que este usuario quede
    // con una contraseña utilizable.
    const { rows: [usuario] } = await client.query(
      `INSERT INTO usuarios (negocio_id, nombre, email, password_hash) VALUES ($1,$2,$3,NULL) RETURNING id, nombre, email`,
      [negocio.id, nombrePropietario, emailNorm]
    );
    await client.query(
      `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'admin')`,
      [usuario.id, negocio.id]
    );

    // Configuración base -- mismas claves que ya usa Nonna Maye (reutiliza
    // el mecanismo existente de `configuracion`, no columnas nuevas).
    const camposConfig = [
      ['nombre', nombre], ['nombre_corto', nombre.slice(0, 20)],
      ['ciudad', ciudad || ''], ['telefono', telefono || ''],
    ];
    for (const [clave, valor] of camposConfig) {
      await client.query(
        `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3) ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3`,
        [negocio.id, clave, valor]
      );
    }

    const checklistInicial = {
      negocio_creado: true, administrador_creado: true, sucursal_creada: true,
      datos_generales_completos: false, menu_cargado: false, usuarios_creados: false,
      terminal_creada: false, impresion_probada: false, whatsapp_configurado: false,
      rappi_configurado: false, pedido_prueba: false, listo_para_operar: false,
    };
    await client.query('UPDATE negocios SET checklist = $2 WHERE id = $1', [negocio.id, JSON.stringify(checklistInicial)]);

    const modulosSet = new Set(modulosIniciales || []);
    for (const modulo of MODULOS_VALIDOS) {
      const estadoModulo = modulosSet.has(modulo) ? 'pendiente' : 'no_configurado';
      await client.query(
        `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)`,
        [negocio.id, modulo, estadoModulo]
      );
    }

    // Métodos de pago por defecto (mismo criterio que el backfill de la
    // migración 025 para negocios ya existentes): efectivo/terminal
    // habilitados desde el día uno (funcionan sin ningún proveedor);
    // enlace_pago/transferencia deshabilitados hasta que el negocio
    // configure un proveedor real -- sin esto, cualquier negocio creado
    // DESPUÉS de esa migración quedaría con metodos_pago vacío y el
    // agente no podría ofrecer NINGUNA forma de pago (peor que el
    // incidente original, que al menos dejaba efectivo/terminal).
    const metodosBase = [
      ['efectivo', true, 0], ['terminal', true, 1], ['enlace_pago', false, 2], ['transferencia', false, 3],
    ];
    for (const [tipo, habilitado, orden] of metodosBase) {
      await client.query(
        `INSERT INTO metodos_pago (negocio_id, tipo, habilitado, orden) VALUES ($1,$2,$3,$4)`,
        [negocio.id, tipo, habilitado, orden]
      );
    }

    // Invitación inicial -- misma transacción: si algo falla después de este
    // punto, no debe quedar un usuario sin ninguna forma de activar su
    // cuenta. crearBy = superadminId (quien la emite).
    const invitacion = await crearInvitacionInterna(client, {
      usuarioId: usuario.id, negocioId: negocio.id, tipo: 'crear_password_inicial', createdBy: superadminId,
    });

    await registrarAuditoriaPlataforma({
      superadminId, accion: 'crear_negocio', negocioId: negocio.id, usuarioId: usuario.id,
      estadoAnterior: null,
      estadoNuevo: { nombre: negocio.nombre, slug: negocio.slug, estado: negocio.estado, plan: negocio.plan, adminEmail: emailNorm },
      contexto: { sucursal: sucursal.nombre, modulosIniciales: [...modulosSet] },
    }, client);

    await client.query('COMMIT');
    return {
      negocio, sucursal, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email }, checklist: checklistInicial,
      // token: solo en memoria de este retorno -- el llamador (la ruta HTTP)
      // lo pasa al servicio de correo y nunca lo devuelve al cliente ni lo
      // loguea. Ver services/email.js.
      invitacion: { token: invitacion.token, expiresAt: invitacion.expiresAt },
    };
  } catch (e) {
    await client.query('ROLLBACK');
    if (!e.code || (e.code !== 'SLUG_DUPLICADO' && e.code !== 'EMAIL_EXISTENTE' && e.code !== 'SLUG_INVALIDO')) {
      console.error('[DB] Error crearNegocioCompleto:', e.message);
    }
    throw e;
  } finally {
    client.release();
  }
}

// Interruptor global de bot de WhatsApp por negocio (migración 019) --
// independiente del estado técnico de cualquier integración. Regla
// real de si el bot responde (bot_whatsapp_activo Y NOT
// bot_pausado_cliente) vive en whatsapp-meta.js, no aquí -- estas
// funciones solo leen/escriben el interruptor global.
//
// Fail-closed: negocioId inválido o negocio inexistente -> false
// (nunca responde el bot por defecto ni por error de lectura).
export async function obtenerBotWhatsappActivoNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return false;
  try {
    const { rows } = await pool.query('SELECT bot_whatsapp_activo FROM negocios WHERE id = $1', [negocioId.trim()]);
    return rows[0]?.bot_whatsapp_activo === true;
  } catch (e) {
    console.error('[DB] Error obtenerBotWhatsappActivoNegocio:', e.message);
    return false;
  }
}

// actorUsuarioId: puede ser un superadmin o el administrador del propio
// negocio -- registrarAuditoriaPlataforma solo exige un usuario válido,
// no un rol específico (ver migración 011: la columna es superadmin_id
// mas la FK es genérica hacia usuarios).
export async function actualizarBotWhatsappActivoNegocio(negocioId, activo, actorUsuarioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  if (typeof activo !== 'boolean') throw Object.assign(new Error('activo debe ser boolean'), { code: 'VALOR_INVALIDO' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, nombre, bot_whatsapp_activo FROM negocios WHERE id = $1 FOR UPDATE', [negocioId.trim()]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const anterior = rows[0];
    await client.query('UPDATE negocios SET bot_whatsapp_activo = $2 WHERE id = $1', [negocioId.trim(), activo]);
    await registrarAuditoriaPlataforma({
      superadminId: actorUsuarioId, accion: 'cambiar_bot_whatsapp_activo_negocio', negocioId: negocioId.trim(),
      estadoAnterior: { bot_whatsapp_activo: anterior.bot_whatsapp_activo },
      estadoNuevo: { bot_whatsapp_activo: activo },
    }, client);
    await client.query('COMMIT');
    return { id: negocioId.trim(), botWhatsappActivo: activo };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Error actualizarBotWhatsappActivoNegocio:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

export async function actualizarEstadoNegocioSuperadmin(negocioId, nuevoEstado, superadminId) {
  if (!ESTADOS_NEGOCIO_VALIDOS.includes(nuevoEstado)) throw Object.assign(new Error('Estado inválido'), { code: 'ESTADO_INVALIDO' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, nombre, estado, activo FROM negocios WHERE id = $1 FOR UPDATE', [negocioId]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const anterior = rows[0];
    const nuevoActivo = nuevoEstado === 'activo'; // invariante: estado='activo' <=> activo=true (ver migración 011)
    await client.query('UPDATE negocios SET estado = $2, activo = $3 WHERE id = $1', [negocioId, nuevoEstado, nuevoActivo]);
    await registrarAuditoriaPlataforma({
      superadminId, accion: 'cambiar_estado_negocio', negocioId,
      estadoAnterior: { estado: anterior.estado, activo: anterior.activo },
      estadoNuevo: { estado: nuevoEstado, activo: nuevoActivo },
    }, client);
    await client.query('COMMIT');
    return { id: negocioId, estado: nuevoEstado, activo: nuevoActivo };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Error actualizarEstadoNegocioSuperadmin:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

export async function actualizarPlanNegocioSuperadmin(negocioId, nuevoPlan, superadminId) {
  if (!PLANES_VALIDOS.includes(nuevoPlan)) throw Object.assign(new Error('Plan inválido'), { code: 'PLAN_INVALIDO' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, plan FROM negocios WHERE id = $1 FOR UPDATE', [negocioId]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const anterior = rows[0];
    await client.query('UPDATE negocios SET plan = $2 WHERE id = $1', [negocioId, nuevoPlan]);
    await registrarAuditoriaPlataforma({
      superadminId, accion: 'cambiar_plan_negocio', negocioId,
      estadoAnterior: { plan: anterior.plan }, estadoNuevo: { plan: nuevoPlan },
    }, client);
    await client.query('COMMIT');
    return { id: negocioId, plan: nuevoPlan };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Error actualizarPlanNegocioSuperadmin:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// modulos: { [modulo]: estado } -- solo se tocan las claves presentes, el
// resto de módulos del negocio queda intacto.
export async function actualizarModulosNegocioSuperadmin(negocioId, modulos, superadminId) {
  const entradas = Object.entries(modulos || {});
  for (const [modulo, estado] of entradas) {
    if (!MODULOS_VALIDOS.includes(modulo)) throw Object.assign(new Error(`Módulo inválido: ${modulo}`), { code: 'MODULO_INVALIDO' });
    if (!ESTADOS_MODULO_VALIDOS.includes(estado)) throw Object.assign(new Error(`Estado de módulo inválido: ${estado}`), { code: 'ESTADO_MODULO_INVALIDO' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: negocioRows } = await client.query('SELECT id FROM negocios WHERE id = $1', [negocioId]);
    if (!negocioRows.length) { await client.query('ROLLBACK'); return null; }

    const { rows: anteriorRows } = await client.query('SELECT modulo, estado FROM negocio_modulos WHERE negocio_id = $1', [negocioId]);
    const anteriorMapa = Object.fromEntries(anteriorRows.map(r => [r.modulo, r.estado]));

    for (const [modulo, estado] of entradas) {
      await client.query(
        `INSERT INTO negocio_modulos (negocio_id, modulo, estado) VALUES ($1,$2,$3)
         ON CONFLICT (negocio_id, modulo) DO UPDATE SET estado = $3`,
        [negocioId, modulo, estado]
      );
    }

    await registrarAuditoriaPlataforma({
      superadminId, accion: 'cambiar_modulos_negocio', negocioId,
      estadoAnterior: entradas.reduce((acc, [m]) => ({ ...acc, [m]: anteriorMapa[m] ?? null }), {}),
      estadoNuevo: Object.fromEntries(entradas),
    }, client);

    await client.query('COMMIT');
    return { id: negocioId, modulos: Object.fromEntries(entradas) };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Error actualizarModulosNegocioSuperadmin:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

export async function actualizarChecklistNegocioSuperadmin(negocioId, cambiosChecklist, superadminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, checklist FROM negocios WHERE id = $1 FOR UPDATE', [negocioId]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const anterior = rows[0].checklist || {};
    const nuevo = { ...anterior, ...cambiosChecklist };
    await client.query('UPDATE negocios SET checklist = $2 WHERE id = $1', [negocioId, JSON.stringify(nuevo)]);
    await registrarAuditoriaPlataforma({
      superadminId, accion: 'cambiar_checklist_negocio', negocioId,
      estadoAnterior: anterior, estadoNuevo: nuevo,
    }, client);
    await client.query('COMMIT');
    return { id: negocioId, checklist: nuevo };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Error actualizarChecklistNegocioSuperadmin:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

export async function obtenerAuditoriaPlataforma({ limit = 50, offset = 0, negocioId = null } = {}) {
  const limitSeguro = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const offsetSeguro = Math.max(Number(offset) || 0, 0);
  const params = [];
  let where = '';
  if (negocioId) { params.push(negocioId); where = `WHERE a.negocio_id = $${params.length}`; }
  params.push(limitSeguro, offsetSeguro);
  const { rows } = await pool.query(`
    SELECT a.id, a.accion, a.negocio_id, n.nombre AS negocio_nombre, a.usuario_id, a.estado_anterior, a.estado_nuevo, a.contexto, a.created_at, u.nombre AS superadmin_nombre
    FROM auditoria_plataforma a
    JOIN usuarios u ON u.id = a.superadmin_id
    LEFT JOIN negocios n ON n.id = a.negocio_id
    ${where}
    ORDER BY a.created_at DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
  `, params);
  return rows;
}

// ─── Invitaciones de usuario (Fase 7) ───────────────────────────────────────
const INVITACION_DURACION_MS = 24 * 60 * 60 * 1000; // 24 horas

function hashToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

// Interna -- nunca exportada sola sin transacción alrededor. Revoca cualquier
// invitación vigente previa del mismo usuario antes de crear la nueva
// ("invalidarse al generar una nueva invitación"), genera un token de 32
// bytes (256 bits) y devuelve el token EN CRUDO solo para este retorno --
// nunca se guarda en ninguna tabla, solo su hash.
async function crearInvitacionInterna(client, { usuarioId, negocioId, tipo, createdBy }) {
  await client.query(
    `UPDATE invitaciones_usuario SET revoked_at = NOW()
     WHERE usuario_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
    [usuarioId]
  );
  const token = randomBytes(32).toString('base64url');
  const tokenHash = hashToken(token);
  const expiresAt = new Date(Date.now() + INVITACION_DURACION_MS);
  await client.query(
    `INSERT INTO invitaciones_usuario (usuario_id, negocio_id, tipo, token_hash, expires_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [usuarioId, negocioId, tipo, tokenHash, expiresAt, createdBy]
  );
  return { token, expiresAt };
}

// Reenvía la invitación para el administrador principal de un negocio.
// Resuelve el usuario internamente (el mismo criterio de "admin principal"
// que ya usa obtenerNegociosParaSuperadmin) -- la ruta HTTP nunca acepta un
// usuarioId del cliente para esto.
export async function reenviarInvitacion(negocioId, superadminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: negocioRows } = await client.query('SELECT id, nombre FROM negocios WHERE id = $1', [negocioId]);
    if (!negocioRows.length) { await client.query('ROLLBACK'); return null; }
    const negocio = negocioRows[0];

    const { rows: adminRows } = await client.query(
      `SELECT u.id, u.nombre, u.email FROM usuario_negocios un
       JOIN usuarios u ON u.id = un.usuario_id
       WHERE un.negocio_id = $1 AND un.rol = 'admin'
       ORDER BY un.created_at ASC LIMIT 1`,
      [negocioId]
    );
    if (!adminRows.length) {
      const err = new Error('Este negocio no tiene ningún administrador registrado'); err.code = 'SIN_ADMIN'; throw err;
    }
    const admin = adminRows[0];

    const invitacion = await crearInvitacionInterna(client, {
      usuarioId: admin.id, negocioId, tipo: 'crear_password_inicial', createdBy: superadminId,
    });

    await registrarAuditoriaPlataforma({
      superadminId, accion: 'reenviar_invitacion', negocioId, usuarioId: admin.id,
      estadoAnterior: null, estadoNuevo: null,
      contexto: { expiresAt: invitacion.expiresAt },
    }, client);

    await client.query('COMMIT');
    return {
      negocioNombre: negocio.nombre,
      usuario: { id: admin.id, nombre: admin.nombre, email: admin.email },
      token: invitacion.token, expiresAt: invitacion.expiresAt,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    if (e.code !== 'SIN_ADMIN') console.error('[DB] Error reenviarInvitacion:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// Pública indirectamente (vía GET /api/auth/invitacion/:token) -- solo
// lectura, nunca marca nada como usada. Devuelve un estado explícito en vez
// de true/false para que la página pueda mostrar el mensaje correcto sin
// adivinar la causa.
export async function validarInvitacion(token) {
  if (!token || typeof token !== 'string') return { estado: 'invalido' };
  const tokenHash = hashToken(token);
  const { rows } = await pool.query(
    `SELECT i.used_at, i.revoked_at, i.expires_at, n.nombre AS negocio_nombre, u.nombre AS usuario_nombre
     FROM invitaciones_usuario i
     JOIN negocios n ON n.id = i.negocio_id
     JOIN usuarios u ON u.id = i.usuario_id
     WHERE i.token_hash = $1`,
    [tokenHash]
  );
  if (!rows.length) return { estado: 'invalido' };
  const inv = rows[0];
  if (inv.used_at) return { estado: 'usado' };
  if (inv.revoked_at) return { estado: 'invalido' }; // no se distingue de "invalido" -- una revocada nunca debe reactivarse ni dar pistas
  if (new Date(inv.expires_at) < new Date()) return { estado: 'expirado' };
  // Primer nombre únicamente -- "nombre del usuario parcialmente necesario" (nunca el correo).
  const primerNombre = (inv.usuario_nombre || '').trim().split(/\s+/)[0] || '';
  return { estado: 'valido', negocioNombre: inv.negocio_nombre, nombreParcial: primerNombre };
}

// Consume la invitación y establece la contraseña. Todo en una transacción:
// si el hash o cualquier UPDATE falla, nada queda a medias -- la invitación
// sigue vigente y se puede reintentar. FOR UPDATE bloquea la fila para que
// dos solicitudes concurrentes con el mismo token nunca la consuman ambas
// (prueba de "creación concurrente no permite doble uso").
export async function crearPasswordDesdeInvitacion(token, password) {
  if (!token || typeof token !== 'string') { const e = new Error('Token inválido'); e.code = 'INVALIDO'; throw e; }
  const tokenHash = hashToken(token);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT i.id, i.usuario_id, i.negocio_id, i.used_at, i.revoked_at, i.expires_at, u.email
       FROM invitaciones_usuario i JOIN usuarios u ON u.id = i.usuario_id
       WHERE i.token_hash = $1 FOR UPDATE`,
      [tokenHash]
    );
    if (!rows.length) { const e = new Error('Invitación no encontrada'); e.code = 'INVALIDO'; throw e; }
    const inv = rows[0];
    if (inv.used_at) { const e = new Error('Esta invitación ya fue utilizada'); e.code = 'USADO'; throw e; }
    if (inv.revoked_at) { const e = new Error('Esta invitación ya no es válida'); e.code = 'INVALIDO'; throw e; }
    if (new Date(inv.expires_at) < new Date()) { const e = new Error('Esta invitación expiró'); e.code = 'EXPIRADO'; throw e; }
    if (typeof password !== 'string' || password.length < 8) {
      const e = new Error('La contraseña debe tener al menos 8 caracteres'); e.code = 'PASSWORD_INVALIDA'; throw e;
    }
    if (password.toLowerCase() === inv.email.toLowerCase()) {
      const e = new Error('La contraseña no puede ser igual a tu correo'); e.code = 'PASSWORD_INVALIDA'; throw e;
    }

    const hash = hashPassword(password);
    await client.query('UPDATE usuarios SET password_hash = $1, updated_at = NOW() WHERE id = $2', [hash, inv.usuario_id]);
    // Ya estaba activa por defecto desde la creación (ver crearNegocioCompleto),
    // pero se reafirma explícitamente aquí -- nunca se toca negocios.estado ni
    // negocios.activo: esa decisión (pasar de "pendiente" a "activo") sigue
    // siendo exclusiva del superadmin, no un efecto secundario de que el
    // administrador haya definido su contraseña.
    await client.query('UPDATE usuario_negocios SET activo = true WHERE usuario_id = $1 AND negocio_id = $2', [inv.usuario_id, inv.negocio_id]);
    await client.query('UPDATE invitaciones_usuario SET used_at = NOW() WHERE id = $1', [inv.id]);
    // Defensivo: cualquier OTRA invitación vigente del mismo usuario (no debería
    // existir ninguna, crearInvitacionInterna ya revoca al reenviar) queda revocada.
    await client.query(
      `UPDATE invitaciones_usuario SET revoked_at = NOW() WHERE usuario_id = $1 AND id != $2 AND used_at IS NULL AND revoked_at IS NULL`,
      [inv.usuario_id, inv.id]
    );

    await client.query('COMMIT');
    return { usuarioId: inv.usuario_id, negocioId: inv.negocio_id };
  } catch (e) {
    await client.query('ROLLBACK');
    if (!e.code) console.error('[DB] Error crearPasswordDesdeInvitacion:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ─── Prospectos comerciales (captura pública de leads) ─────────────────────
// Reemplaza el flujo anterior de la landing (mailto:) -- la base es la
// fuente de verdad del prospecto; el correo a hola@xabor.mx (ver
// src/services/email.js) es una notificación secundaria que puede fallar
// sin perder el registro. Sin FK a `negocios`: un prospecto todavía no es
// un negocio dado de alta.
export async function crearProspectoComercial({ nombre, negocio, ciudad, telefono, tipoNegocio, volumenMensajes, comentario, email, origen, ipHash, userAgentResumen }) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Doble clic / reenvío accidental: si ya existe un prospecto con el
    // mismo teléfono+negocio dentro de la ventana de deduplicación, se
    // reutiliza ese registro en vez de crear uno nuevo -- el endpoint
    // sigue respondiendo éxito (la persona no debe ver un error por algo
    // que no es su culpa), pero no se duplica la fila ni se reenvía el
    // correo de notificación.
    const { rows: existentes } = await client.query(
      `SELECT * FROM prospectos_comerciales
       WHERE telefono = $1 AND negocio = $2 AND created_at > NOW() - INTERVAL '10 minutes'
       ORDER BY created_at DESC LIMIT 1`,
      [telefono, negocio]
    );
    if (existentes[0]) {
      await client.query('COMMIT');
      return { creado: false, prospecto: existentes[0] };
    }

    const { rows } = await client.query(
      `INSERT INTO prospectos_comerciales
         (nombre, negocio, ciudad, telefono, tipo_negocio, volumen_mensajes, comentario, email, origen, ip_hash, user_agent_resumen)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [nombre, negocio, ciudad, telefono, tipoNegocio, volumenMensajes || null, comentario || null, email || null, origen || 'landing', ipHash || null, userAgentResumen || null]
    );
    await client.query('COMMIT');
    return { creado: true, prospecto: rows[0] };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Error crearProspectoComercial:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

export async function marcarCorreoProspectoEnviado(id, enviado) {
  await pool.query('UPDATE prospectos_comerciales SET correo_notificacion_enviado = $2 WHERE id = $1', [id, !!enviado]);
}

const FILTROS_PROSPECTOS_VALIDOS = ['nuevo','contactado','demo_agendada','seguimiento','convertido','descartado'];

export async function obtenerProspectosComerciales({ estado, ciudad, tipoNegocio, busqueda, limit = 100, offset = 0 } = {}) {
  const condiciones = [];
  const valores = [];
  if (estado && FILTROS_PROSPECTOS_VALIDOS.includes(estado)) {
    valores.push(estado);
    condiciones.push(`estado = $${valores.length}`);
  }
  if (ciudad && typeof ciudad === 'string' && ciudad.trim()) {
    valores.push(`%${ciudad.trim()}%`);
    condiciones.push(`ciudad ILIKE $${valores.length}`);
  }
  if (tipoNegocio && typeof tipoNegocio === 'string' && tipoNegocio.trim()) {
    valores.push(`%${tipoNegocio.trim()}%`);
    condiciones.push(`tipo_negocio ILIKE $${valores.length}`);
  }
  if (busqueda && typeof busqueda === 'string' && busqueda.trim()) {
    valores.push(`%${busqueda.trim()}%`);
    const i = valores.length;
    condiciones.push(`(nombre ILIKE $${i} OR negocio ILIKE $${i} OR telefono ILIKE $${i})`);
  }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const limiteSeguro = Math.min(Math.max(parseInt(limit, 10) || 100, 1), 200);
  const offsetSeguro = Math.max(parseInt(offset, 10) || 0, 0);
  valores.push(limiteSeguro, offsetSeguro);
  const { rows } = await pool.query(
    `SELECT id, nombre, negocio, ciudad, telefono, tipo_negocio, volumen_mensajes, estado, responsable, fecha_ultimo_seguimiento, correo_notificacion_enviado, created_at
     FROM prospectos_comerciales ${where}
     ORDER BY created_at DESC
     LIMIT $${valores.length - 1} OFFSET $${valores.length}`,
    valores
  );
  return rows;
}

export async function obtenerProspectoComercialPorId(id) {
  if (typeof id !== 'string' || !id.trim()) return null;
  const { rows } = await pool.query('SELECT * FROM prospectos_comerciales WHERE id = $1', [id.trim()]);
  return rows[0] || null;
}

const CAMPOS_ACTUALIZABLES_PROSPECTO = ['estado', 'responsable', 'notas_internas', 'fecha_ultimo_seguimiento'];

export async function actualizarProspectoComercial(id, cambios, superadminId) {
  if (typeof id !== 'string' || !id.trim()) return null;
  if (cambios.estado !== undefined && !FILTROS_PROSPECTOS_VALIDOS.includes(cambios.estado)) {
    const err = new Error('estado de prospecto inválido'); err.code = 'ESTADO_INVALIDO'; throw err;
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: existente } = await client.query('SELECT * FROM prospectos_comerciales WHERE id = $1 FOR UPDATE', [id]);
    if (!existente[0]) { await client.query('ROLLBACK'); return null; }
    const anterior = existente[0];
    const claves = Object.keys(cambios).filter(k => CAMPOS_ACTUALIZABLES_PROSPECTO.includes(k));
    if (!claves.length) { await client.query('ROLLBACK'); return anterior; }
    const sets = claves.map((k, i) => `${k} = $${i + 2}`).join(', ');
    const valores = claves.map(k => cambios[k]);
    const { rows } = await client.query(
      `UPDATE prospectos_comerciales SET ${sets}, updated_at = NOW() WHERE id = $1 RETURNING *`,
      [id, ...valores]
    );
    await registrarAuditoriaPlataforma({
      superadminId, accion: 'actualizar_prospecto_comercial', negocioId: null,
      estadoAnterior: { estado: anterior.estado, responsable: anterior.responsable },
      estadoNuevo: { estado: rows[0].estado, responsable: rows[0].responsable },
      contexto: { prospectoId: id },
    }, client);
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    if (!e.code) console.error('[DB] Error actualizarProspectoComercial:', e.message);
    throw e;
  } finally {
    client.release();
  }
}
