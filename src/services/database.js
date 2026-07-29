import pkg from 'pg';
import { createHmac, randomBytes } from 'crypto';
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
    INSERT INTO rewards_config (tenant_id) VALUES ('xabor-principal') ON CONFLICT DO NOTHING;

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
  const { categoria_id, nombre, descripcion, precio, disponible, opciones } = datos;

  // negocio_id se deriva de la categoría padre — nunca se acepta suelto desde datos
  const { rows: catRows } = await pool.query('SELECT negocio_id FROM menu_categorias WHERE id=$1', [categoria_id]);
  if (!catRows[0]) {
    throw new Error('crearProducto: categoría no encontrada');
  }
  if (catRows[0].negocio_id !== negId) {
    throw new Error('crearProducto: la categoría no pertenece al negocio actual');
  }

  const { rows } = await pool.query(
    `INSERT INTO menu_productos (negocio_id, categoria_id, nombre, descripcion, precio, disponible, opciones, orden)
     VALUES ($1,$2,$3,$4,$5,$6,$7,(SELECT COALESCE(MAX(orden)+1,0) FROM menu_productos WHERE categoria_id=$2))
     RETURNING *`,
    [negId, categoria_id, nombre, descripcion||'', precio, disponible!==false, opciones ? JSON.stringify(opciones) : null]
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
  if (!sets.length) return;
  vals.push(id, negId);
  await pool.query(`UPDATE menu_productos SET ${sets.join(',')} WHERE id=$${vals.length-1} AND negocio_id=$${vals.length}`, vals);
}

export async function eliminarProducto(id, negocioId) {
  const negId = negocioId || await resolverNegocioActualId();
  await pool.query('DELETE FROM menu_productos WHERE id=$1 AND negocio_id=$2', [id, negId]);
}

// ─── Push Notifications ───────────────────────────────────────────────────────
export async function guardarSuscripcionPush({ endpoint, auth, p256dh }) {
  await pool.query(
    `INSERT INTO push_subscriptions (endpoint, auth, p256dh)
     VALUES ($1, $2, $3)
     ON CONFLICT (endpoint) DO UPDATE SET auth=$2, p256dh=$3`,
    [endpoint, auth, p256dh]
  );
}

export async function obtenerSuscripcionesPush() {
  const { rows } = await pool.query('SELECT endpoint, auth, p256dh FROM push_subscriptions');
  return rows;
}

export async function eliminarSuscripcionPush(endpoint) {
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint=$1', [endpoint]);
}

// ─── Obtener cliente por teléfono ─────────────────────────────────────────────
export async function obtenerCliente(telefono) {
  try {
    const result = await pool.query(
      'SELECT * FROM clientes WHERE telefono = $1',
      [telefono]
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
export async function setBotPausado(telefono, pausado) {
  try {
    await pool.query(`
      INSERT INTO clientes (telefono, bot_pausado)
      VALUES ($1, $2)
      ON CONFLICT (telefono) DO UPDATE SET bot_pausado = $2
    `, [telefono, pausado]);
  } catch (e) {
    console.error('[DB] Error setBotPausado:', e.message);
  }
}

export async function toggleClienteInterno(telefono, esInterno) {
  await pool.query(
    'UPDATE clientes SET es_interno = $1 WHERE telefono = $2',
    [esInterno, telefono]
  );
}

export async function getBotPausado(telefono) {
  try {
    const result = await pool.query(
      'SELECT bot_pausado FROM clientes WHERE telefono = $1',
      [telefono]
    );
    return result.rows[0]?.bot_pausado || false;
  } catch (e) {
    console.error('[DB] Error getBotPausado:', e.message);
    return false;
  }
}

// ─── Link de pago pendiente (pedidos por voz) ────────────────────────────────
export async function setPagoPendiente(telefono, pedidoId) {
  try {
    await pool.query(`
      INSERT INTO clientes (telefono, pedido_pago_pendiente)
      VALUES ($1, $2)
      ON CONFLICT (telefono) DO UPDATE SET pedido_pago_pendiente = $2
    `, [telefono, pedidoId]);
  } catch (e) {
    console.error('[DB] Error setPagoPendiente:', e.message);
  }
}

export async function getPagoPendiente(telefono) {
  try {
    const result = await pool.query(
      'SELECT pedido_pago_pendiente FROM clientes WHERE telefono = $1',
      [telefono]
    );
    return result.rows[0]?.pedido_pago_pendiente || null;
  } catch (e) {
    console.error('[DB] Error getPagoPendiente:', e.message);
    return null;
  }
}

export async function clearPagoPendiente(telefono) {
  try {
    await pool.query(
      'UPDATE clientes SET pedido_pago_pendiente = NULL WHERE telefono = $1',
      [telefono]
    );
  } catch (e) {
    console.error('[DB] Error clearPagoPendiente:', e.message);
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
export async function cancelarPedidoActivo(folio, motivo) {
  try {
    await pool.query(`
      UPDATE pedidos_activos
      SET estado = 'cancelado',
          datos  = jsonb_set(datos, '{cancelacion}', $2::jsonb),
          updated_at = NOW()
      WHERE folio = $1 AND estado NOT IN ('entregado', 'cancelado')
    `, [folio, JSON.stringify({ motivo, timestamp: new Date().toISOString() })]);
    return true;
  } catch (e) {
    console.error('[DB] Error cancelarPedidoActivo:', e.message);
    return false;
  }
}

// ─── Registrar devolución en pedido entregado ─────────────────────────────────
export async function registrarDevolucion(folio, monto, motivo) {
  try {
    await pool.query(`
      UPDATE pedidos_activos
      SET datos = jsonb_set(datos, '{devolucion}', $2::jsonb),
          updated_at = NOW()
      WHERE folio = $1 AND estado = 'entregado'
    `, [folio, JSON.stringify({ monto: parseFloat(monto), motivo, timestamp: new Date().toISOString() })]);
    return true;
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

export async function actualizarFormaPago(folio, formaPago) {
  try {
    await pool.query(`
      UPDATE pedidos_activos
      SET datos = jsonb_set(datos, '{forma_pago}', $2::jsonb), updated_at = NOW()
      WHERE folio = $1
    `, [folio, JSON.stringify(formaPago)]);
    return true;
  } catch (e) {
    console.error('[DB] Error actualizarFormaPago:', e.message);
    return false;
  }
}

// ─── Mensajes WhatsApp ───────────────────────────────────────────────────────
export async function guardarMensaje(telefono, nombre, direccion, texto) {
  try {
    const result = await pool.query(`
      INSERT INTO mensajes (telefono, nombre, direccion, texto)
      VALUES ($1, $2, $3, $4) RETURNING *
    `, [telefono, nombre || null, direccion, texto]);
    return result.rows[0];
  } catch (e) {
    console.error('[DB] Error guardarMensaje:', e.message);
    return null;
  }
}

export async function obtenerConversacion(telefono) {
  try {
    const result = await pool.query(`
      SELECT * FROM mensajes WHERE telefono = $1
      ORDER BY timestamp ASC
    `, [telefono]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerConversacion:', e.message);
    return [];
  }
}

export async function obtenerConversacionesRecientes(limite = 20) {
  try {
    const result = await pool.query(`
      SELECT
        t.telefono,
        (SELECT nombre FROM mensajes WHERE telefono = t.telefono AND nombre IS NOT NULL ORDER BY timestamp DESC LIMIT 1) AS nombre,
        t.texto,
        t.direccion,
        t.timestamp
      FROM (
        SELECT DISTINCT ON (telefono) telefono, texto, direccion, timestamp
        FROM mensajes
        ORDER BY telefono, timestamp DESC
      ) t
      ORDER BY t.timestamp DESC
      LIMIT $1
    `, [limite]);
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
      SELECT datos FROM pedidos_activos
      WHERE estado != 'entregado'
      ORDER BY created_at ASC
    `);
    return result.rows.map(r => r.datos);
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

// Guarda el Clip payment_request_id en el pedido para reconciliación
export async function guardarLinkPago(folio, clipLinkId) {
  try {
    await pool.query(`
      UPDATE pedidos_activos
      SET datos = datos || $2::jsonb, updated_at = NOW()
      WHERE folio = $1
    `, [folio, JSON.stringify({ clip_link_id: clipLinkId })]);
  } catch (e) {
    console.error('[DB] Error guardarLinkPago:', e.message);
  }
}

// Devuelve pedidos con pago pendiente que tienen un clip_link_id guardado
export async function obtenerPagosPendientesConLink() {
  try {
    const result = await pool.query(`
      SELECT folio, datos->>'clip_link_id' AS clip_link_id
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

export async function confirmarPagoPedido(folio) {
  try {
    await pool.query(`
      UPDATE pedidos_activos
      SET datos = datos || '{"pago_confirmado": true}', updated_at = NOW()
      WHERE folio = $1
    `, [folio]);
  } catch (e) {
    console.error('[DB] Error confirmarPagoPedido:', e.message);
  }
}

export async function obtenerPedidoActivoPorFolio(folio) {
  try {
    const result = await pool.query(
      `SELECT datos FROM pedidos_activos WHERE folio = $1 AND estado != 'entregado'`,
      [folio]
    );
    return result.rows[0]?.datos || null;
  } catch (e) {
    console.error('[DB] Error obtenerPedidoActivoPorFolio:', e.message);
    return null;
  }
}

// Busca en activos Y en programados — útil para enlace de pago anticipado
export async function obtenerPedidoPorFolioAmplio(folio) {
  try {
    // Primero en activos
    const activo = await pool.query(
      `SELECT datos, 'activo' AS origen FROM pedidos_activos WHERE folio = $1 AND estado != 'entregado'`,
      [folio]
    );
    if (activo.rows[0]) return { ...activo.rows[0].datos, _origen: 'activo' };

    // Si no, en programados
    const prog = await pool.query(
      `SELECT datos, programado_para FROM pedidos_programados WHERE folio = $1 AND activado = FALSE`,
      [folio]
    );
    if (prog.rows[0]) return { ...prog.rows[0].datos, _origen: 'programado', programado_para: prog.rows[0].programado_para };

    return null;
  } catch (e) {
    console.error('[DB] Error obtenerPedidoPorFolioAmplio:', e.message);
    return null;
  }
}

// Busca pedidos activos por número de teléfono del cliente
export async function obtenerPedidosActivosPorTelefono(telefono) {
  try {
    const result = await pool.query(
      `SELECT folio, estado, datos, created_at
       FROM pedidos_activos
       WHERE datos->'cliente'->>'telefono' = $1
         AND estado NOT IN ('entregado', 'cancelado')
       ORDER BY created_at DESC
       LIMIT 3`,
      [telefono]
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
      SELECT folio, datos, programado_para FROM pedidos_programados
      WHERE activado = FALSE
        AND programado_para <= NOW() + INTERVAL '1 hour'
      ORDER BY programado_para ASC
    `);
    return result.rows;
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

export async function obtenerPedidosProgramadosPendientes() {
  try {
    const result = await pool.query(`
      SELECT folio, datos, programado_para FROM pedidos_programados
      WHERE activado = FALSE
      ORDER BY programado_para ASC
    `);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerPedidosProgramadosPendientes:', e.message);
    return [];
  }
}

// Último pedido entregado de un teléfono — para generarle factura
export async function obtenerUltimoPedidoEntregadoPorTelefono(telefono) {
  try {
    const result = await pool.query(
      `SELECT folio, datos FROM pedidos_activos
       WHERE datos->'cliente'->>'telefono' = $1
         AND estado = 'entregado'
       ORDER BY updated_at DESC
       LIMIT 1`,
      [telefono]
    );
    if (!result.rows[0]) return null;
    return { folio: result.rows[0].folio, ...result.rows[0].datos };
  } catch (e) {
    console.error('[DB] Error obtenerUltimoPedidoEntregadoPorTelefono:', e.message);
    return null;
  }
}

// ─── Transcripciones de voz ───────────────────────────────────────────────────
export async function guardarTranscripcionVoz(callSid, fromNum, rol, texto) {
  try {
    await pool.query(`
      INSERT INTO transcripciones_voz (call_sid, from_num, rol, texto)
      VALUES ($1, $2, $3, $4)
    `, [callSid, fromNum || null, rol, texto]);
  } catch (e) {
    console.error('[DB] Error guardarTranscripcionVoz:', e.message);
  }
}

export async function obtenerTranscripcionPorLlamada(callSid) {
  try {
    const result = await pool.query(`
      SELECT rol, texto, created_at FROM transcripciones_voz
      WHERE call_sid = $1
      ORDER BY created_at ASC
    `, [callSid]);
    return result.rows;
  } catch (e) {
    console.error('[DB] Error obtenerTranscripcionPorLlamada:', e.message);
    return [];
  }
}

export async function obtenerLlamadasRecientes(limite = 20) {
  try {
    const result = await pool.query(`
      SELECT DISTINCT ON (call_sid)
        call_sid, from_num,
        MIN(created_at) OVER (PARTITION BY call_sid) AS inicio,
        MAX(created_at) OVER (PARTITION BY call_sid) AS fin,
        COUNT(*) OVER (PARTITION BY call_sid) AS num_mensajes
      FROM transcripciones_voz
      ORDER BY call_sid, created_at DESC
      LIMIT $1
    `, [limite]);
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

export async function guardarOverride(seccion, contenido) {
  try {
    // Desactivar overrides anteriores de la misma sección
    await pool.query(`UPDATE prompt_overrides SET activo = FALSE WHERE seccion = $1`, [seccion]);
    await pool.query(`
      INSERT INTO prompt_overrides (seccion, contenido) VALUES ($1, $2)
    `, [seccion, contenido]);
  } catch (e) {
    console.error('[DB] Error guardarOverride:', e.message);
  }
}

export async function obtenerOverridesActivos() {
  try {
    const result = await pool.query(`
      SELECT seccion, contenido FROM prompt_overrides WHERE activo = TRUE
    `);
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
export async function obtenerUltimosPedidos(telefono, limite = 3) {
  try {
    const result = await pool.query(`
      SELECT items, total, modalidad, created_at
      FROM pedidos
      WHERE telefono = $1
      ORDER BY created_at DESC
      LIMIT $2
    `, [telefono, limite]);
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
export async function obtenerMembresiaUsuarioNegocio(usuarioId, negocioId) {
  try {
    const { rows } = await pool.query(
      `SELECT rol, activo FROM usuario_negocios WHERE usuario_id = $1 AND negocio_id = $2`,
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

// ─── Repartidores ─────────────────────────────────────────────────────────────
// Normaliza teléfonos mexicanos a formato local 10 dígitos (sin prefijo 52/521)
function normalizarTelefono(tel) {
  tel = String(tel).replace(/\D/g, ''); // solo dígitos
  if (tel.startsWith('521') && tel.length === 13) return tel.slice(3); // 521XXXXXXXXXX → XXXXXXXXXX
  if (tel.startsWith('52') && tel.length === 12) return tel.slice(2);  // 52XXXXXXXXXX → XXXXXXXXXX
  return tel;
}

export async function registrarRepartidor(nombre, telefono) {
  const token = randomBytes(16).toString('hex');
  const telNorm = normalizarTelefono(telefono);
  try {
    const result = await pool.query(
      `INSERT INTO repartidores (nombre, telefono, token)
       VALUES ($1, $2, $3)
       ON CONFLICT (telefono) DO UPDATE SET nombre = $1, activo = TRUE
       RETURNING *`,
      [nombre, telNorm, token]
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

export async function obtenerRepartidorPorTelefono(telefono) {
  try {
    const telNorm = normalizarTelefono(telefono);
    const r = await pool.query('SELECT * FROM repartidores WHERE telefono = $1', [telNorm]);
    return r.rows[0] || null;
  } catch (e) { return null; }
}

export async function obtenerRepartidores() {
  try {
    const r = await pool.query(`
      SELECT r.*,
        COALESCE((
          SELECT COUNT(*) FROM pedidos_activos
          WHERE datos->>'repartidor_id' = r.id::text
            AND estado = 'entregado'
        ), 0)::int AS pedidos_entregados
      FROM repartidores r
      ORDER BY r.activo DESC, r.nombre ASC
    `);
    return r.rows;
  } catch (e) { return []; }
}

export async function guardarPushRepartidor(repartidorId, subscription) {
  try {
    await pool.query(
      `INSERT INTO push_subscriptions_repartidor (repartidor_id, endpoint, auth, p256dh)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (endpoint) DO UPDATE SET auth = $3, p256dh = $4`,
      [repartidorId, subscription.endpoint, subscription.keys.auth, subscription.keys.p256dh]
    );
  } catch (e) { console.error('[DB] Error guardarPushRepartidor:', e.message); }
}

export async function obtenerPushRepartidores() {
  try {
    const r = await pool.query(
      `SELECT p.endpoint, p.auth, p.p256dh
       FROM push_subscriptions_repartidor p
       JOIN repartidores rep ON rep.id = p.repartidor_id
       WHERE rep.activo = TRUE`
    );
    return r.rows.map(r => ({ endpoint: r.endpoint, keys: { auth: r.auth, p256dh: r.p256dh } }));
  } catch (e) { return []; }
}

export async function asignarRepartidor(folio, repartidorId, nombreRepartidor) {
  try {
    // Asignación atómica — solo si aún no tiene repartidor
    const result = await pool.query(
      `UPDATE pedidos_activos
       SET datos = jsonb_set(jsonb_set(datos, '{repartidor_id}', $2::jsonb), '{repartidor_nombre}', $3::jsonb),
           updated_at = NOW()
       WHERE folio = $1
         AND (datos->>'repartidor_id') IS NULL
         AND estado NOT IN ('entregado','cancelado')
       RETURNING folio`,
      [folio, JSON.stringify(repartidorId), JSON.stringify(nombreRepartidor)]
    );
    return result.rows.length > 0; // true = asignado, false = ya lo tomó otro
  } catch (e) {
    console.error('[DB] Error asignarRepartidor:', e.message);
    return false;
  }
}

export async function obtenerPedidosParaRepartidor() {
  try {
    const r = await pool.query(
      `SELECT folio, datos, estado FROM pedidos_activos
       WHERE estado IN ('nuevo','en_preparacion','listo')
         AND datos->>'modalidad' = 'entrega a domicilio'
         AND (datos->>'repartidor_id') IS NULL
       ORDER BY created_at ASC`
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

export async function eliminarRepartidor(id) {
  try {
    await pool.query('DELETE FROM repartidores WHERE id = $1', [id]);
    return true;
  } catch(e) { return false; }
}

export async function obtenerCandidatosRepartidor() {
  try {
    const r = await pool.query(`
      SELECT DISTINCT ON (telefono) telefono, nombre, texto, timestamp
      FROM mensajes
      WHERE LOWER(texto) LIKE '%repartidor%'
        AND direccion = 'entrante'
        AND timestamp > NOW() - INTERVAL '72 hours'
      ORDER BY telefono, timestamp DESC
    `);
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

export async function obtenerDestinatariosCampana(segmento) {
  // Segmentos Rewards — clientes con N+ puntos de saldo activo
  if (segmento?.startsWith('rewards_')) {
    const minPts = parseInt(segmento.replace('rewards_', '')) || 0;
    const { rows } = await pool.query(`
      SELECT c.telefono, c.nombre
      FROM clientes c
      JOIN rewards_accounts a ON a.telefono = c.telefono AND a.tenant_id = 'xabor-principal'
      LEFT JOIN repartidores r ON r.telefono = c.telefono
      WHERE c.telefono != '—'
        AND c.telefono NOT LIKE 'rappi-%'
        AND r.telefono IS NULL
        AND NOT COALESCE(c.es_interno, FALSE)
        AND a.puntos_balance >= $1
      ORDER BY a.puntos_balance DESC
    `, [minPts]);
    return rows;
  }

  // Segmentos CRM estándar
  const segFiltro = segmento === 'todos'
    ? ''
    : `AND COALESCE(p.segmento, 'nuevo') = '${segmento}'`;

  const { rows } = await pool.query(`
    SELECT c.telefono, c.nombre
    FROM clientes c
    LEFT JOIN perfiles_clientes p ON p.telefono = c.telefono
    LEFT JOIN repartidores r ON r.telefono = c.telefono
    WHERE c.telefono != '—'
      AND c.telefono NOT LIKE 'rappi-%'
      AND r.telefono IS NULL
      AND NOT COALESCE(c.es_interno, FALSE)
      ${segFiltro}
    ORDER BY COALESCE(p.total_gastado, 0) DESC
  `);
  return rows;
}
