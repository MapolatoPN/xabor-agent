import pkg from 'pg';
import { createHmac, createHash, randomBytes } from 'crypto';
import { hashPassword, hashPin, verifyPin, pinValido } from './password.js';
import { normalizarTelefonoMX } from '../utils/telefono.js';
import { esPedidoDeRedExterna } from '../utils/elegibilidadRepartidor.js';
const { Pool } = pkg;

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  // Igual al default de pg (10). Configurable solo para poder REPRODUCIR en
  // pruebas la saturación del pool con pocas peticiones.
  max: Number(process.env.XABOR_PG_POOL_MAX) || 10,
});

// ─── Pool APARTE para los claims con lock ────────────────────────────────────
//
// Hay un patrón que sí puede provocar un interbloqueo por agotamiento del pool:
// tomar una conexión, dejarla ocupada con un lock, y DENTRO de ese lock pedir
// otra conexión del MISMO pool. Con N peticiones simultáneas iguales al tamaño
// del pool, las N retienen todas las conexiones y las N esperan una más que
// nunca se va a liberar. Y como el pool principal no tiene timeout, eso no es
// lentitud: es un cuelgue permanente.
//
// Es exactamente la forma del claim de derivaciones de la tienda: el lock se
// sostiene mientras corre el efecto (emitir comanda, avisar al panel), y ese
// efecto necesita conexiones para trabajar.
//
// El lock TIENE que sostenerse durante el efecto: es la señal de vida. Si el
// proceso muere, la conexión muere, el lock se suelta, y el siguiente reintento
// sabe que puede retomar sin necesidad de inventar un "lease" con relojes.
// Soltar el lock antes del efecto obligaría a esa complejidad.
//
// La salida es separar los pools: las conexiones de claim nunca compiten con
// las de trabajo. Quien sostiene una conexión de claim jamás pide otra de claim,
// así que esperar aquí siempre termina -- a lo sumo tras el claim más lento en
// curso. Y con connectionTimeoutMillis, una saturación se convierte en un error
// explícito, nunca en una espera infinita.
//
// Se crea perezosamente: un proceso que no toca la tienda no abre ni una
// conexión de más.
let _poolClaims = null;
export function poolDeClaims() {
  if (!_poolClaims) {
    _poolClaims = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
      max: Number(process.env.XABOR_PG_POOL_CLAIMS_MAX) || 8,
      connectionTimeoutMillis: Number(process.env.XABOR_PG_POOL_CLAIMS_TIMEOUT_MS) || 20000,
    });
  }
  return _poolClaims;
}

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

// ─── Takeover humano temporal (WhatsApp Coexistence, migración 049) ──────────
// Cuando el dueño responde desde SU WhatsApp Business App (webhook
// smb_message_echoes), el bot se calla para ESA conversación durante un
// plazo. Mecanismo deliberadamente SEPARADO de bot_pausado: estas funciones
// solo escriben human_takeover_until / last_business_app_message_at y JAMÁS
// tocan bot_pausado — así el vencimiento automático nunca puede des-pausar
// una conversación pausada a mano desde el panel. Mismos guards de dueño
// que setBotPausado (Incidente P0): sin negocioId no se escribe, y el
// ON CONFLICT es no-op si el teléfono pertenece a otro negocio.
export async function activarTakeoverHumano(telefono, negocioId, minutos) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] activarTakeoverHumano: negocioId inválido u omitido — rechazado');
    return false;
  }
  const mins = Number(minutos);
  if (!Number.isFinite(mins) || mins <= 0) {
    console.warn('[DB] activarTakeoverHumano: minutos inválidos — rechazado');
    return false;
  }
  try {
    const incluirNull = await _esNonnaMaye(negocioId);
    const { rowCount } = await pool.query(`
      INSERT INTO clientes (telefono, negocio_id, human_takeover_until, last_business_app_message_at)
      VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, NOW())
      ON CONFLICT (telefono) DO UPDATE SET
        human_takeover_until = NOW() + ($3 || ' minutes')::interval,
        last_business_app_message_at = NOW()
        WHERE clientes.negocio_id = $2 OR ($4::boolean AND clientes.negocio_id IS NULL)
    `, [telefono, negocioId.trim(), String(mins), incluirNull]);
    return rowCount > 0;
  } catch (e) {
    console.error('[DB] Error activarTakeoverHumano:', e.message);
    return false;
  }
}

// false = sin takeover vigente (el bot puede actuar). Fail closed hacia el
// comportamiento actual: ante negocioId inválido o error de consulta se
// devuelve false, igual que getBotPausado.
export async function getTakeoverHumanoActivo(telefono, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] getTakeoverHumanoActivo: negocioId inválido u omitido — rechazado (fail closed)');
    return false;
  }
  try {
    const incluirNull = await _esNonnaMaye(negocioId);
    const result = await pool.query(
      `SELECT (human_takeover_until IS NOT NULL AND human_takeover_until > NOW()) AS vigente
       FROM clientes WHERE telefono = $1 AND (negocio_id = $2 OR ($3::boolean AND negocio_id IS NULL))`,
      [telefono, negocioId.trim(), incluirNull]
    );
    return result.rows[0]?.vigente || false;
  } catch (e) {
    console.error('[DB] Error getTakeoverHumanoActivo:', e.message);
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
        COALESCE((datos->>'pago_confirmado')::boolean, false)              AS pago_confirmado,
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
    // Reingeniería UX: OPERACIÓN GENERADA ≠ INGRESO COBRADO. Un pedido
    // abierto (forma_pago='por_cobrar' sin pago_confirmado) cuenta como
    // operación (num_pedidos) pero NO suma a total_ventas/promedio/envíos
    // hasta que se cobre; se reporta aparte en por_cobrar_num/por_cobrar_total.
    // 'cobrado' cubre también todos los canales previos (forma_pago real
    // desde la creación), así que los números históricos no cambian.
    const result = await pool.query(`
      SELECT
        COUNT(*)::int                                                                              AS num_pedidos,
        COALESCE(SUM((datos->>'total')::decimal) FILTER (WHERE NOT (
          datos->>'forma_pago' = 'por_cobrar' AND (datos->>'pago_confirmado')::boolean IS NOT TRUE
        )), 0)::float                                                                              AS total_ventas,
        COALESCE(SUM(COALESCE((datos->'devolucion'->>'monto')::decimal, 0)), 0)::float            AS total_devoluciones,
        COALESCE(AVG((datos->>'total')::decimal) FILTER (WHERE NOT (
          datos->>'forma_pago' = 'por_cobrar' AND (datos->>'pago_confirmado')::boolean IS NOT TRUE
        )), 0)::float                                                                              AS promedio,
        COALESCE(SUM((datos->>'costo_envio')::decimal) FILTER (WHERE NOT (
          datos->>'forma_pago' = 'por_cobrar' AND (datos->>'pago_confirmado')::boolean IS NOT TRUE
        )), 0)::float                                                                              AS total_envios,
        COUNT(*) FILTER (WHERE
          datos->>'forma_pago' = 'por_cobrar' AND (datos->>'pago_confirmado')::boolean IS NOT TRUE
        )::int                                                                                     AS por_cobrar_num,
        COALESCE(SUM((datos->>'total')::decimal) FILTER (WHERE
          datos->>'forma_pago' = 'por_cobrar' AND (datos->>'pago_confirmado')::boolean IS NOT TRUE
        ), 0)::float                                                                               AS por_cobrar_total,
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

// ─── Cobro de pedido abierto (reingeniería UX: captura ≠ cobro) ─────────────
// Lectura previa al cobro: datos + estado SIN filtrar entregados (un pedido
// puede cobrarse después de marcado entregado). negocioId OBLIGATORIO.
export async function obtenerPedidoActivoParaCobro(folio, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerPedidoActivoParaCobro: negocioId inválido u omitido — rechazado');
    return null;
  }
  try {
    const { rows } = await pool.query(
      `SELECT datos, estado FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2`,
      [folio, negocioId.trim()]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerPedidoActivoParaCobro:', e.message);
    return null;
  }
}

// Cobro transaccional e idempotente. FOR UPDATE + re-verificación DENTRO de
// la transacción: dos cobros concurrentes (doble click) producen UN solo
// cobro — el segundo ve pago_confirmado=true y recibe yaCobrado con los
// datos existentes, sin re-contabilizar ni pisar nada. La fila operativa
// (pedidos_activos, la que leen corte/ventas/historial) la persiste
// registrarPedido de forma síncrona al crear, así que aquí nunca se cobra
// una fila inexistente. negocioId OBLIGATORIO — falla cerrado.
export async function cobrarPedidoActivo(folio, negocioId, campos) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] cobrarPedidoActivo: negocioId inválido u omitido — rechazado');
    return { error: 'negocio_invalido' };
  }
  const nid = negocioId.trim();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT datos, estado FROM pedidos_activos WHERE folio = $1 AND negocio_id = $2 FOR UPDATE`,
      [folio, nid]
    );
    if (!rows.length) { await client.query('ROLLBACK'); return { error: 'no_encontrado' }; }
    const { datos, estado } = rows[0];
    if (estado === 'cancelado') { await client.query('ROLLBACK'); return { error: 'cancelado' }; }
    if (datos && datos.pago_confirmado === true) {
      await client.query('COMMIT');
      return { yaCobrado: true, datos };
    }
    const { rows: [act] } = await client.query(
      `UPDATE pedidos_activos SET datos = datos || $3::jsonb, updated_at = NOW()
       WHERE folio = $1 AND negocio_id = $2 RETURNING datos`,
      [folio, nid, JSON.stringify(campos)]
    );
    await client.query('COMMIT');
    // Espejo best-effort en el archivo `pedidos` (la creación presencial lo
    // persiste awaited antes de responder; si un canal viejo no tuviera la
    // fila, el cobro operativo NO se pierde: la fuente de verdad es
    // pedidos_activos).
    pool.query(
      `UPDATE pedidos SET forma_pago = $2, total = $3 WHERE folio = $1 AND negocio_id = $4`,
      [folio, campos.forma_pago, campos.total, nid]
    ).catch((e) => console.error('[DB] cobro: espejo en pedidos falló:', e.message));
    return { ok: true, datos: act.datos };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('[DB] Error cobrarPedidoActivo:', e.message);
    return { error: 'interno' };
  } finally {
    client.release();
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

// ANTI-LOOP de Coexistence: un echo (smb_message_echoes) cuyo wamid ya está
// en mensajes es un mensaje que XABOR mismo envió por Cloud API (o un
// webhook reentregado) -- no es intervención humana y no debe activar el
// takeover. El índice UNIQUE parcial de message_id_externo hace esta
// consulta O(1). Ante error se devuelve true (fail closed: mejor no
// activar un takeover de más que silenciar al bot tras cada respuesta).
export async function existeMensajeConIdExterno(messageIdExterno) {
  if (!messageIdExterno) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM mensajes WHERE message_id_externo = $1 LIMIT 1`, [messageIdExterno]);
    return rows.length > 0;
  } catch (e) {
    console.error('[DB] Error existeMensajeConIdExterno:', e.message);
    return true;
  }
}

// Importación del historial de la Business App (webhook `history`,
// Coexistence): igual que guardarMensaje pero con tipo 'texto_historico'
// (migración 049) y el timestamp REAL del mensaje original -- así el chat
// del panel muestra la conversación en su orden verdadero y nada del
// pipeline en vivo (brain, debounce, notificaciones) lo confunde con
// tráfico nuevo. Idempotente por message_id_externo, igual que el webhook
// normal.
export async function importarMensajeHistorico(telefono, nombre, direccion, texto, negocioId, origen, messageIdExterno, fecha) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] importarMensajeHistorico: negocioId inválido u omitido — rechazado');
    return null;
  }
  if (!messageIdExterno) return null; // sin wamid no hay idempotencia posible
  try {
    const { rows } = await pool.query(`
      INSERT INTO mensajes (telefono, nombre, direccion, texto, negocio_id, origen, message_id_externo, tipo, "timestamp")
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'texto_historico', COALESCE($8::timestamptz, NOW()))
      ON CONFLICT (message_id_externo) WHERE message_id_externo IS NOT NULL DO NOTHING
      RETURNING *
    `, [telefono, nombre || null, direccion, texto, negocioId.trim(), origen || null, messageIdExterno, fecha || null]);
    return rows[0] || null;
  } catch (e) {
    console.error('[DB] Error importarMensajeHistorico:', e.message);
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
export async function crearDocumentoPendiente({ negocioId, telefono, direccion, origen = null, filename, mimeType = 'application/pdf', caption = null, wamid = null, createdBy = null, categoria = 'documento', mediaId = null }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('crearDocumentoPendiente: negocioId requerido');
  const result = await pool.query(`
    INSERT INTO documentos (negocio_id, telefono, direccion, origen, estado, filename, mime_type, caption, wamid, created_by, categoria, media_id)
    VALUES ($1,$2,$3,$4,'pendiente',$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (wamid) WHERE wamid IS NOT NULL DO NOTHING
    RETURNING *
  `, [negocioId.trim(), telefono, direccion, origen, filename, mimeType, caption, wamid, createdBy, categoria, mediaId]);
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
export async function crearDocumentoSaliente({ negocioId, telefono, filename, mimeType = 'application/pdf', sizeBytes, storageKey, caption = null, wamid = null, createdBy = null, categoria = 'documento', checksum = null }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('crearDocumentoSaliente: negocioId requerido');
  const { rows } = await pool.query(`
    INSERT INTO documentos (negocio_id, telefono, direccion, origen, estado, filename, mime_type, size_bytes, storage_key, caption, wamid, created_by, categoria, checksum)
    VALUES ($1,$2,'saliente','humano','listo',$3,$4,$5,$6,$7,$8,$9,$10,$11)
    RETURNING *
  `, [negocioId.trim(), telefono, filename, mimeType, sizeBytes, storageKey, caption, wamid, createdBy, categoria, checksum]);
  return rows[0];
}

export async function marcarDocumentoListo(documentoId, { sizeBytes, storageKey, checksum = null }) {
  await pool.query(
    `UPDATE documentos SET estado = 'listo', size_bytes = $2, storage_key = $3, checksum = COALESCE($4, checksum) WHERE id = $1`,
    [documentoId, sizeBytes, storageKey, checksum]
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

// Hotfix (desglose de IVA): la TASA usada se resuelve una sola vez aquí,
// nunca se reinventa en el PDF ni en el panel -- si el caller (API) no
// especifica una tasa explícita, se usa el default configurado para el
// negocio (configuracion.iva_pct_default, mismo patrón clave/valor ya
// usado para vigencia_dias_default/anticipo_porcentaje_default). Sin
// configurar -> 0%, IDÉNTICO al comportamiento previo a este hotfix --
// ningún negocio existente cambia solo por este cambio de código.
async function _resolverTasaIva(negocioId, impuestosPct) {
  if (impuestosPct !== null && impuestosPct !== undefined) {
    const n = Number(impuestosPct);
    return Number.isFinite(n) ? n : 0;
  }
  try {
    const config = await obtenerConfiguracion(negocioId);
    const n = Number(config.iva_pct_default);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
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
export async function crearCotizacion({ negocioId, telefono, createdBy, evento = {}, vigenciaHasta = null, anticipoRequerido = null, notas = null, terminos = null, items = [], impuestosPct = null, origen = 'panel' }) {
  // Mismo contrato fail-closed que registrarPedido() (orderManager.js) y
  // TenantContextRequiredError (integracionesService.js): sin negocioId
  // válido, se rechaza antes de tocar la base -- nunca un fallback implícito
  // a ningún negocio.
  if (typeof negocioId !== 'string' || !negocioId.trim()) throw new Error('TENANT_CONTEXT_REQUIRED: crearCotizacion sin negocioId resuelto — se rechaza antes de persistir');
  if (!Array.isArray(items) || items.length === 0) throw new Error('crearCotizacion: al menos un item requerido');
  const tasaIva = await _resolverTasaIva(negocioId, impuestosPct);
  const totales = _calcularTotales(items, { impuestosPct: tasaIva });
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
          vigencia_hasta, subtotal, impuestos, descuentos, total, anticipo_requerido, notas, terminos, created_by, origen, impuestos_tasa
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
        RETURNING *
      `, [
        negocioId.trim(), telefono, folio, evento.nombre || null, evento.fecha || null, evento.lugar || null,
        evento.cantidadPersonas || null, vigenciaHasta, totales.subtotal, totales.impuestos, totales.descuentos,
        totales.total, anticipoRequerido, notas, terminos, createdBy, origen, tasaIva,
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
export async function actualizarCotizacion(cotizacionId, negocioId, cambios = {}, items = null, impuestosPct = null) {
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
    // Hotfix (desglose de IVA): si esta edición no especifica una tasa
    // explícita, se REUTILIZA la tasa ya vigente de la cotización (nunca
    // se resetea a 0) -- antes de este cambio, cada edición borraba
    // silenciosamente el IVA ya cobrado en la versión anterior.
    const tasaIva = (impuestosPct !== null && impuestosPct !== undefined)
      ? Number(impuestosPct)
      : (Number(actual.impuestos_tasa) || 0);
    const totales = _calcularTotales(itemsFinal, { impuestosPct: tasaIva });
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
        subtotal = $10, impuestos = $11, descuentos = $12, total = $13, impuestos_tasa = $14
      WHERE id = $1
      RETURNING *
    `, [
      cotizacionId, cambios.evento?.nombre, cambios.evento?.fecha, cambios.evento?.lugar, cambios.evento?.cantidadPersonas,
      cambios.vigenciaHasta, cambios.anticipoRequerido, cambios.notas, cambios.terminos,
      totales.subtotal, totales.impuestos, totales.descuentos, totales.total, tasaIva,
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

// enviadoPor SIEMPRE debe ser un usuarios.id humano autenticado -- la IA
// del Asistente Comercial nunca aprueba ni envía por sí sola (ver
// draftBuilder.js), así que esta función solo se llama desde el POST
// /api/cotizaciones/:id/enviar real, nunca desde el flujo de borrador.
export async function marcarCotizacionEnviada(cotizacionId, enviadoPor = null) {
  const { rows } = await pool.query(
    `UPDATE cotizaciones SET estado = 'enviada', sent_at = NOW(), enviado_por = $2 WHERE id = $1 RETURNING *`,
    [cotizacionId, enviadoPor]
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
// Persistencia INICIAL de un folio nuevo en pedidos_activos -- nunca una
// actualización. Causa raíz original de la carrera de asignación de
// repartidor (12-PEDIDO-YA-ASIGNADO-NO-SE-REASIGNA): registrarPedido()
// disparaba esta función sin esperarla (fire-and-forget), así que su
// escritura podía resolver DESPUÉS de que asignarRepartidor() ya había
// asignado el pedido -- el antiguo "ON CONFLICT DO UPDATE SET datos = $3"
// sobrescribía TODO el
// JSONB con la copia vieja del pedido en memoria (sin repartidor_id),
// borrando la asignación ya confirmada y dejando la fila "sin asignar"
// otra vez para el siguiente repartidor. Los tres llamadores de esta
// función (orderManager.js, whatsapp-meta.js, server.js) siempre la usan
// para el primer INSERT de ese folio en esta tabla -- si la fila ya
// existe, la base de datos ya tiene la verdad correcta (venga de esta
// misma función llegando tarde, o de asignarRepartidor/
// actualizarEstadoPedidoDB, que sí actualizan con jsonb_set/UPDATE
// condicionado) y no hay nada que sobrescribir.
// Hotfix P0 folio-conflicto-silencioso: el retorno ahora distingue
// inequívocamente INSERT real, CONFLICTO de folio y ERROR SQL. Antes
// devolvía `true` incondicional: un conflicto (DO NOTHING → rowCount 0) se
// reportaba como éxito y el caller confirmaba un pedido cuya fila en BD era
// OTRO pedido — reproducido con pérdida silenciosa 10/20 en concurrencia e
// incluso con cruce de tenant.
//
// Contrato (sigue sin lanzar JAMÁS):
//   { ok:true,  insertado:true,  conflicto:false } → fila nueva escrita.
//   { ok:true,  insertado:false, conflicto:true  } → el folio ya existía.
//       Para los re-guardados idempotentes del MISMO pedido (re-save
//       defensivo de whatsapp-meta.js y scheduler de programados en
//       server.js — ambos ignoran el retorno) este es el caso esperado y
//       NO es un error. Para folios recién tomados del contador significa
//       "ese folio es de OTRO pedido": registrarPedido reintenta con el
//       siguiente — nunca se reutiliza el pedido existente (sería
//       contaminación, incluso entre tenants).
//   { ok:false, insertado:false, conflicto:false } → error SQL real
//       (conexión caída, etc.) — jamás debe tratarse como conflicto ni
//       reintentarse con otro folio.
export async function guardarPedidoActivo(pedido, negocioId) {
  try {
    const r = await pool.query(`
      INSERT INTO pedidos_activos (folio, estado, datos, negocio_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (folio) DO NOTHING
      RETURNING folio
    `, [pedido.id, pedido.estado || 'nuevo', JSON.stringify(pedido), negocioId || null]);
    if (r.rowCount === 1) return { ok: true, insertado: true, conflicto: false };
    return { ok: true, insertado: false, conflicto: true };
  } catch (e) {
    console.error('[DB] Error guardarPedidoActivo:', e.message);
    return { ok: false, insertado: false, conflicto: false };
  }
}

export async function actualizarEstadoPedidoDB(folio, estado) {
  try {
    // entregado_at (migración 036): se puebla únicamente hacia adelante, en
    // la propia transición a 'entregado' -- nunca se backfillea con una
    // fecha inventada para pedidos ya entregados antes de esta columna.
    // El guard `entregado_at IS NULL` evita pisar el primer valor real si
    // por algún motivo esta función se invocara más de una vez con
    // estado='entregado' para el mismo folio.
    await pool.query(`
      UPDATE pedidos_activos
      SET estado = $1::text,
          updated_at = NOW(),
          entregado_at = CASE
            WHEN $1::text = 'entregado' AND entregado_at IS NULL THEN NOW()
            ELSE entregado_at
          END
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
        AND folio NOT LIKE 'RM-%'
      ORDER BY created_at ASC
    `);
    // Los folios RM- son ventas consolidadas de restaurante: nacen
    // 'entregado' y un reverso admin las deja 'cancelado' -- en ningún caso
    // son pedidos operables del tablero de comandas.
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
// Sirve para que el contador nunca repita un folio tras un reinicio.
// Solo cuenta folios XAB- numéricos: la tabla también guarda ventas
// consolidadas de restaurante (folio RM-...) que romperían el CAST y, vía el
// catch, resetearían el contador a 0 (colisiones de folio).
export async function obtenerMaxFolioNum() {
  try {
    const result = await pool.query(`
      SELECT COALESCE(MAX(CAST(SUBSTRING(folio FROM '^XAB-([0-9]+)$') AS INTEGER)), 0) AS max_num
      FROM pedidos_activos
      WHERE folio ~ '^XAB-[0-9]+$'
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

// Reactiva un registro de pago en estado terminal NO cobrable para
// reintentarlo (hotfix bot-envio-enlace-pago): la fila conserva su
// referencia_interna única, así que reutilizarla es la única forma de
// reintentar sin chocar con el UNIQUE. El guard de estados garantiza que
// jamás se "reactiva" un pago pagado o todavía vigente.
export async function reactivarRegistroPago(pagoId) {
  const { rowCount } = await pool.query(
    `UPDATE pagos SET estado = 'creando'
     WHERE id = $1 AND estado IN ('fallido','invalidado','vencido','cancelado')`,
    [pagoId]
  );
  return rowCount > 0;
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
    // Incidente XAB-0114: el remitente del webhook llega como
    // '521<10 dígitos>' pero el pedido puede guardar el teléfono DICTADO en
    // el chat ('<10 dígitos>' sin prefijo) -- la igualdad exacta dejaba al
    // cliente sin su propio pedido. Se compara por los últimos 10 dígitos
    // (el número nacional real) en ambos lados, y también contra
    // telefono_conversacion (identidad del REMITENTE, sellada al registrar
    // pedidos de WhatsApp) para el caso en que el teléfono de entrega
    // dictado sea el de OTRA persona. Siempre dentro del negocio.
    const result = await pool.query(
      `SELECT folio, estado, datos, created_at
       FROM pedidos_activos
       WHERE (
           right(regexp_replace(COALESCE(datos->'cliente'->>'telefono',''), '\\D', '', 'g'), 10)
             = right(regexp_replace($1, '\\D', '', 'g'), 10)
        OR right(regexp_replace(COALESCE(datos->>'telefono_conversacion',''), '\\D', '', 'g'), 10)
             = right(regexp_replace($1, '\\D', '', 'g'), 10)
       )
         AND right(regexp_replace($1, '\\D', '', 'g'), 10) <> ''
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

// Búsqueda de un pedido PARA PAGO por folio (incidente XAB-0114): a
// diferencia de obtenerPedidoPorFolioAmplio, un pedido 'entregado' SIN
// pagar sigue siendo elegible -- ese es exactamente el caso que necesita el
// enlace (entrega contra pago, o archivado prematuro en el panel, como el
// XAB-0114 real, archivado 3 segundos después del "Folio 114"). Solo
// 'cancelado' queda fuera. Siempre dentro del negocio de la conversación.
export async function obtenerPedidoParaPagoPorFolio(folio, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] obtenerPedidoParaPagoPorFolio: negocioId inválido u omitido — rechazado');
    return null;
  }
  try {
    const r = await pool.query(
      `SELECT datos, estado FROM pedidos_activos
       WHERE folio = $1 AND negocio_id = $2 AND estado != 'cancelado'`,
      [folio, negocioId.trim()]
    );
    if (!r.rows[0]) return null;
    return { ...r.rows[0].datos, _estado: r.rows[0].estado, _origen: 'activo' };
  } catch (e) {
    console.error('[DB] Error obtenerPedidoParaPagoPorFolio:', e.message);
    return null;
  }
}

// Variante de upsertCliente para el NOMBRE DE ENTREGA de un pedido
// (incidente Alina/Mario): el destinatario dictado jamás sustituye al
// nombre ya conocido del interlocutor -- solo llena el perfil si estaba
// vacío. upsertCliente (arriba) conserva su semántica original para los
// flujos donde el nombre SÍ viene del propio interlocutor.
export async function upsertClienteNombreEntrega(telefono, nombreEntrega, negocioId) {
  try {
    await pool.query(`
      INSERT INTO clientes (telefono, nombre, ultima_visita, negocio_id)
      VALUES ($1, $2, NOW(), $3)
      ON CONFLICT (telefono) DO UPDATE SET
        nombre = COALESCE(clientes.nombre, NULLIF($2, '')),
        ultima_visita = NOW()
    `, [telefono, nombreEntrega || null, negocioId || null]);
  } catch (e) {
    console.error('[DB] Error upsertClienteNombreEntrega:', e.message);
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

// PARTNER_REMOVED (webhook account_update, Coexistence): el dueño
// desvinculó a Xabor desde su WhatsApp Business App. Solo se marca el
// estado -- NUNCA se borra la integración, ni credenciales, ni historial:
// el negocio puede reconectar desde el panel y todo sigue ahí. `activo`
// tampoco se toca (sigue siendo el mapeo del webhook); lo que corta los
// envíos automáticos equivocados es estado <> 'activo', que ya gobierna
// completarActivacionWhatsapp/el panel. Se resuelve por waba_id porque el
// payload de account_update NO trae metadata.phone_number_id.
export async function marcarIntegracionDesconectadaPorWaba(wabaId) {
  if (typeof wabaId !== 'string' || !wabaId.trim()) return 0;
  try {
    const { rowCount } = await pool.query(
      `UPDATE integraciones_canal
       SET estado = 'desconectado', updated_at = NOW()
       WHERE canal = 'whatsapp' AND proveedor = 'meta' AND waba_id = $1`,
      [wabaId.trim()]);
    return rowCount;
  } catch (e) {
    console.error('[DB] Error marcarIntegracionDesconectadaPorWaba:', e.message);
    return 0;
  }
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
      // sesiones_invalidas_antes (042): marca puesta al restablecer la
      // contraseña. Viaja aquí porque esta consulta ya se hace en cada
      // request autenticado -- así revocar las sesiones abiertas no cuesta
      // una consulta extra ni obliga a inventar un registro de sesiones.
      `SELECT un.rol, un.activo, u.sesiones_invalidas_antes
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
// ─── Meseros: usuarios del negocio con PIN local, sin correo ───────────────
// Un mesero es un usuario normal (mismo UUID, mismo aislamiento por
// negocio_id) con rol 'mesero' en usuario_negocios y un PIN hasheado en vez
// de correo/contraseña: no inicia sesión, solo se identifica al abrir mesa.
// Migración 041 permitió email NULL para no inventarle un correo falso.
export async function crearMeseroConPin({ negocioId, nombre, pin }) {
  if (!pinValido(pin)) {
    throw Object.assign(new Error('El PIN debe tener entre 4 y 6 dígitos'), { code: 'PIN_INVALIDO' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [usuario] } = await client.query(
      `INSERT INTO usuarios (negocio_id, nombre, email, pin_hash) VALUES ($1,$2,NULL,$3)
       RETURNING id, negocio_id, nombre, created_at`,
      [negocioId, nombre, hashPin(pin)]
    );
    await client.query(
      `INSERT INTO usuario_negocios (usuario_id, negocio_id, rol) VALUES ($1,$2,'mesero')`,
      [usuario.id, negocioId]
    );
    await client.query('COMMIT');
    // Nunca se devuelve el hash ni el PIN.
    return { id: usuario.id, nombre: usuario.nombre, rol: 'mesero', activo: true, created_at: usuario.created_at };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Error crearMeseroConPin:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// Personas que pueden atender mesas en ESTE negocio: meseros con PIN y
// también el resto de usuarios activos (un admin puede levantar una mesa).
// Devuelve solo lo que la pantalla necesita -- jamás el hash.
export async function listarMeserosDelNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.nombre, un.rol, (u.pin_hash IS NOT NULL) AS tiene_pin
         FROM usuarios u
         JOIN usuario_negocios un ON un.usuario_id = u.id
        WHERE un.negocio_id = $1 AND un.activo = TRUE AND u.activo = TRUE
        ORDER BY (un.rol = 'mesero') DESC, u.nombre ASC`,
      [negocioId.trim()]
    );
    return rows;
  } catch (e) {
    console.error('[DB] Error listarMeserosDelNegocio:', e.message);
    return [];
  }
}

// Meseros elegibles para la ESTACIÓN (login por PIN): solo rol 'mesero',
// activos y con PIN configurado, del negocio indicado. Devuelve id y nombre
// -- jamás el hash ni el correo.
export async function listarMeserosEstacion(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.nombre
         FROM usuarios u
         JOIN usuario_negocios un ON un.usuario_id = u.id
        WHERE un.negocio_id = $1 AND un.rol = 'mesero'
          AND un.activo = TRUE AND u.activo = TRUE AND u.pin_hash IS NOT NULL
        ORDER BY u.nombre ASC`,
      [negocioId.trim()]
    );
    return rows;
  } catch (e) {
    console.error('[DB] Error listarMeserosEstacion:', e.message);
    return [];
  }
}

// Estado vigente de un mesero, releído en CADA request protegido: si un
// admin lo desactiva (o le quita el rol), su sesión abierta deja de operar
// aunque la cookie siga siendo criptográficamente válida.
export async function meseroVigente(usuarioId, negocioId) {
  if (typeof usuarioId !== 'string' || typeof negocioId !== 'string') return null;
  try {
    const { rows } = await pool.query(
      `SELECT u.id, u.nombre
         FROM usuarios u
         JOIN usuario_negocios un ON un.usuario_id = u.id
        WHERE u.id = $1 AND un.negocio_id = $2 AND un.rol = 'mesero'
          AND un.activo = TRUE AND u.activo = TRUE AND u.pin_hash IS NOT NULL`,
      [usuarioId, negocioId]
    );
    return rows[0] || null;
  } catch (e) {
    console.error('[DB] Error meseroVigente:', e.message);
    return null;
  }
}

// Valida el PIN de un mesero DE ESTE NEGOCIO. Nunca revela si el usuario
// existe: un id ajeno y un PIN incorrecto se ven igual desde afuera.
export async function verificarPinMesero(usuarioId, negocioId, pin) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return false;
  try {
    const { rows } = await pool.query(
      `SELECT u.pin_hash FROM usuarios u
         JOIN usuario_negocios un ON un.usuario_id = u.id
        WHERE u.id = $1 AND un.negocio_id = $2 AND un.activo = TRUE AND u.activo = TRUE`,
      [usuarioId, negocioId.trim()]
    );
    if (!rows.length || !rows[0].pin_hash) return false;
    return verifyPin(pin, rows[0].pin_hash);
  } catch (e) {
    console.error('[DB] Error verificarPinMesero:', e.message);
    return false;
  }
}

// ¿El usuario de la sesión es miembro activo de este negocio? Distingue a un
// admin/staff propio (que puede atender su mesa sin PIN) de un superadmin en
// sesión de soporte, que NO pertenece al negocio y por lo tanto nunca puede
// quedar registrado como su mesero.
export async function esMiembroActivoDelNegocio(usuarioId, negocioId) {
  if (typeof usuarioId !== 'string' || typeof negocioId !== 'string') return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM usuario_negocios un JOIN usuarios u ON u.id = un.usuario_id
        WHERE un.usuario_id = $1 AND un.negocio_id = $2 AND un.activo = TRUE AND u.activo = TRUE`,
      [usuarioId, negocioId]
    );
    return rows.length === 1;
  } catch (e) {
    console.error('[DB] Error esMiembroActivoDelNegocio:', e.message);
    return false;
  }
}

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

// ─── Transición pendiente_pago → nuevo, recuperable ante crash ───────────────
//
// El problema que resuelve: confirmar el pago movía el pedido a 'nuevo' y
// DESPUÉS emitía. Un crash entre las dos cosas dejaba el dinero cobrado, el
// pedido en 'nuevo', y a la cocina sin papel -- y ningún reintento lo
// arreglaba, porque el pedido ya no estaba 'pendiente_pago' y el código lo
// daba por procesado.
//
// La corrección es escribir la DEUDA antes de saldarla: en el MISMO UPDATE que
// mueve el estado se marca `emision_pendiente`. Esa marca es la garantía
// persistente de "este pedido todavía debe emitirse", y sólo se borra cuando la
// emisión terminó. Si el proceso muere en medio, la marca sigue ahí y cualquier
// reintento -- o el barrido de reconciliación -- la encuentra y termina el
// trabajo. La memoria del proceso no participa.
//
// Devuelve `reclamado: true` sólo a quien logró hacer la transición o a quien
// encuentra la deuda pendiente: es el permiso para emitir.
export async function reclamarEmisionPorPago(folio, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { reclamado: false, razon: 'sin_negocio' };
  const nid = negocioId.trim();
  const { rows } = await pool.query(
    `UPDATE pedidos_activos
        SET estado = 'nuevo',
            datos = datos || '{"emision_pendiente":true}'::jsonb,
            updated_at = NOW()
      WHERE folio = $1 AND negocio_id = $2
        AND (estado = 'pendiente_pago'
             OR (estado = 'nuevo' AND datos->>'emision_pendiente' = 'true'))
      RETURNING datos`,
    [folio, nid]);
  if (!rows.length) return { reclamado: false, razon: 'sin_deuda_de_emision' };
  return { reclamado: true, datos: rows[0].datos };
}

// EXCLUSIVIDAD de la emisión. Escribir la deuda es durable pero NO es un claim:
// dos procesos concurrentes pasan los dos por ese UPDATE, porque después del
// primero la fila SIGUE cumpliendo la condición (nuevo + emision_pendiente).
// Postgres serializa el UPDATE, no la decisión de emitir.
//
// El claim de verdad es un advisory lock por (negocio, folio), sostenido
// mientras corre el efecto. Quien no lo obtiene NO emite: otro proceso vivo ya
// está en eso. Si ese proceso muere, la conexión muere, el lock se suelta y la
// deuda sigue escrita -- el siguiente reintento o el reconciliador la retoman.
// Sin lease, sin relojes, sin depender de memoria.
//
// Va por el pool de claims (ver poolDeClaims): esta conexión queda ocupada
// mientras `fn` trabaja, y `fn` necesita conexiones. Con un solo pool, N
// confirmaciones simultáneas se bloquearían entre sí para siempre -- el mismo
// interbloqueo que ya se corrigió en el checkout de la tienda.
export async function conEmisionExclusiva(folio, negocioId, fn) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { emitio: false, razon: 'sin_negocio' };
  const nid = negocioId.trim();
  const cliente = await poolDeClaims().connect();
  try {
    await cliente.query('BEGIN');
    const { rows: [lock] } = await cliente.query(
      `SELECT pg_try_advisory_xact_lock(hashtext($1), hashtext($2)) AS obtenido`,
      ['emision_por_pago', `${nid}:${folio}`]);
    if (!lock?.obtenido) {
      await cliente.query('ROLLBACK');
      return { emitio: false, razon: 'otro_proceso_emitiendo' };
    }

    // Dentro del lock se vuelve a mirar la deuda: entre el reclamo y el lock,
    // el ganador anterior pudo haberla saldado ya.
    const { rows: [fila] } = await cliente.query(
      `SELECT datos FROM pedidos_activos
        WHERE folio = $1 AND negocio_id = $2 AND datos->>'emision_pendiente' = 'true'`,
      [folio, nid]);
    if (!fila) {
      await cliente.query('ROLLBACK');
      return { emitio: false, razon: 'sin_deuda' };
    }

    await fn(fila.datos);

    // Se salda en la misma transacción que suelta el lock: no queda instante en
    // el que otro proceso vea el lock libre y la deuda todavía escrita.
    await cliente.query(
      `UPDATE pedidos_activos SET datos = datos - 'emision_pendiente', updated_at = NOW()
        WHERE folio = $1 AND negocio_id = $2`, [folio, nid]);
    await cliente.query('COMMIT');
    return { emitio: true };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// La deuda se salda DESPUÉS de que la emisión terminó, nunca antes: al revés,
// un crash dejaría el pedido marcado como emitido sin haberlo hecho.
export async function saldarEmisionPorPago(folio, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return false;
  const { rowCount } = await pool.query(
    `UPDATE pedidos_activos
        SET datos = datos - 'emision_pendiente', updated_at = NOW()
      WHERE folio = $1 AND negocio_id = $2`,
    [folio, negocioId.trim()]);
  return rowCount > 0;
}

// Barrido de reconciliación: pedidos con el pago confirmado cuya emisión quedó
// a medias. Es la red que recoge lo que un crash dejó caer cuando nadie
// reintenta desde fuera.
export async function pedidosConEmisionPendiente(limite = 50) {
  const { rows } = await pool.query(
    `SELECT folio, negocio_id, datos FROM pedidos_activos
      WHERE datos->>'emision_pendiente' = 'true'
      ORDER BY updated_at ASC LIMIT $1`, [limite]);
  return rows;
}

// Ejecuta `emitir` A LO SUMO UNA VEZ por (negocio, printJobId), aunque se
// llame desde varios procesos a la vez y aunque el servidor se reinicie entre
// intentos.
//
// Por qué hace falta: de los efectos de emitirPedido, el broadcast al
// print-agent legacy es el único que no deduplica nada por su cuenta. Edge
// tiene clave de idempotencia, la oferta a repartidores tiene (folio,
// repartidor); legacy era papel a ciegas. Y los agentes legacy instalados en
// los negocios son binarios viejos que no se pueden actualizar desde aquí, así
// que la memoria tiene que estar de este lado.
//
// Dos mecanismos, no uno:
//   · pg_advisory_xact_lock resuelve la CONCURRENCIA -- dos emisores del mismo
//     trabajo se serializan, y el segundo ya ve la fila del primero. Es
//     bloqueante a propósito: aquí no sirve rendirse, el trabajo tiene que
//     salir exactamente una vez y esperar cuesta lo que cuesta un send de WS.
//   · la fila commiteada resuelve el REINICIO -- un proceso nuevo, o una
//     segunda instancia del servidor, ve lo que emitió el anterior.
//
// Un lock por sí solo no bastaría (muere con el proceso) y una fila sin lock
// tampoco (el hueco entre leer y escribir es justo la carrera).
//
// La fila se escribe DESPUÉS de emitir, en la misma transacción. Registrarla
// antes cambiaría "papel repetido" por "pedido sin papel", que es peor. Queda
// una ventana de microsegundos -- crash entre el send y el COMMIT -- en la que
// un reintento reemitiría: es inherente a un broadcast sin acuse de recibo, y
// el lado en que cae es el de que el papel salga.
//
// Usa el pool PRINCIPAL a propósito, no el de claims: mientras sostiene su
// conexión no pide ninguna otra -- todas sus consultas van por esa misma, y
// `emitir` es un envío WebSocket en proceso, sin base de datos. No puede
// participar del interbloqueo que describe poolDeClaims().
export async function emitirUnaSolaVezLegacy(negocioId, printJobId, emitir) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw new Error('emitirUnaSolaVezLegacy: negocioId inválido u omitido');
  }
  if (typeof printJobId !== 'string' || !printJobId.trim()) {
    throw new Error('emitirUnaSolaVezLegacy: printJobId inválido u omitido');
  }
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    await cliente.query(
      `SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`,
      ['impresion_legacy', `${negocioId}:${printJobId}`]);

    const { rows } = await cliente.query(
      `SELECT 1 FROM impresion_legacy_emitida
        WHERE negocio_id = $1 AND print_job_id = $2`,
      [negocioId, printJobId]);
    if (rows.length > 0) {
      await cliente.query('ROLLBACK');
      return { duplicado: true, destinatarios: 0 };
    }

    // destinatarios = 0 NO es "impreso": es "no había nadie escuchando". El
    // trabajo queda PENDIENTE y se le entrega al agente en cuanto se conecte.
    // Antes esa fila se escribía igual y el trabajo se perdía en silencio: el
    // negocio se quedaba sin comanda y nadie se enteraba.
    const destinatarios = Number(await emitir()) || 0;
    await cliente.query(
      `INSERT INTO impresion_legacy_emitida (negocio_id, print_job_id, destinatarios, estado, entregado_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (negocio_id, print_job_id) DO NOTHING`,
      [negocioId, printJobId, destinatarios,
       destinatarios > 0 ? 'entregado' : 'pendiente',
       destinatarios > 0 ? new Date() : null]);
    await cliente.query('COMMIT');
    return { duplicado: false, destinatarios, pendiente: destinatarios === 0 };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}

// ─── El camino legacy, acotado a UN negocio ──────────────────────────────────
//
// El agente viejo instalado en sitio se conecta a la raíz "/" y no dice quién
// es: no manda credencial, ni cabecera, ni query. No se puede pedirle identidad
// sin cambiar el binario, y el binario está en una máquina ajena.
//
// Lo que sí se puede es que el SERVIDOR determine de quién es esa conexión, y
// solo la acepte si la respuesta es inequívoca: el único negocio con
// print_agent_legacy_activo = 'true'.
//
//   · ninguno  → la ruta "/" se cierra sola. El día que el último negocio pase
//                a Edge, el camino legacy deja de existir sin tocar código.
//   · varios   → se rechaza. La plataforma no adivina a quién le toca una
//                comanda; ese es justo el fallo que se está corrigiendo.
//   · uno      → esa conexión es de ese negocio, y de nadie más.
export async function resolverNegocioLegacyUnico() {
  const { rows } = await pool.query(
    `SELECT negocio_id FROM configuracion
      WHERE clave = 'print_agent_legacy_activo' AND valor = 'true'`);
  if (rows.length === 0) return { negocioId: null, razon: 'sin_negocio_legacy' };
  if (rows.length > 1) return { negocioId: null, razon: 'multiples_negocios_legacy' };
  return { negocioId: rows[0].negocio_id, razon: null };
}

// Reclama los trabajos que este agente va a recibir al conectarse. El UPDATE
// condicional es el claim: dos conexiones simultáneas no pueden llevarse el
// mismo trabajo, porque solo una gana la fila 'pendiente'.
//
// Devuelve el pedido leído de pedidos_activos, no una copia guardada: así el
// papel sale con lo que el pedido dice HOY. Un pedido ya entregado o archivado
// no se reimprime.
export async function reclamarTrabajosLegacyPendientes(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  const { rows } = await pool.query(
    `WITH reclamados AS (
       UPDATE impresion_legacy_emitida e
          SET estado = 'entregado', entregado_at = NOW()
        WHERE e.negocio_id = $1 AND e.estado = 'pendiente'
        RETURNING e.print_job_id
     )
     SELECT r.print_job_id, p.datos
       FROM reclamados r
       JOIN pedidos_activos p
         ON p.negocio_id = $1
        AND p.folio = split_part(r.print_job_id, ':', 1)
      WHERE p.estado <> 'entregado'`,
    [negocioId]);
  return rows.map(r => ({ printJobId: r.print_job_id, pedido: r.datos }));
}

// Si el envío falla en el último momento, el trabajo vuelve a la cola: nunca se
// da por entregado algo que no salió del servidor.
export async function devolverTrabajoLegacyAPendiente(negocioId, printJobId) {
  await pool.query(
    `UPDATE impresion_legacy_emitida
        SET estado = 'pendiente', entregado_at = NULL
      WHERE negocio_id = $1 AND print_job_id = $2`,
    [negocioId, printJobId]).catch(() => {});
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

// ─── Red de Repartidores — Superadmin (roster y administración) ─────────────
// A diferencia de obtenerRepartidores/guardarPushRepartidor (negocioId
// OBLIGATORIO, falla cerrado — regla P0), estas funciones aceptan negocioId
// OPCIONAL a propósito: el Superadmin necesita una vista global entre
// negocios. Esto es una excepción deliberada, nunca un descuido — el
// aislamiento se sigue garantizando en la capa de rutas (server.js): las
// rutas /api/superadmin/* llaman sin negocioId tras pasar requireSuperadmin,
// las rutas /api/admin/* SIEMPRE pasan el negocioId de la sesión y nunca
// exponen el parámetro al cliente.

export const ESTADOS_REPARTIDOR_VALIDOS = ['disponible', 'pausado', 'suspendido', 'baja'];

// Única función que escribe `estado`. Sincroniza atómicamente `estado` y
// `activo` en una sola UPDATE — disponible⇒activo=true, cualquier otro
// valor⇒activo=false — para que el motor de notificaciones (que solo lee
// `activo`, sin cambios) nunca quede desincronizado del estado administrativo.
// Nunca reutiliza eliminarRepartidor (hard delete): "baja" es un estado, la
// fila y su historial en notificaciones_repartidor/pedidos_activos permanecen.
export async function cambiarEstadoRepartidor(id, nuevoEstado, { negocioId } = {}) {
  if (!ESTADOS_REPARTIDOR_VALIDOS.includes(nuevoEstado)) {
    console.warn(`[DB] cambiarEstadoRepartidor: estado inválido "${nuevoEstado}" — rechazado`);
    return null;
  }
  const activo = nuevoEstado === 'disponible';
  try {
    const params = [nuevoEstado, activo, id];
    let where = 'id = $3';
    if (negocioId) {
      params.push(negocioId);
      where += ` AND negocio_id = $${params.length}`;
    }
    const r = await pool.query(
      `UPDATE repartidores SET estado = $1, activo = $2 WHERE ${where} RETURNING *`,
      params
    );
    return r.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error cambiarEstadoRepartidor:', e.message);
    return null;
  }
}

export async function editarPerfilRepartidor(id, cambios, { negocioId } = {}) {
  const camposPermitidos = ['nombre', 'ciudad', 'zona', 'vehiculo'];
  const sets = [];
  const params = [];
  for (const campo of camposPermitidos) {
    if (cambios[campo] !== undefined) {
      params.push(cambios[campo]);
      sets.push(`${campo} = $${params.length}`);
    }
  }
  if (!sets.length) return null;
  params.push(id);
  let where = `id = $${params.length}`;
  if (negocioId) {
    params.push(negocioId);
    where += ` AND negocio_id = $${params.length}`;
  }
  try {
    const r = await pool.query(`UPDATE repartidores SET ${sets.join(', ')} WHERE ${where} RETURNING *`, params);
    return r.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error editarPerfilRepartidor:', e.message);
    return null;
  }
}

// Agrupa repartidores por teléfono normalizado (mismo criterio que
// normalizarTelefonoMX, usado también por whatsapp-meta.js para el dedupe de
// envío) y devuelve solo los grupos con más de una fila — nunca elimina ni
// modifica nada, es de solo lectura.
export async function detectarDuplicadosRepartidor(negocioId = null) {
  try {
    const where = negocioId ? 'WHERE negocio_id = $1' : '';
    const params = negocioId ? [negocioId] : [];
    const r = await pool.query(`
      SELECT id, nombre, telefono, negocio_id, activo, estado, created_at
      FROM repartidores
      ${where}
      ORDER BY activo DESC, nombre ASC
    `, params);
    const grupos = new Map();
    for (const fila of r.rows) {
      const norm = normalizarTelefonoMX(fila.telefono);
      if (!norm) continue;
      if (!grupos.has(norm)) grupos.set(norm, []);
      grupos.get(norm).push(fila);
    }
    return [...grupos.entries()]
      .filter(([, filas]) => filas.length > 1)
      .map(([telefonoNormalizado, filas]) => ({ telefonoNormalizado, filas }));
  } catch (e) {
    console.error('[DB] Error detectarDuplicadosRepartidor:', e.message);
    return [];
  }
}

// Tarjetas resumen del roster. "ocupado" es derivado (disponible + pedido
// activo asignado), nunca un valor persistido — ver migración 035.
export async function obtenerResumenRosterRepartidores(negocioId = null) {
  try {
    const where = negocioId ? 'WHERE negocio_id = $1' : '';
    const params = negocioId ? [negocioId] : [];
    const r = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE estado = 'disponible' AND NOT EXISTS (
          SELECT 1 FROM pedidos_activos pa
          WHERE pa.datos->>'repartidor_id' = repartidores.id::text
            AND pa.negocio_id = repartidores.negocio_id
            AND pa.estado NOT IN ('entregado', 'cancelado')
        ))::int AS disponibles,
        COUNT(*) FILTER (WHERE estado = 'disponible' AND EXISTS (
          SELECT 1 FROM pedidos_activos pa
          WHERE pa.datos->>'repartidor_id' = repartidores.id::text
            AND pa.negocio_id = repartidores.negocio_id
            AND pa.estado NOT IN ('entregado', 'cancelado')
        ))::int AS ocupados,
        COUNT(*) FILTER (WHERE estado = 'pausado')::int AS pausados,
        COUNT(*) FILTER (WHERE estado = 'suspendido')::int AS suspendidos,
        COUNT(*) FILTER (WHERE estado = 'baja')::int AS bajas
      FROM repartidores
      ${where}
    `, params);
    const duplicados = await detectarDuplicadosRepartidor(negocioId);
    return { ...r.rows[0], duplicados: duplicados.length };
  } catch (e) {
    console.error('[DB] Error obtenerResumenRosterRepartidores:', e.message);
    return { total: 0, disponibles: 0, ocupados: 0, pausados: 0, suspendidos: 0, bajas: 0, duplicados: 0 };
  }
}

// Roster con filtros y paginación. Replica EXACTAMENTE el ORDER BY de
// obtenerRepartidores (activo DESC, nombre ASC) para que la fila "canónica"
// en caso de duplicados sea siempre la misma que ya usa el motor de envío.
// actividad: 'reciente' (<=7 días), 'inactivo' (>30 días o nunca), null (todos).
export async function obtenerRosterRepartidores({
  negocioId = null,
  estado = null,
  actividad = null,
  soloDuplicados = false,
  busqueda = null,
  page = 1,
  pageSize = 50,
} = {}) {
  try {
    const condiciones = [];
    const params = [];
    if (negocioId) { params.push(negocioId); condiciones.push(`r.negocio_id = $${params.length}`); }
    if (estado) { params.push(estado); condiciones.push(`r.estado = $${params.length}`); }
    if (busqueda) {
      params.push(`%${busqueda.toLowerCase()}%`);
      const idxNombre = params.length;
      const soloDigitos = busqueda.replace(/\D/g, '');
      params.push(`%${soloDigitos}%`);
      const idxTel = params.length;
      condiciones.push(`(LOWER(r.nombre) LIKE $${idxNombre} OR r.telefono LIKE $${idxTel})`);
    }
    const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';

    const r = await pool.query(`
      WITH base AS (
        SELECT r.id, r.nombre, r.telefono, r.activo, r.estado, r.negocio_id, r.ciudad, r.zona,
          r.vehiculo, r.created_at, r.modo_actual,
          n.nombre AS negocio_nombre,
          (SELECT MAX(m.timestamp) FROM mensajes m
           WHERE RIGHT(regexp_replace(m.telefono, '\\D', '', 'g'), 10) = RIGHT(regexp_replace(r.telefono, '\\D', '', 'g'), 10)
             AND m.direccion = 'entrante') AS ultima_actividad,
          (SELECT MAX(nr.created_at) FROM notificaciones_repartidor nr WHERE nr.repartidor_id = r.id) AS ultima_notificacion,
          COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.repartidor_id = r.id AND nr.token_usado_at IS NOT NULL), 0)::int AS servicios_aceptados,
          COALESCE((SELECT COUNT(*) FROM pedidos_activos pa WHERE pa.datos->>'repartidor_id' = r.id::text AND pa.estado = 'entregado'), 0)::int AS servicios_entregados,
          EXISTS(SELECT 1 FROM pedidos_activos pa WHERE pa.datos->>'repartidor_id' = r.id::text AND pa.negocio_id = r.negocio_id AND pa.estado NOT IN ('entregado', 'cancelado')) AS ocupado_derivado
        FROM repartidores r
        LEFT JOIN negocios n ON n.id = r.negocio_id
        ${where}
      )
      SELECT *,
        CASE WHEN estado = 'disponible' AND ocupado_derivado THEN 'ocupado' ELSE estado END AS estado_operativo,
        COUNT(*) OVER () AS total_filtrado
      FROM base
      ${actividad === 'reciente' ? "WHERE ultima_actividad >= NOW() - INTERVAL '7 days'" : ''}
      ${actividad === 'inactivo' ? "WHERE (ultima_actividad IS NULL OR ultima_actividad < NOW() - INTERVAL '30 days')" : ''}
      ORDER BY activo DESC, nombre ASC
      LIMIT ${Number(pageSize)} OFFSET ${Number((page - 1) * pageSize)}
    `, params);

    let filas = r.rows;
    const total = filas.length ? Number(filas[0].total_filtrado) : 0;
    filas = filas.map(({ total_filtrado, ...resto }) => resto);

    if (soloDuplicados) {
      const grupos = await detectarDuplicadosRepartidor(negocioId);
      const idsDuplicados = new Set(grupos.flatMap((g) => g.filas.map((f) => f.id)));
      filas = filas.filter((f) => idsDuplicados.has(f.id));
    }

    return { filas, total, page, pageSize };
  } catch (e) {
    console.error('[DB] Error obtenerRosterRepartidores:', e.message);
    return { filas: [], total: 0, page, pageSize };
  }
}

export async function obtenerDetalleRepartidor(id, negocioId = null) {
  try {
    const where = negocioId ? 'r.id = $1 AND r.negocio_id = $2' : 'r.id = $1';
    const params = negocioId ? [id, negocioId] : [id];
    const r = await pool.query(`
      SELECT r.*, n.nombre AS negocio_nombre,
        COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.repartidor_id = r.id), 0)::int AS servicios_notificados,
        COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.repartidor_id = r.id AND nr.token_usado_at IS NOT NULL), 0)::int AS servicios_aceptados,
        COALESCE((SELECT COUNT(*) FROM pedidos_activos pa WHERE pa.datos->>'repartidor_id' = r.id::text AND pa.estado = 'entregado'), 0)::int AS servicios_entregados
      FROM repartidores r
      LEFT JOIN negocios n ON n.id = r.negocio_id
      WHERE ${where}
    `, params);
    return r.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerDetalleRepartidor:', e.message);
    return null;
  }
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
       SET datos = jsonb_set(jsonb_set(jsonb_set(datos,
             '{repartidor_id}', $2::jsonb),
             '{repartidor_nombre}', $3::jsonb),
             '{entrega_estado}', '"asignado"'),
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
      `SELECT folio, datos, estado, created_at FROM pedidos_activos
       WHERE estado NOT IN ('entregado','cancelado')
         AND datos->>'modalidad' = 'entrega a domicilio'
         AND datos->>'repartidor_id' = $1
       ORDER BY created_at ASC`,
      [String(repartidorId)]
    );
    return r.rows;
  } catch (e) { return []; }
}

// ─── Portal operativo del repartidor ────────────────────────────────────────
// Historial "Mis entregas": SOLO pedidos terminales (entregado/cancelado)
// del propio repartidor, con campos REDUCIDOS por política de privacidad
// (sin teléfono del cliente, sin calle/número/referencias -- solo colonia,
// folio, tiempos, pago y estado). hora_aceptacion se deriva de
// notificaciones_repartidor (token usado), igual que las métricas D.1; las
// aceptaciones hechas desde el propio portal no tienen token y quedan sin
// duración -- documentado, no se inventa. Paginado SIEMPRE.
export async function obtenerEntregasRepartidor(repartidorId, negocioId, { rango = '7d', filtroEstado = 'todos', pagina = 1, porPagina = 20 } = {}) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { entregas: [], total: 0 };
  const dias = rango === 'hoy' ? 1 : (rango === '30d' ? 30 : 7);
  const estados = filtroEstado === 'entregados' ? ['entregado']
    : filtroEstado === 'cancelados' ? ['cancelado'] : ['entregado', 'cancelado'];
  const offset = (Math.max(1, parseInt(pagina, 10) || 1) - 1) * porPagina;
  try {
    const params = [String(repartidorId), negocioId.trim(), estados, String(dias)];
    const filtroSQL = `
      FROM pedidos_activos pa
      WHERE pa.datos->>'repartidor_id' = $1
        AND pa.negocio_id = $2
        AND pa.estado = ANY($3)
        AND pa.created_at > NOW() - ($4 || ' days')::interval`;
    const [filas, conteo] = await Promise.all([
      pool.query(
        `SELECT pa.folio, pa.estado, pa.created_at, pa.entregado_at,
                pa.datos->'cliente'->>'colonia' AS colonia,
                pa.datos->>'total' AS total,
                pa.datos->'cancelacion'->>'motivo' AS cancelacion_motivo,
                (SELECT MIN(nr.token_usado_at) FROM notificaciones_repartidor nr
                 WHERE nr.pedido_folio = pa.folio AND nr.negocio_id = pa.negocio_id
                   AND nr.token_usado_at IS NOT NULL) AS hora_aceptacion
         ${filtroSQL}
         ORDER BY pa.created_at DESC
         LIMIT ${porPagina} OFFSET ${offset}`,
        params
      ),
      pool.query(`SELECT count(*)::int AS n ${filtroSQL}`, params),
    ]);
    return { entregas: filas.rows, total: conteo.rows[0].n };
  } catch (e) {
    console.error('[DB] Error obtenerEntregasRepartidor:', e.message);
    return { entregas: [], total: 0 };
  }
}

// Sub-estado de la ENTREGA (asignado -> recogido -> en_camino -> entregado)
// dentro de datos, sin tocar el estado principal del pedido (que sigue
// gobernando cocina/corte/ventas). Atómico y con dueño: solo el repartidor
// ASIGNADO puede avanzar, jamás sobre un pedido terminal, y repetir la
// misma transición es un no-op idempotente (el timestamp original se
// conserva vía COALESCE).
const ORDEN_ENTREGA = { asignado: 0, recogido: 1, en_camino: 2 };
export async function marcarEstadoEntrega(folio, negocioId, repartidorId, nuevoEstado) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { ok: false, motivo: 'sin_negocio' };
  if (!(nuevoEstado in ORDEN_ENTREGA) || nuevoEstado === 'asignado') return { ok: false, motivo: 'estado_invalido' };
  const tsCampo = nuevoEstado === 'recogido' ? 'recogido_at' : 'en_camino_at';
  try {
    const r = await pool.query(
      `UPDATE pedidos_activos
       SET datos = jsonb_set(
             jsonb_set(datos, '{entrega_estado}', to_jsonb($4::text)),
             ('{' || $5 || '}')::text[], to_jsonb(COALESCE(datos->>$5, NOW()::text))
           ),
           updated_at = NOW()
       WHERE folio = $1 AND negocio_id = $2
         AND datos->>'repartidor_id' = $3
         AND estado NOT IN ('entregado','cancelado')
       RETURNING datos->>'entrega_estado' AS entrega_estado`,
      [folio, negocioId.trim(), String(repartidorId), nuevoEstado, tsCampo]
    );
    if (!r.rows[0]) return { ok: false, motivo: 'no_elegible' };
    return { ok: true, entregaEstado: r.rows[0].entrega_estado };
  } catch (e) {
    console.error('[DB] Error marcarEstadoEntrega:', e.message);
    return { ok: false, motivo: 'error' };
  }
}

// Transición TERMINAL de la entrega hecha por el repartidor: atómica y con
// dueño en el mismo UPDATE (asignación + no terminal), fija entregado_at
// solo la primera vez (mismo guard que la migración 036) y deja el
// sub-estado de entrega en 'entregado'. Devuelve los datos para el aviso
// al cliente; 0 filas => el llamador diagnostica (404/403/409/idempotente).
export async function marcarEntregadoRepartidor(folio, negocioId, repartidorId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  try {
    const r = await pool.query(
      `UPDATE pedidos_activos
       SET estado = 'entregado',
           entregado_at = COALESCE(entregado_at, NOW()),
           datos = jsonb_set(datos, '{entrega_estado}', '"entregado"'),
           updated_at = NOW()
       WHERE folio = $1 AND negocio_id = $2
         AND datos->>'repartidor_id' = $3
         AND estado NOT IN ('entregado','cancelado')
       RETURNING datos`,
      [folio, negocioId.trim(), String(repartidorId)]
    );
    return r.rows[0]?.datos || null;
  } catch (e) {
    console.error('[DB] Error marcarEntregadoRepartidor:', e.message);
    return null;
  }
}

// Incidencia operativa del repartidor sobre SU pedido: se anexa a
// datos.incidencias (auditoría dentro del propio pedido, sin migración) y
// jamás cambia estados ni reasigna -- la Central decide qué hacer.
const TIPOS_INCIDENCIA = ['direccion_no_encontrada', 'cliente_no_responde', 'pedido_no_listo', 'problema_cobro', 'vehiculo', 'otro'];
export async function registrarIncidenciaEntrega(folio, negocioId, repartidorId, tipo, detalle) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return { ok: false, motivo: 'sin_negocio' };
  if (!TIPOS_INCIDENCIA.includes(tipo)) return { ok: false, motivo: 'tipo_invalido' };
  const texto = typeof detalle === 'string' ? detalle.trim().slice(0, 300) : '';
  try {
    const r = await pool.query(
      `UPDATE pedidos_activos
       SET datos = jsonb_set(datos, '{incidencias}',
             COALESCE(datos->'incidencias', '[]'::jsonb) ||
             jsonb_build_object('tipo', $4::text, 'detalle', $5::text,
                                'repartidor_id', $3::text, 'at', NOW()::text)),
           updated_at = NOW()
       WHERE folio = $1 AND negocio_id = $2
         AND datos->>'repartidor_id' = $3
         AND estado != 'cancelado'
       RETURNING folio`,
      [folio, negocioId.trim(), String(repartidorId), tipo, texto]
    );
    if (!r.rows[0]) return { ok: false, motivo: 'no_elegible' };
    return { ok: true };
  } catch (e) {
    console.error('[DB] Error registrarIncidenciaEntrega:', e.message);
    return { ok: false, motivo: 'error' };
  }
}
export { TIPOS_INCIDENCIA };

// ─── Modo de conversación repartidor/cliente (migración 034) ────────────────
// Incidencia real: un teléfono registrado como repartidor quedaba
// interceptado permanentemente por el flujo de repartidor en
// whatsapp-meta.js, sin importar la intención real del mensaje. modo_actual
// permite que el mismo teléfono sea cliente Y repartidor sin que uno
// bloquee al otro -- ver enrutarMensajeEntrante en whatsapp-meta.js.
const MODOS_CONVERSACION_VALIDOS = ['cliente', 'repartidor', 'sin_modo'];

export async function actualizarModoConversacionRepartidor(repartidorId, modo) {
  if (!MODOS_CONVERSACION_VALIDOS.includes(modo)) {
    console.warn(`[DB] actualizarModoConversacionRepartidor: modo inválido "${modo}" -- rechazado`);
    return false;
  }
  try {
    await pool.query(
      `UPDATE repartidores SET modo_actual = $1, modo_actualizado_at = NOW() WHERE id = $2`,
      [modo, repartidorId]
    );
    return true;
  } catch (e) {
    console.error('[DB] Error actualizarModoConversacionRepartidor:', e.message);
    return false;
  }
}

// ─── Notificaciones a repartidores: registro de intentos y estado real ──────
// (Diagnóstico repartidores: Xabor daba por entregado un mensaje solo
// porque Meta aceptó la petición HTTP. Esta tabla registra cada intento y
// se actualiza con el estado real que Meta reporta después vía webhook.)
//
// negocioId OBLIGATORIO — mismo criterio fail-closed del resto del
// archivo: sin negocio no se registra nada.
export async function registrarNotificacionRepartidor({ negocioId, pedidoFolio, repartidorId, canal = 'plantilla', wamid = null, estado = 'pendiente', errorCodigo = null, errorDetalle = null, tokenAceptacion = null, tokenExpiraAt = null }) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    console.warn('[DB] registrarNotificacionRepartidor: negocioId inválido u omitido — rechazado');
    return null;
  }
  try {
    const r = await pool.query(
      `INSERT INTO notificaciones_repartidor
         (negocio_id, pedido_folio, repartidor_id, canal, wamid, estado, error_codigo, error_detalle, token_aceptacion, token_expira_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [negocioId, pedidoFolio, repartidorId, canal, wamid, estado, errorCodigo, errorDetalle, tokenAceptacion, tokenExpiraAt]
    );
    return r.rows[0];
  } catch (e) {
    console.error('[DB] Error registrarNotificacionRepartidor:', e.message);
    return null;
  }
}

// Idempotencia (rollout completo): un mismo pedido nunca debe generar más
// de un intento de notificación por repartidor -- guard de aplicación
// antes de enviar, no una UNIQUE de base de datos, porque intento_numero
// ya está pensado para soportar reintentos legítimos más adelante (un
// UNIQUE(pedido_folio, repartidor_id) los bloquearía por diseño).
export async function existeNotificacionRepartidor(pedidoFolio, repartidorId) {
  try {
    const r = await pool.query(
      `SELECT EXISTS(SELECT 1 FROM notificaciones_repartidor WHERE pedido_folio = $1 AND repartidor_id = $2) AS existe`,
      [pedidoFolio, repartidorId]
    );
    return r.rows[0].existe;
  } catch (e) {
    console.error('[DB] Error existeNotificacionRepartidor:', e.message);
    return false;
  }
}

// Consumo atómico de un solo uso: el UPDATE con el guard en la propia
// cláusula WHERE (token_usado_at IS NULL AND no vencido) es lo que
// garantiza que un mismo token nunca se pueda consumir dos veces, sin
// importar cuántas peticiones concurrentes lleguen (dos clics al mismo
// tiempo, el enlace reenviado y abierto por dos personas, etc.) -- exactamente
// el mismo patrón ya usado en asignarRepartidor.
export async function consumirTokenAceptacionRepartidor(token) {
  if (!token) return null;
  try {
    const r = await pool.query(
      `UPDATE notificaciones_repartidor
       SET token_usado_at = NOW()
       WHERE token_aceptacion = $1
         AND token_usado_at IS NULL
         AND token_expira_at > NOW()
       RETURNING *`,
      [token]
    );
    return r.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error consumirTokenAceptacionRepartidor:', e.message);
    return null;
  }
}

// Consulta de SOLO LECTURA de una oferta por token (hotfix
// oferta-repartidor): a diferencia de consumirTokenAceptacionRepartidor,
// NUNCA marca el token como usado -- alimenta la pantalla de revisión que
// el repartidor abre desde el enlace, que ahora se puede abrir/recargar
// cuantas veces sea sin quemar la oferta. Trae el estado real del pedido y
// a quién quedó asignado (id + nombre legible) para poder distinguir
// disponible / asignado a mí / cubierto por otro / cancelado / entregado.
export async function obtenerOfertaPorToken(token) {
  if (!token) return null;
  try {
    const r = await pool.query(
      `SELECT nr.negocio_id, nr.pedido_folio, nr.repartidor_id,
              nr.token_usado_at, nr.token_expira_at, nr.created_at,
              pa.estado AS pedido_estado,
              pa.datos->>'repartidor_id'     AS asignado_id,
              pa.datos->>'repartidor_nombre' AS asignado_nombre,
              pa.datos->'cliente'->>'calle'   AS calle,
              pa.datos->'cliente'->>'colonia' AS colonia,
              pa.datos->>'total'              AS total,
              n.nombre AS negocio_nombre
       FROM notificaciones_repartidor nr
       LEFT JOIN pedidos_activos pa ON pa.folio = nr.pedido_folio AND pa.negocio_id = nr.negocio_id
       LEFT JOIN negocios n ON n.id = nr.negocio_id
       WHERE nr.token_aceptacion = $1`,
      [token]
    );
    return r.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error obtenerOfertaPorToken:', e.message);
    return null;
  }
}

export async function obtenerNombreNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  try {
    const r = await pool.query('SELECT nombre FROM negocios WHERE id = $1', [negocioId]);
    return r.rows[0]?.nombre || null;
  } catch (e) { return null; }
}

// Orden de avance esperado de un envío real: aceptado_meta -> entregado ->
// leido. 'fallido' se acepta siempre, sin importar el estado anterior,
// porque Meta puede reportar una falla en cualquier punto y es la señal
// más importante para no perder. El único caso que se ignora es un
// retroceso fuera de orden (p.ej. llega 'entregado' después de 'leido' por
// reordenamiento de red) -- se descarta en vez de pisar un estado más
// avanzado con uno más viejo.
const ORDEN_ESTADO_NOTIFICACION = ['pendiente', 'aceptado_meta', 'entregado', 'leido'];

export async function actualizarEstadoNotificacionPorWamid(wamid, nuevoEstado, { errorCodigo = null, errorDetalle = null } = {}) {
  if (!wamid) return null;
  try {
    if (nuevoEstado === 'fallido') {
      const r = await pool.query(
        `UPDATE notificaciones_repartidor
         SET estado = 'fallido', error_codigo = $2, error_detalle = $3
         WHERE wamid = $1
         RETURNING *`,
        [wamid, errorCodigo, errorDetalle]
      );
      return r.rows[0] || null;
    }
    const rango = ORDEN_ESTADO_NOTIFICACION.indexOf(nuevoEstado);
    if (rango < 0) return null;
    const r = await pool.query(
      `UPDATE notificaciones_repartidor
       SET estado = $2
       WHERE wamid = $1
         AND estado != 'fallido'
         AND array_position($3::text[], estado) <= $4
       RETURNING *`,
      [wamid, nuevoEstado, ORDEN_ESTADO_NOTIFICACION, rango]
    );
    return r.rows[0] || null;
  } catch (e) {
    console.error('[DB] Error actualizarEstadoNotificacionPorWamid:', e.message);
    return null;
  }
}

// Fase C (tiempo real): ¿este pedido está AHORA "sin cobertura"? Mismo
// criterio que derivarEstadoServicioReparto (obtenerServiciosReparto) --
// todos los intentos de notificación fallaron y todavía no hay repartidor
// asignado -- expuesto aparte para que el webhook de status pueda decidir
// si dispara el evento red_repartidores_sin_cobertura justo cuando el
// ÚLTIMO intento pendiente se marca fallido, sin duplicar la lógica de
// agregación en dos lugares.
export async function esPedidoSinCoberturaAhora(pedidoFolio) {
  if (!pedidoFolio) return false;
  try {
    const { rows: [pedido] } = await pool.query(
      `SELECT estado, datos->>'repartidor_id' AS repartidor_id FROM pedidos_activos WHERE folio = $1`,
      [pedidoFolio]
    );
    if (!pedido || pedido.repartidor_id || ['entregado', 'cancelado'].includes(pedido.estado)) return false;
    const { rows: [agg] } = await pool.query(
      `SELECT COUNT(*)::int AS intentos,
              COUNT(*) FILTER (WHERE estado IN ('fallido', 'error_envio'))::int AS fallidos
       FROM notificaciones_repartidor WHERE pedido_folio = $1`,
      [pedidoFolio]
    );
    return agg.intentos > 0 && agg.fallidos === agg.intentos;
  } catch (e) {
    console.error('[DB] Error esPedidoSinCoberturaAhora:', e.message);
    return false;
  }
}

// negocioId OBLIGATORIO — falla cerrado, mismo criterio del resto del
// archivo. Uso: panel/diagnóstico, nunca expone datos de otro negocio.
export async function obtenerNotificacionesPedido(pedidoFolio, negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return [];
  try {
    const r = await pool.query(
      `SELECT n.*, r.nombre AS repartidor_nombre
       FROM notificaciones_repartidor n
       JOIN repartidores r ON r.id = n.repartidor_id
       WHERE n.pedido_folio = $1 AND n.negocio_id = $2
       ORDER BY n.created_at ASC`,
      [pedidoFolio, negocioId]
    );
    return r.rows;
  } catch (e) { return []; }
}

// ─── Red de Repartidores — Superadmin (Fase B mínima: servicios de reparto) ─
// negocioId OPCIONAL a propósito (ver nota junto a cambiarEstadoRepartidor):
// Superadmin ve todos los negocios, negocio-admin siempre pasa el suyo desde
// la sesión. Nunca se guarda ningún estado nuevo aquí — todo se DERIVA de
// pedidos_activos + notificaciones_repartidor en el momento de la consulta.
//
// Exclusión de Rappi: se reutiliza esPedidoDeRedExterna (misma fuente que
// esPedidoElegibleParaRedRepartidores, usada por la notificación real) sobre
// un objeto reconstruido de campos de datos JSONB — nunca se reimplementa el
// criterio con SQL aparte. Los pedidos de Rappi se separan a `externas`,
// jamás se cuentan en la lista principal ni en sus agregados.
function derivarEstadoServicioReparto(row, tieneAsignado) {
  if (row.estado === 'cancelado') return 'cancelado';
  if (row.estado === 'entregado') return 'entregado';
  if (tieneAsignado) return 'asignado';
  const intentos = Number(row.intentos) || 0;
  if (intentos > 0 && Number(row.failed) === intentos) return 'sin_cobertura';
  return 'buscando';
}

export async function obtenerServiciosReparto({
  negocioId = null,
  desde = null,
  hasta = null,
  page = 1,
  pageSize = 50,
} = {}) {
  try {
    const condiciones = [`datos->>'modalidad' = 'entrega a domicilio'`];
    const params = [];
    if (negocioId) { params.push(negocioId); condiciones.push(`negocio_id = $${params.length}`); }
    if (desde) { params.push(desde); condiciones.push(`created_at >= $${params.length}`); }
    if (hasta) { params.push(hasta); condiciones.push(`created_at <= $${params.length}`); }

    const r = await pool.query(`
      SELECT pa.folio, pa.negocio_id, pa.estado, pa.created_at, pa.datos, n.nombre AS negocio_nombre,
        COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio), 0)::int AS intentos,
        COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.estado IN ('entregado', 'leido')), 0)::int AS delivered,
        COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.estado = 'leido'), 0)::int AS leido,
        COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.estado IN ('fallido', 'error_envio')), 0)::int AS failed,
        (SELECT MIN(nr.token_usado_at) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.token_usado_at IS NOT NULL) AS hora_aceptacion
      FROM pedidos_activos pa
      LEFT JOIN negocios n ON n.id = pa.negocio_id
      WHERE ${condiciones.join(' AND ')}
      ORDER BY pa.created_at DESC
      LIMIT ${Number(pageSize)} OFFSET ${Number((page - 1) * pageSize)}
    `, params);

    const redXabor = [];
    const externas = [];
    for (const row of r.rows) {
      const pedidoShape = {
        modalidad: row.datos?.modalidad,
        canal: row.datos?.canal,
        rappi_order_id: row.datos?.rappi_order_id,
        repartidor_externo: row.datos?.repartidor_externo,
        integracion_externa: row.datos?.integracion_externa,
      };
      if (esPedidoDeRedExterna(pedidoShape)) {
        externas.push({
          folio: row.folio, negocioId: row.negocio_id, negocioNombre: row.negocio_nombre, fecha: row.created_at,
          monto: row.datos?.total, etiqueta: 'Entrega gestionada por Rappi',
        });
        continue;
      }
      const asignado = row.datos?.repartidor_id
        ? { id: row.datos.repartidor_id, nombre: row.datos.repartidor_nombre || null }
        : null;
      redXabor.push({
        folio: row.folio,
        negocioId: row.negocio_id,
        negocioNombre: row.negocio_nombre,
        fecha: row.created_at,
        monto: row.datos?.total,
        estadoDerivado: derivarEstadoServicioReparto(row, !!asignado),
        // En esta fase mínima "elegibles notificados" se aproxima al número
        // real de intentos generados (a quién se le envió) -- un conteo de
        // "quién pudo ser elegible en ese momento" requeriría una foto
        // histórica del roster que hoy no se captura; fuera de alcance de
        // Fase B mínima.
        intentosNotificados: row.intentos,
        delivered: row.delivered,
        leido: row.leido,
        failed: row.failed,
        repartidorAsignado: asignado,
        horaAceptacion: row.hora_aceptacion,
      });
    }
    return { redXabor, externas, page, pageSize };
  } catch (e) {
    console.error('[DB] Error obtenerServiciosReparto:', e.message);
    return { redXabor: [], externas: [], page, pageSize };
  }
}

// Detalle básico de un servicio: pedido + lista de repartidores realmente
// notificados con su estado real (Meta) y si aceptaron. NO incluye una
// línea de tiempo visual avanzada ni "motivo de exclusión" para
// repartidores que nunca llegaron a generar una fila aquí (p.ej. excluidos
// por no estar en la whitelist en modo piloto) -- eso requeriría capturar
// las exclusiones en el momento de decidir, algo que hoy solo se loguea a
// consola; queda fuera de esta Fase B mínima, documentado como límite
// conocido.
export async function obtenerDetalleServicioReparto(folio, negocioId = null) {
  try {
    const wherePedido = negocioId ? 'folio = $1 AND negocio_id = $2' : 'folio = $1';
    const paramsPedido = negocioId ? [folio, negocioId] : [folio];
    const { rows: pedidoRows } = await pool.query(
      `SELECT folio, negocio_id, estado, created_at, datos FROM pedidos_activos WHERE ${wherePedido}`,
      paramsPedido
    );
    const pedido = pedidoRows[0];
    if (!pedido) return null;

    const { rows: notificados } = await pool.query(`
      SELECT nr.id, nr.repartidor_id, r.nombre, r.telefono, nr.canal, nr.estado, nr.wamid,
        nr.error_codigo, nr.error_detalle, nr.created_at, nr.updated_at, nr.token_usado_at
      FROM notificaciones_repartidor nr
      JOIN repartidores r ON r.id = nr.repartidor_id
      WHERE nr.pedido_folio = $1 AND nr.negocio_id = $2
      ORDER BY nr.created_at ASC
    `, [pedido.folio, pedido.negocio_id]);

    return {
      folio: pedido.folio,
      negocioId: pedido.negocio_id,
      estado: pedido.estado,
      creadoEn: pedido.created_at,
      repartidorAsignado: pedido.datos?.repartidor_id
        ? { id: pedido.datos.repartidor_id, nombre: pedido.datos.repartidor_nombre || null }
        : null,
      notificados: notificados.map((n) => ({
        repartidorId: n.repartidor_id,
        nombre: n.nombre,
        telefonoOculto: n.telefono ? `...${n.telefono.slice(-4)}` : null,
        canal: n.canal,
        estado: n.estado,
        wamid: n.wamid,
        error: (n.error_codigo || n.error_detalle) ? `${n.error_codigo || ''} ${n.error_detalle || ''}`.trim() : null,
        creadoEn: n.created_at,
        actualizadoEn: n.updated_at,
        acepto: !!n.token_usado_at,
      })),
    };
  } catch (e) {
    console.error('[DB] Error obtenerDetalleServicioReparto:', e.message);
    return null;
  }
}

// ─── Red de Repartidores — Fase D: Métricas y ranking ──────────────────────
// Decisiones funcionales ya aprobadas por el propietario (ver
// docs/plan-fase-d-metricas-ranking.md):
//   - "sin cobertura" reutiliza EXACTAMENTE derivarEstadoServicioReparto
//     (mismo criterio que ya usa obtenerServiciosReparto y el evento WS
//     red_repartidores_sin_cobertura -- nunca una segunda implementación).
//   - "rechazado" no existe como concepto en el sistema (ningún repartidor
//     puede ejecutar un rechazo explícito hoy) -- se reporta como `null`,
//     NUNCA como 0, para no insinuar "cero rechazos" cuando en realidad es
//     "no medible todavía". Ver docs/plan-fase-d-metricas-ranking.md
//     decisión #2.
//   - "ignorado" = la oferta se registró (fila en notificaciones_repartidor)
//     y su token ya venció sin haberse usado y sin haber fallado el envío.
//   - Exclusión de Rappi: reutiliza esPedidoDeRedExterna, igual que
//     obtenerServiciosReparto -- nunca un criterio SQL paralelo.
//   - Ranking: umbral de muestra mínima 10 ofrecidos / 5 entregados
//     (aprobado explícitamente); repartidores por debajo van a "muestra
//     insuficiente"; suspendido/baja van a su propio grupo, sin importar
//     su volumen.
//   - Ningún dato histórico se modifica aquí -- todo se deriva en el
//     momento de la consulta, igual que el resto del módulo.

const UMBRAL_RANKING_OFRECIDOS = 10;
const UMBRAL_RANKING_ENTREGADOS = 5;
// Ventana de referencia para normalizar "velocidad de aceptación" en el
// score -- reutiliza el mismo valor ya usado como expiración del token de
// aceptación (TOKEN_EXPIRACION_MINUTOS en whatsapp-meta.js), no un número
// arbitrario nuevo.
const VENTANA_RESPUESTA_SEG = 30 * 60;
// Tamaño de muestra a partir del cual el factor de confianza del score deja
// de crecer (3x el umbral mínimo de "ofrecidos") -- evita que el volumen por
// sí solo siga inflando el score indefinidamente, sin excluir a quien apenas
// cumple el mínimo.
const MUESTRA_CONFIANZA_PLENA = UMBRAL_RANKING_OFRECIDOS * 3;

function construirCondicionesPeriodo({ negocioId, desde, hasta }, alias, params, condiciones) {
  if (negocioId) { params.push(negocioId); condiciones.push(`${alias}.negocio_id = $${params.length}`); }
  if (desde) { params.push(desde); condiciones.push(`${alias}.created_at >= $${params.length}`); }
  if (hasta) { params.push(hasta); condiciones.push(`${alias}.created_at <= $${params.length}`); }
}

// Trae todos los pedidos de "entrega a domicilio" del período/negocio, ya
// separados en redXabor/externas (mismo criterio de exclusión de Rappi que
// obtenerServiciosReparto) -- función interna, reutilizada por las tres
// funciones públicas de esta sección para no triplicar la misma consulta.
async function _pedidosRedRepartoEnPeriodo({ negocioId = null, desde = null, hasta = null } = {}) {
  const condiciones = [`datos->>'modalidad' = 'entrega a domicilio'`];
  const params = [];
  construirCondicionesPeriodo({ negocioId, desde, hasta }, 'pa', params, condiciones);

  const r = await pool.query(`
    SELECT pa.folio, pa.negocio_id, pa.estado, pa.created_at, pa.entregado_at, pa.datos,
      COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio), 0)::int AS intentos,
      COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.estado IN ('entregado', 'leido')), 0)::int AS delivered,
      COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.estado = 'leido'), 0)::int AS leido,
      COALESCE((SELECT COUNT(*) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.estado IN ('fallido', 'error_envio')), 0)::int AS failed,
      (SELECT MIN(nr.token_usado_at) FROM notificaciones_repartidor nr WHERE nr.pedido_folio = pa.folio AND nr.token_usado_at IS NOT NULL) AS hora_aceptacion
    FROM pedidos_activos pa
    WHERE ${condiciones.join(' AND ')}
  `, params);

  const redXabor = [];
  const externas = [];
  for (const row of r.rows) {
    const pedidoShape = {
      modalidad: row.datos?.modalidad,
      canal: row.datos?.canal,
      rappi_order_id: row.datos?.rappi_order_id,
      repartidor_externo: row.datos?.repartidor_externo,
      integracion_externa: row.datos?.integracion_externa,
    };
    if (esPedidoDeRedExterna(pedidoShape)) { externas.push(row); continue; }
    redXabor.push(row);
  }
  return { redXabor, externas };
}

function _promedioSegundos(pares) {
  // pares: array de [inicio, fin] (Date|string|null) -- ignora cualquier par
  // incompleto en vez de tratarlo como 0 (evita sesgar el promedio a la
  // baja con datos faltantes, p. ej. entregas sin entregado_at histórico).
  const validos = pares
    .filter(([a, b]) => a && b)
    .map(([a, b]) => (new Date(b).getTime() - new Date(a).getTime()) / 1000)
    .filter((seg) => Number.isFinite(seg) && seg >= 0);
  if (validos.length === 0) return null;
  return validos.reduce((s, v) => s + v, 0) / validos.length;
}

function _tasa(numerador, denominador) {
  // Nunca división entre cero: sin denominador, la tasa es "no disponible"
  // (null), nunca 0 (0 insinuaría "0% de éxito" en vez de "sin datos").
  if (!denominador) return null;
  return numerador / denominador;
}

export async function obtenerMetricasRedRepartidores({
  negocioId = null,
  ciudad = null,
  zona = null,
  repartidorId = null,
  desde = null,
  hasta = null,
} = {}) {
  try {
    const { redXabor, externas } = await _pedidosRedRepartoEnPeriodo({ negocioId, desde, hasta });

    // Filtro opcional por repartidor (solo afecta a los pedidos donde ese
    // repartidor participó, ya sea notificado o asignado) -- ciudad/zona se
    // aplican más abajo, sobre el propio repartidor, no sobre el pedido (el
    // pedido no tiene una ciudad/zona estructurada propia, ver plan de Fase D).
    let foliosDeRepartidor = null;
    if (repartidorId) {
      const { rows } = await pool.query(
        `SELECT DISTINCT pedido_folio FROM notificaciones_repartidor WHERE repartidor_id = $1`,
        [repartidorId]
      );
      foliosDeRepartidor = new Set(rows.map(r => r.pedido_folio));
    }

    let ciudadZonaFolios = null;
    if (ciudad || zona) {
      const cond = [];
      const params = [];
      if (ciudad) { params.push(ciudad); cond.push(`ciudad = $${params.length}`); }
      if (zona) { params.push(zona); cond.push(`zona = $${params.length}`); }
      const { rows: repsFiltrados } = await pool.query(
        `SELECT id FROM repartidores WHERE ${cond.join(' AND ')}`, params
      );
      const idsFiltrados = new Set(repsFiltrados.map(r => String(r.id)));
      const { rows: notifs } = await pool.query(`SELECT DISTINCT pedido_folio, repartidor_id FROM notificaciones_repartidor`);
      ciudadZonaFolios = new Set(notifs.filter(n => idsFiltrados.has(String(n.repartidor_id))).map(n => n.pedido_folio));
    }

    const pedidosFiltrados = redXabor.filter(row => {
      if (foliosDeRepartidor && !foliosDeRepartidor.has(row.folio)) return false;
      if (ciudadZonaFolios && !ciudadZonaFolios.has(row.folio)) return false;
      return true;
    });

    // Corrección D.1 -- causa raíz confirmada (ver
    // docs/correccion-d1-universos-metricas.md): la definición anterior de
    // "servicios entregados" contaba CUALQUIER pedido de entrega a domicilio
    // (no-Rappi) en estado 'entregado', sin exigir evidencia de que la
    // entrega la hizo la Red de Repartidores -- mezclando entregas
    // manuales/presenciales/históricas (nunca ofrecidas ni aceptadas por un
    // repartidor) con las realmente gestionadas por la red. Eso producía
    // denominadores/numeradores de universos distintos (p. ej. 35 entregados
    // "de cualquier tipo" contra apenas 2 aceptados por la red = 1750%).
    //
    // `asignadoPorRed(row)` es la ÚNICA señal confiable de que un pedido fue
    // realmente asignado a través del flujo de la red (asignarRepartidor,
    // vía aceptación de token) -- se reutiliza tal cual la usa
    // derivarEstadoServicioReparto, nunca un criterio nuevo en paralelo.
    const asignadoPorRed = (row) => !!row.datos?.repartidor_id;

    const serviciosRedCreados = pedidosFiltrados.length;
    const serviciosRedOfrecidos = pedidosFiltrados.filter(r => r.intentos > 0).length;
    const serviciosRedAceptados = pedidosFiltrados.filter(r => r.hora_aceptacion).length;
    // Entregado Y asignado por la red -- nunca solo "estado=entregado".
    const serviciosRedEntregados = pedidosFiltrados.filter(r => r.estado === 'entregado' && asignadoPorRed(r)).length;
    // Entregado pero SIN evidencia de asignación por la red (ni Rappi, ya
    // excluido antes) -- entrega manual/presencial/histórica no comparable.
    const entregasManuales = pedidosFiltrados.filter(r => r.estado === 'entregado' && !asignadoPorRed(r)).length;
    const serviciosRedCancelados = pedidosFiltrados.filter(r => r.estado === 'cancelado').length;
    const serviciosRedSinCobertura = pedidosFiltrados.filter(r => {
      return derivarEstadoServicioReparto(r, asignadoPorRed(r)) === 'sin_cobertura';
    }).length;
    // Advertencia de datos históricos: si algún servicio del universo nunca
    // generó ni un solo intento de notificación, es anterior a la ventana de
    // instrumentación real (ver migración 032) -- nunca se asume "sin
    // actividad", se marca explícitamente como no comparable.
    const hayServiciosSinInstrumentar = pedidosFiltrados.some(r => r.intentos === 0);

    // Universo más amplio: TODOS los pedidos del período/negocio, sin filtrar
    // por modalidad -- puramente informativo, nunca se usa como denominador
    // de ninguna tasa de la red.
    let pedidosCreados = 0;
    {
      const condTodos = [];
      const paramsTodos = [];
      construirCondicionesPeriodo({ negocioId, desde, hasta }, 'pa', paramsTodos, condTodos);
      const { rows: totalRows } = await pool.query(
        `SELECT COUNT(*)::int AS total FROM pedidos_activos pa${condTodos.length ? ' WHERE ' + condTodos.join(' AND ') : ''}`,
        paramsTodos
      );
      pedidosCreados = totalRows[0]?.total || 0;
    }

    // Tiempos: ya acotados correctamente -- solo pedidos con hora_aceptacion
    // (es decir, aceptados por la red), nunca entregas manuales/externas.
    const tiempoPromedioAceptacionSeg = _promedioSegundos(
      pedidosFiltrados.filter(r => r.hora_aceptacion).map(r => [r.created_at, r.hora_aceptacion])
    );
    const tiempoPromedioEntregaSeg = _promedioSegundos(
      pedidosFiltrados.filter(r => r.hora_aceptacion && r.entregado_at).map(r => [r.hora_aceptacion, r.entregado_at])
    );

    const foliosEnScope = pedidosFiltrados.map(r => r.folio);
    let repartidoresNotificados = 0;
    if (foliosEnScope.length > 0) {
      const { rows } = await pool.query(
        `SELECT COUNT(DISTINCT repartidor_id)::int AS total FROM notificaciones_repartidor WHERE pedido_folio = ANY($1::text[])`,
        [foliosEnScope]
      );
      repartidoresNotificados = rows[0]?.total || 0;
    }

    // Embudo de notificaciones -- a nivel de intento/destinatario individual,
    // NUNCA de pedido/servicio (un mismo servicio puede notificar a varios
    // repartidores) -- por eso nunca se usan estas cifras como numerador o
    // denominador de una tasa "por servicio" (tasaAceptacion/coberturaRed
    // usan exclusivamente los conteos de pedidosFiltrados, no de esta tabla).
    let embudo = {
      intentados: 0, entregadosWA: 0, leidos: 0, fallidos: 0, aceptados: 0, ignorados: 0, rechazados: null,
      tasaEntregaNotif: null, tasaLecturaNotif: null, tasaFalloNotif: null,
    };
    if (foliosEnScope.length > 0) {
      const { rows: filas } = await pool.query(
        `SELECT estado, token_usado_at, token_expira_at FROM notificaciones_repartidor WHERE pedido_folio = ANY($1::text[])`,
        [foliosEnScope]
      );
      embudo.intentados = filas.length;
      embudo.entregadosWA = filas.filter(f => f.estado === 'entregado' || f.estado === 'leido').length;
      embudo.leidos = filas.filter(f => f.estado === 'leido').length;
      embudo.fallidos = filas.filter(f => f.estado === 'fallido' || f.estado === 'error_envio').length;
      embudo.aceptados = filas.filter(f => f.token_usado_at).length;
      embudo.ignorados = filas.filter(f =>
        !f.token_usado_at &&
        f.estado !== 'fallido' && f.estado !== 'error_envio' &&
        f.token_expira_at && new Date(f.token_expira_at).getTime() < Date.now()
      ).length;
      // rechazados: permanece `null` a propósito -- no existe mecanismo de
      // rechazo explícito en el sistema (ver comentario de sección arriba).
      embudo.tasaEntregaNotif = _tasa(embudo.entregadosWA, embudo.intentados);
      embudo.tasaLecturaNotif = _tasa(embudo.leidos, embudo.entregadosWA);
      embudo.tasaFalloNotif = _tasa(embudo.fallidos, embudo.intentados);
    }

    const porNegocio = negocioId ? null : await (async () => {
      const grupos = new Map();
      for (const row of redXabor) {
        if (!grupos.has(row.negocio_id)) grupos.set(row.negocio_id, []);
        grupos.get(row.negocio_id).push(row);
      }
      const ids = [...grupos.keys()];
      let nombresPorId = new Map();
      if (ids.length > 0) {
        const { rows: negs } = await pool.query(
          `SELECT id, nombre FROM negocios WHERE id = ANY($1::uuid[])`, [ids]
        );
        nombresPorId = new Map(negs.map(n => [n.id, n.nombre]));
      }
      return [...grupos.entries()].map(([id, filas]) => {
        const aceptados = filas.filter(f => f.hora_aceptacion).length;
        return {
          negocioId: id,
          // Nombre legible para mostrar -- el UUID se conserva en negocioId
          // como identificador interno, nunca como etiqueta principal.
          negocioNombre: nombresPorId.get(id) || 'Negocio sin nombre',
          serviciosRedCreados: filas.length,
          serviciosRedEntregados: filas.filter(f => f.estado === 'entregado' && !!f.datos?.repartidor_id).length,
          entregasManuales: filas.filter(f => f.estado === 'entregado' && !f.datos?.repartidor_id).length,
          sinCobertura: filas.filter(f => derivarEstadoServicioReparto(f, !!f.datos?.repartidor_id) === 'sin_cobertura').length,
          coberturaRed: _tasa(aceptados, filas.length),
          tiempoPromedioAsignacionSeg: _promedioSegundos(filas.filter(f => f.hora_aceptacion).map(f => [f.created_at, f.hora_aceptacion])),
        };
      });
    })();

    // Ciudad/zona: SOLO sobre metadata real del repartidor -- nunca "—"
    // como valor válido; todo lo sin capturar cae en un único bucket
    // explícito "Sin ciudad o zona registrada" (nunca se inventa un valor).
    const { rows: repsParaGeo } = await pool.query(
      negocioId ? `SELECT id, ciudad, zona FROM repartidores WHERE negocio_id = $1` : `SELECT id, ciudad, zona FROM repartidores`,
      negocioId ? [negocioId] : []
    );
    const geoPorId = new Map(repsParaGeo.map(r => [String(r.id), r]));
    const { rows: notifsGeo } = await pool.query(
      foliosEnScope.length > 0
        ? `SELECT DISTINCT pedido_folio, repartidor_id FROM notificaciones_repartidor WHERE pedido_folio = ANY($1::text[])`
        : `SELECT DISTINCT pedido_folio, repartidor_id FROM notificaciones_repartidor WHERE FALSE`,
      foliosEnScope.length > 0 ? [foliosEnScope] : []
    );
    const gruposGeo = new Map();
    for (const n of notifsGeo) {
      const rep = geoPorId.get(String(n.repartidor_id));
      const clave = (rep?.ciudad || rep?.zona) ? `${rep.ciudad || ''}|${rep.zona || ''}` : 'SIN_REGISTRAR';
      if (!gruposGeo.has(clave)) gruposGeo.set(clave, { ciudad: rep?.ciudad || null, zona: rep?.zona || null, folios: new Set() });
      gruposGeo.get(clave).folios.add(n.pedido_folio);
    }
    const porCiudadZona = [...gruposGeo.entries()].map(([clave, info]) => ({
      etiqueta: clave === 'SIN_REGISTRAR' ? 'Sin ciudad o zona registrada' : `${info.ciudad || '(sin ciudad)'} / ${info.zona || '(sin zona)'}`,
      ciudad: info.ciudad,
      zona: info.zona,
      servicios: info.folios.size,
    }));

    return {
      tarjetas: {
        pedidosCreados,
        serviciosRedCreados,
        serviciosRedOfrecidos,
        repartidoresNotificados,
        serviciosRedAceptados,
        serviciosRedEntregados,
        entregasExternas: externas.length,
        entregasManuales,
        serviciosRedCancelados,
        serviciosRedSinCobertura,
        // Tasa de aceptación: de lo que SÍ se ofreció a la red, cuánto aceptó
        // un repartidor. Nunca 0% engañoso -- null si no hubo ofrecidos.
        tasaAceptacion: _tasa(serviciosRedAceptados, serviciosRedOfrecidos),
        // Tasa de finalización de la red: de lo aceptado por un repartidor,
        // cuánto se completó -- SOLO servicios propios y comparables (nunca
        // incluye entregas manuales/externas/históricas sin evidencia).
        tasaFinalizacionRed: _tasa(serviciosRedEntregados, serviciosRedAceptados),
        // Cobertura de la red: de todo lo creado para la red, cuánto llegó a
        // tener un repartidor asignado (fórmula pedida explícitamente).
        coberturaRed: _tasa(serviciosRedAceptados, serviciosRedCreados),
        tiempoPromedioAceptacionSeg,
        tiempoPromedioEntregaSeg,
      },
      avisos: {
        // Nunca se inventa ni reconstruye historia -- solo se advierte que
        // el período incluye servicios sin ningún intento de notificación
        // registrado (anteriores a la instrumentación real, migración 032).
        datosHistoricosIncompletos: hayServiciosSinInstrumentar,
        mensaje: hayServiciosSinInstrumentar
          ? 'Las métricas históricas pueden estar incompletas para pedidos anteriores al registro detallado de notificaciones y entregas.'
          : null,
      },
      embudo,
      porNegocio,
      porCiudadZona,
      externas: {
        total: externas.length,
        nota: 'Entregas gestionadas por plataformas externas (p. ej. Rappi) -- nunca incluidas en las tarjetas, embudo ni ranking de la red propia.',
      },
    };
  } catch (e) {
    console.error('[DB] Error obtenerMetricasRedRepartidores:', e.message);
    return null;
  }
}

export async function obtenerRankingRepartidores({
  negocioId = null,
  ciudad = null,
  zona = null,
  desde = null,
  hasta = null,
} = {}) {
  try {
    const condRep = [];
    const paramsRep = [];
    if (negocioId) { paramsRep.push(negocioId); condRep.push(`negocio_id = $${paramsRep.length}`); }
    if (ciudad) { paramsRep.push(ciudad); condRep.push(`ciudad = $${paramsRep.length}`); }
    if (zona) { paramsRep.push(zona); condRep.push(`zona = $${paramsRep.length}`); }
    const { rows: repartidores } = await pool.query(
      `SELECT id, nombre, telefono, negocio_id, estado, ciudad, zona FROM repartidores${condRep.length ? ' WHERE ' + condRep.join(' AND ') : ''}`,
      paramsRep
    );
    if (repartidores.length === 0) return { rankingElegible: [], muestraInsuficiente: [], suspendidosOBaja: [] };

    // Nombre legible del negocio -- el UUID (negocioId) se conserva como
    // identificador interno, nunca como etiqueta principal en la UI/CSV.
    const idsNegociosRanking = [...new Set(repartidores.map(r => r.negocio_id))];
    const { rows: negociosRanking } = await pool.query(
      `SELECT id, nombre FROM negocios WHERE id = ANY($1::uuid[])`, [idsNegociosRanking]
    );
    const nombreNegocioPorId = new Map(negociosRanking.map(n => [n.id, n.nombre]));

    // Duplicados (mismo teléfono normalizado, mismo negocio) -- solo para
    // marcar una advertencia visible, NUNCA para fusionar ni combinar cifras
    // (ver docs/plan-calidad-datos-repartidores.md).
    const dupNegocios = new Set(repartidores.map(r => r.negocio_id));
    const dupPorNegocio = new Map();
    for (const n of dupNegocios) {
      dupPorNegocio.set(n, await detectarDuplicadosRepartidor(n));
    }
    function esPosibleDuplicado(rep) {
      const grupos = dupPorNegocio.get(rep.negocio_id) || [];
      return grupos.some(g => g.filas.some(f => f.id === rep.id));
    }

    const condPeriodo = [];
    const paramsPeriodo = [];
    if (desde) { paramsPeriodo.push(desde); condPeriodo.push(`nr.created_at >= $${paramsPeriodo.length}`); }
    if (hasta) { paramsPeriodo.push(hasta); condPeriodo.push(`nr.created_at <= $${paramsPeriodo.length}`); }
    const wherePeriodo = condPeriodo.length ? ' AND ' + condPeriodo.join(' AND ') : '';

    const resultado = [];
    for (const rep of repartidores) {
      const { rows: notifs } = await pool.query(
        `SELECT nr.pedido_folio, nr.estado, nr.token_usado_at, nr.token_expira_at, nr.created_at
         FROM notificaciones_repartidor nr WHERE nr.repartidor_id = $1 ${wherePeriodo}`,
        [rep.id, ...paramsPeriodo]
      );
      const foliosOfrecidos = new Set(notifs.map(n => n.pedido_folio));
      const foliosAceptados = new Set(notifs.filter(n => n.token_usado_at).map(n => n.pedido_folio));
      const ignorados = notifs.filter(n =>
        !n.token_usado_at && n.estado !== 'fallido' && n.estado !== 'error_envio' &&
        n.token_expira_at && new Date(n.token_expira_at).getTime() < Date.now()
      ).length;

      let entregados = 0, cancelados = 0, ultimaEntrega = null;
      if (foliosAceptados.size > 0) {
        const condPed = [`datos->>'repartidor_id' = $1`];
        const paramsPed = [String(rep.id)];
        if (desde) { paramsPed.push(desde); condPed.push(`created_at >= $${paramsPed.length}`); }
        if (hasta) { paramsPed.push(hasta); condPed.push(`created_at <= $${paramsPed.length}`); }
        const { rows: pedidosRep } = await pool.query(
          `SELECT folio, estado, entregado_at FROM pedidos_activos WHERE ${condPed.join(' AND ')}`,
          paramsPed
        );
        entregados = pedidosRep.filter(p => p.estado === 'entregado').length;
        cancelados = pedidosRep.filter(p => p.estado === 'cancelado').length;
        const entregas = pedidosRep.filter(p => p.entregado_at).map(p => p.entregado_at);
        if (entregas.length) ultimaEntrega = entregas.reduce((a, b) => (new Date(b) > new Date(a) ? b : a));
      }

      const tiempoPromedioAceptacionSeg = _promedioSegundos(
        notifs.filter(n => n.token_usado_at).map(n => [n.created_at, n.token_usado_at])
      );
      const ultimaNotif = notifs.length ? notifs.map(n => n.created_at).reduce((a, b) => (new Date(b) > new Date(a) ? b : a)) : null;
      const ultimaActividad = [ultimaNotif, ultimaEntrega].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;

      const tasaAceptacion = _tasa(foliosAceptados.size, foliosOfrecidos.size);
      const tasaFinalizacion = _tasa(entregados, foliosAceptados.size);
      const tasaCancelacion = _tasa(cancelados, foliosAceptados.size) || 0;

      // Score balanceado -- nunca solo volumen. Ver
      // docs/plan-fase-d-metricas-ranking.md / reporte de esta fase para la
      // fórmula exacta y su justificación.
      const velocidadNormalizada = tiempoPromedioAceptacionSeg != null
        ? Math.max(0, Math.min(1, 1 - (tiempoPromedioAceptacionSeg / VENTANA_RESPUESTA_SEG)))
        : null;
      const factorConfianza = Math.min(1, foliosOfrecidos.size / MUESTRA_CONFIANZA_PLENA);
      const score = (tasaAceptacion == null && tasaFinalizacion == null) ? null : (
        (0.35 * (tasaAceptacion ?? 0) +
         0.35 * (tasaFinalizacion ?? 0) +
         0.20 * (velocidadNormalizada ?? 0) +
         0.10 * (1 - tasaCancelacion)) * factorConfianza
      );

      const fila = {
        repartidorId: rep.id,
        nombre: rep.nombre,
        negocioId: rep.negocio_id,
        negocioNombre: nombreNegocioPorId.get(rep.negocio_id) || 'Negocio sin nombre',
        ciudad: rep.ciudad,
        zona: rep.zona,
        estadoRepartidor: rep.estado,
        posibleDuplicado: esPosibleDuplicado(rep),
        serviciosOfrecidos: foliosOfrecidos.size,
        serviciosAceptados: foliosAceptados.size,
        serviciosEntregados: entregados,
        serviciosRechazados: null,
        serviciosIgnorados: ignorados,
        tasaAceptacion,
        tasaFinalizacion,
        tiempoPromedioAceptacionSeg,
        ultimaActividad,
        score,
      };

      if (rep.estado === 'suspendido' || rep.estado === 'baja') {
        resultado.push({ grupo: 'suspendidosOBaja', fila });
      } else if (foliosOfrecidos.size >= UMBRAL_RANKING_OFRECIDOS && entregados >= UMBRAL_RANKING_ENTREGADOS) {
        resultado.push({ grupo: 'rankingElegible', fila });
      } else {
        resultado.push({ grupo: 'muestraInsuficiente', fila });
      }
    }

    const rankingElegible = resultado.filter(r => r.grupo === 'rankingElegible').map(r => r.fila).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    const muestraInsuficiente = resultado.filter(r => r.grupo === 'muestraInsuficiente').map(r => r.fila);
    const suspendidosOBaja = resultado.filter(r => r.grupo === 'suspendidosOBaja').map(r => r.fila);

    return { rankingElegible, muestraInsuficiente, suspendidosOBaja };
  } catch (e) {
    console.error('[DB] Error obtenerRankingRepartidores:', e.message);
    return { rankingElegible: [], muestraInsuficiente: [], suspendidosOBaja: [] };
  }
}

// CSV simple, sin dependencias -- escapa comillas dobles y envuelve en
// comillas cualquier valor con coma/comilla/salto de línea (RFC 4180
// mínimo). No usa ninguna librería nueva para un formato tan simple.
export function filasARegistrosCSV(filas, columnas) {
  const escapar = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const encabezado = columnas.map(c => escapar(c.titulo)).join(',');
  const lineas = filas.map(fila => columnas.map(c => escapar(c.valor(fila))).join(','));
  return [encabezado, ...lineas].join('\r\n') + '\r\n';
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
  'asistente_comercial_cotizaciones', 'restaurante', 'tienda_online',
];

// Fuente ÚNICA de módulos para la UI de Superadmin (fix readiness
// restaurante): el frontend construye su lista desde aquí en vez de
// duplicarla hardcodeada -- así el desfase que dejó a 'restaurante'
// invisible en el panel no puede repetirse con el próximo módulo. Las
// etiquetas viven junto a la lista para que agregar un módulo sea UN solo
// cambio en UN solo archivo.
const NOMBRES_MODULOS_UI = {
  pos: 'POS', usuarios: 'Usuarios', caja: 'Caja', menu: 'Menú', impresion: 'Impresión',
  whatsapp: 'WhatsApp', voz: 'Voz', rappi: 'Rappi', facturacion: 'Facturación', rewards: 'Rewards',
  chat_imagenes: 'Chat — Imágenes', chat_documentos_pdf: 'Chat — Documentos PDF',
  cotizaciones: 'Cotizaciones', generador_cotizaciones: 'Generador de cotizaciones',
  pagos: 'Pagos', repartidores: 'Repartidores',
  asistente_comercial_cotizaciones: 'Asistente Comercial (IA)',
  restaurante: 'Restaurante (mesas y meseros)',
  tienda_online: 'Tienda en línea',
};
export function listarModulosDisponibles() {
  return MODULOS_VALIDOS.map(clave => ({ clave, nombre: NOMBRES_MODULOS_UI[clave] || clave }));
}
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

/**
 * Contrato explícito de ACTOR para toda la cadena de integraciones.
 *
 * Antes, las funciones de servicio recibían un `actualizadoPor` suelto que
 * significaba EXCLUSIVAMENTE "superadmin". Cuando el autoservicio de WhatsApp
 * dejó que el administrador del propio negocio hiciera su onboarding, ese
 * parámetro llegaba en null y la auditoría lanzaba dentro de la transacción:
 * rollback de las credenciales y 502 al cliente (incidente Mapolato, 10 de
 * agosto de 2026, 16:39 UTC).
 *
 * Acepta dos formas:
 *   - objeto: { superadminId, actorUsuarioId } -- exactamente uno de los dos
 *   - string: se interpreta como superadminId (compatibilidad con los ~25
 *     llamadores de Superadmin que ya existían y que no cambian)
 *
 * Devuelve además `actualizadoPorId`, que es lo que va a la columna
 * `actualizado_por` de integraciones_canal: esa columna guarda "quién tocó
 * esto por última vez" y admite cualquier usuario, sea o no superadmin.
 */
export function normalizarActor(actor) {
  if (!actor) return { superadminId: null, actorUsuarioId: null, actualizadoPorId: null };
  if (typeof actor === 'string') {
    const id = actor.trim() || null;
    return { superadminId: id, actorUsuarioId: null, actualizadoPorId: id };
  }
  const superadminId = actor.superadminId || null;
  const actorUsuarioId = actor.actorUsuarioId || null;
  if (superadminId && actorUsuarioId) {
    throw new Error('normalizarActor: no puede haber dos actores (superadminId y actorUsuarioId)');
  }
  return { superadminId, actorUsuarioId, actualizadoPorId: superadminId || actorUsuarioId };
}

/**
 * Auditoría SECUNDARIA: deja rastro, pero jamás tumba la operación crítica
 * que ya se completó.
 *
 * Dentro de una transacción no basta con un try/catch en JS: si el INSERT de
 * auditoría falla, Postgres aborta la transacción entera y el COMMIT posterior
 * también falla ("current transaction is aborted"). Por eso se envuelve en un
 * SAVEPOINT: un fallo de bitácora retrocede SOLO la bitácora y las credenciales
 * válidas siguen su camino al COMMIT.
 *
 * Lo que NO hace: tragarse el error. Se registra siempre, y si es un error de
 * programación (TypeError/RangeError/ReferenceError -- p. ej. la recursión de
 * `auditar` que estuvo viva en df95af1) se marca como [BUG] con el stack, para
 * que no pase inadvertido en los logs.
 */
export async function registrarAuditoriaSecundaria(datos, client = pool) {
  const enTransaccion = client !== pool && typeof client.query === 'function';
  const punto = `aud_${Math.random().toString(36).slice(2, 10)}`;
  try {
    if (enTransaccion) await client.query(`SAVEPOINT ${punto}`);
    const fila = await registrarAuditoriaPlataforma(datos, client);
    if (enTransaccion) await client.query(`RELEASE SAVEPOINT ${punto}`);
    return fila;
  } catch (e) {
    if (enTransaccion) {
      try { await client.query(`ROLLBACK TO SAVEPOINT ${punto}`); }
      catch (eRollback) { console.error(`[AUDITORIA] no se pudo deshacer el savepoint: ${eRollback.message}`); }
    }
    const esBug = e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError;
    const etiqueta = esBug ? '[AUDITORIA][BUG]' : '[AUDITORIA]';
    console.error(`${etiqueta} no se pudo registrar "${datos?.accion}" para el negocio ${datos?.negocioId || 'desconocido'}: ${e.message}`);
    if (esBug) console.error(e.stack);
    return null;
  }
}

export async function registrarAuditoriaPlataforma({ superadminId = null, actorUsuarioId = null, accion, negocioId = null, usuarioId = null, estadoAnterior = null, estadoNuevo = null, contexto = null }, client = pool) {
  // Dos actores posibles y exactamente uno obligatorio: Xabor (superadminId)
  // o el administrador del propio negocio (actorUsuarioId). `usuarioId` es
  // otra cosa -- el usuario AFECTADO por la accion -- y no sirve como actor.
  const sup = superadminId || null;
  const act = actorUsuarioId || null;
  if (!sup && !act) throw new Error('registrarAuditoriaPlataforma: hace falta superadminId o actorUsuarioId');
  if (sup && act) throw new Error('registrarAuditoriaPlataforma: no puede haber dos actores');

  const { rows } = await client.query(
    `INSERT INTO auditoria_plataforma
       (superadmin_id, actor_usuario_id, accion, negocio_id, usuario_id, estado_anterior, estado_nuevo, contexto)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [sup, act, accion, negocioId, usuarioId,
     estadoAnterior ? JSON.stringify(estadoAnterior) : null,
     estadoNuevo ? JSON.stringify(estadoNuevo) : null,
     contexto ? JSON.stringify(contexto) : null]);
  return rows[0];
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

// El interruptor lo puede mover Superadmin O el administrador del propio
// negocio. Hasta la 046 no había dónde distinguirlos y el admin del negocio
// se guardaba en superadmin_id (la FK es genérica hacia usuarios, así que
// "funcionaba" pero mentía sobre quién había actuado). Ahora usa el contrato
// de actor: cada uno cae en su columna.
export async function actualizarBotWhatsappActivoNegocio(negocioId, activo, actor) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) return null;
  const { superadminId, actorUsuarioId } = normalizarActor(actor);
  if (typeof activo !== 'boolean') throw Object.assign(new Error('activo debe ser boolean'), { code: 'VALOR_INVALIDO' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, nombre, bot_whatsapp_activo FROM negocios WHERE id = $1 FOR UPDATE', [negocioId.trim()]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const anterior = rows[0];
    await client.query('UPDATE negocios SET bot_whatsapp_activo = $2 WHERE id = $1', [negocioId.trim(), activo]);
    await registrarAuditoriaPlataforma({
      superadminId, actorUsuarioId, accion: 'cambiar_bot_whatsapp_activo_negocio', negocioId: negocioId.trim(),
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

    // Desactivación segura de Restaurante: apagar el módulo con mesas
    // abiertas dejaría cuentas vivas sin forma de cobrarlas ni cerrarlas
    // (requireModulo devolvería 403 a toda la operación). Se bloquea el
    // cambio y se pide cerrarlas primero -- nunca se cierran solas, ni se
    // borran cuentas, pagos o historial.
    const apagaRestaurante = entradas.some(([m, e]) => m === 'restaurante' && e !== 'activo');
    if (apagaRestaurante && anteriorMapa.restaurante === 'activo') {
      const { rows: abiertas } = await client.query(
        `SELECT COUNT(*)::int c FROM restaurante_cuentas WHERE negocio_id = $1 AND estado = 'abierta'`,
        [negocioId]
      );
      if (abiertas[0].c > 0) {
        await client.query('ROLLBACK');
        throw Object.assign(
          new Error(`Hay ${abiertas[0].c} cuenta(s) abiertas. Cierra las mesas antes de desactivar Restaurante.`),
          { code: 'RESTAURANTE_CON_CUENTAS_ABIERTAS', cuentasAbiertas: abiertas[0].c }
        );
      }
    }

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
      `SELECT u.id, u.nombre, u.email, (u.password_hash IS NOT NULL) AS ya_acepto FROM usuario_negocios un
       JOIN usuarios u ON u.id = un.usuario_id
       WHERE un.negocio_id = $1 AND un.rol = 'admin'
       ORDER BY un.created_at ASC LIMIT 1`,
      [negocioId]
    );
    if (!adminRows.length) {
      const err = new Error('Este negocio no tiene ningún administrador registrado'); err.code = 'SIN_ADMIN'; throw err;
    }
    const admin = adminRows[0];
    // Edición de negocios (Superadmin): una invitación ya ACEPTADA jamás se
    // reenvía ni se regenera -- el admin ya tiene contraseña y sesión
    // propias; un enlace nuevo de crear_password_inicial solo permitiría
    // pisar esa contraseña desde un correo viejo. 409 explícito.
    if (admin.ya_acepto) {
      const err = new Error('El administrador ya aceptó su invitación y tiene contraseña — no hay nada que reenviar');
      err.code = 'INVITACION_ACEPTADA'; throw err;
    }

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
    if (e.code !== 'SIN_ADMIN' && e.code !== 'INVITACION_ACEPTADA') console.error('[DB] Error reenviarInvitacion:', e.message);
    throw e;
  } finally {
    client.release();
  }
}

// ─── Edición de negocios desde Superadmin ───────────────────────────────────
// El id (UUID) es la única clave: cambiar nombre/slug/correo jamás toca
// relaciones (todas las FKs apuntan a negocios.id / usuarios.id).
const SLUGS_RESERVADOS = new Set(['admin', 'api', 'superadmin', 'panel', 'test', 'xabor', 'www', 'webhook', 'repartidor', 'auth', 'health']);
const SLUG_REGEX = /^[a-z0-9](?:[a-z0-9-]{1,58})[a-z0-9]$/;
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Claves de contacto/operación que viven en `configuracion` (el modelo de
// negocios NO tiene columnas dedicadas para esto -- documentado en
// docs/superadmin-edicion-negocios.md; no se crean columnas nuevas).
const CLAVES_CONTACTO_NEGOCIO = ['ciudad', 'telefono', 'direccion', 'nombre_corto'];

// Edición parcial: SOLO los campos presentes en `cambios` se tocan; los
// ausentes jamás se sobreescriben. Auditoría campo a campo (antes/después)
// en una sola fila de auditoría de plataforma. Nunca guarda tokens ni
// secretos (los campos editables aquí no los contienen).
export async function actualizarDatosNegocioSuperadmin(negocioId, cambios = {}, superadminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('SELECT id, nombre, slug FROM negocios WHERE id = $1 FOR UPDATE', [negocioId]);
    if (!rows.length) { await client.query('ROLLBACK'); return null; }
    const actual = rows[0];
    const auditoria = [];

    if (cambios.nombre !== undefined) {
      const nombre = String(cambios.nombre || '').trim();
      if (!nombre || nombre.length > 120) {
        const err = new Error('Nombre comercial inválido (1-120 caracteres)'); err.code = 'NOMBRE_INVALIDO'; throw err;
      }
      if (nombre !== actual.nombre) {
        await client.query('UPDATE negocios SET nombre = $2, updated_at = NOW() WHERE id = $1', [negocioId, nombre]);
        auditoria.push({ campo: 'nombre', antes: actual.nombre, despues: nombre });
      }
    }

    // Slug estable por diseño: NUNCA se recalcula al cambiar el nombre; solo
    // cambia si el superadmin lo envía explícitamente, validado y con
    // advertencia en la UI (las URLs públicas que lo usan cambian).
    if (cambios.slug !== undefined) {
      const slug = String(cambios.slug || '').trim().toLowerCase();
      if (!SLUG_REGEX.test(slug)) {
        const err = new Error('Slug inválido (3-60 caracteres, minúsculas/números/guiones, sin guion al inicio o final)'); err.code = 'SLUG_INVALIDO'; throw err;
      }
      if (SLUGS_RESERVADOS.has(slug)) {
        const err = new Error(`El slug "${slug}" está reservado por la plataforma`); err.code = 'SLUG_RESERVADO'; throw err;
      }
      if (slug !== actual.slug) {
        const { rows: dup } = await client.query('SELECT 1 FROM negocios WHERE slug = $1 AND id <> $2', [slug, negocioId]);
        if (dup.length) { const err = new Error('Ya existe otro negocio con ese slug'); err.code = 'SLUG_DUPLICADO'; throw err; }
        await client.query('UPDATE negocios SET slug = $2, updated_at = NOW() WHERE id = $1', [negocioId, slug]);
        auditoria.push({ campo: 'slug', antes: actual.slug, despues: slug });
      }
    }

    const contacto = (cambios.contacto && typeof cambios.contacto === 'object') ? cambios.contacto : {};
    for (const clave of CLAVES_CONTACTO_NEGOCIO) {
      if (contacto[clave] === undefined) continue;
      const valor = String(contacto[clave] ?? '').trim().slice(0, 300);
      const { rows: prevRows } = await client.query(
        'SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2', [negocioId, clave]);
      const antes = prevRows[0]?.valor ?? null;
      if (antes === valor) continue;
      await client.query(
        `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)
         ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3`,
        [negocioId, clave, valor]);
      auditoria.push({ campo: `contacto.${clave}`, antes, despues: valor });
    }

    if (auditoria.length) {
      await registrarAuditoriaPlataforma({
        superadminId, accion: 'editar_negocio', negocioId,
        estadoAnterior: null, estadoNuevo: null,
        contexto: { cambios: auditoria },
      }, client);
    }

    await client.query('COMMIT');
    const { rows: final } = await pool.query('SELECT id, nombre, slug, estado, activo, updated_at FROM negocios WHERE id = $1', [negocioId]);
    return { ...final[0], cambiosAplicados: auditoria.length };
  } catch (e) {
    await client.query('ROLLBACK');
    if (!['NOMBRE_INVALIDO', 'SLUG_INVALIDO', 'SLUG_RESERVADO', 'SLUG_DUPLICADO'].includes(e.code)) {
      console.error('[DB] Error actualizarDatosNegocioSuperadmin:', e.message);
    }
    throw e;
  } finally {
    client.release();
  }
}

// Corrige el CORREO (y opcionalmente el nombre) del administrador invitado
// -- el caso Carnitas Moreno: el correo quedó mal capturado en el alta y el
// "reenviar" solo reenviaba al correo equivocado. Mismo criterio de admin
// que reenviarInvitacion (primer admin por antigüedad). Nunca crea un
// segundo admin: edita el usuario existente por su UUID.
export async function actualizarAdminNegocioSuperadmin(negocioId, { email, nombre } = {}, superadminId) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: negocioRows } = await client.query('SELECT id, nombre FROM negocios WHERE id = $1', [negocioId]);
    if (!negocioRows.length) { await client.query('ROLLBACK'); return null; }

    const { rows: adminRows } = await client.query(
      `SELECT u.id, u.nombre, u.email, (u.password_hash IS NOT NULL) AS ya_acepto
       FROM usuario_negocios un JOIN usuarios u ON u.id = un.usuario_id
       WHERE un.negocio_id = $1 AND un.rol = 'admin'
       ORDER BY un.created_at ASC LIMIT 1 FOR UPDATE OF u`,
      [negocioId]
    );
    if (!adminRows.length) {
      const err = new Error('Este negocio no tiene ningún administrador registrado'); err.code = 'SIN_ADMIN'; throw err;
    }
    const admin = adminRows[0];
    const auditoria = [];

    if (email !== undefined) {
      const emailNorm = String(email || '').trim().toLowerCase();
      if (!EMAIL_REGEX.test(emailNorm)) {
        const err = new Error('Correo inválido'); err.code = 'EMAIL_INVALIDO'; throw err;
      }
      if (emailNorm !== admin.email) {
        const { rows: dup } = await client.query('SELECT 1 FROM usuarios WHERE email = $1 AND id <> $2', [emailNorm, admin.id]);
        if (dup.length) { const err = new Error('Ya existe otro usuario con ese correo'); err.code = 'EMAIL_EN_USO'; throw err; }
        await client.query('UPDATE usuarios SET email = $2, updated_at = NOW() WHERE id = $1', [admin.id, emailNorm]);
        auditoria.push({ campo: 'admin.email', antes: admin.email, despues: emailNorm });
      }
    }

    if (nombre !== undefined) {
      const nombreNorm = String(nombre || '').trim();
      if (!nombreNorm || nombreNorm.length > 120) {
        const err = new Error('Nombre del administrador inválido'); err.code = 'NOMBRE_INVALIDO'; throw err;
      }
      if (nombreNorm !== admin.nombre) {
        await client.query('UPDATE usuarios SET nombre = $2, updated_at = NOW() WHERE id = $1', [admin.id, nombreNorm]);
        auditoria.push({ campo: 'admin.nombre', antes: admin.nombre, despues: nombreNorm });
      }
    }

    if (auditoria.length) {
      await registrarAuditoriaPlataforma({
        superadminId, accion: 'editar_admin_negocio', negocioId, usuarioId: admin.id,
        estadoAnterior: null, estadoNuevo: null,
        contexto: { cambios: auditoria, yaAcepto: admin.ya_acepto },
      }, client);
    }

    await client.query('COMMIT');
    return {
      usuarioId: admin.id, yaAcepto: admin.ya_acepto, cambiosAplicados: auditoria.length,
      email: auditoria.find(c => c.campo === 'admin.email')?.despues ?? admin.email,
      nombre: auditoria.find(c => c.campo === 'admin.nombre')?.despues ?? admin.nombre,
    };
  } catch (e) {
    await client.query('ROLLBACK');
    if (!['SIN_ADMIN', 'EMAIL_INVALIDO', 'EMAIL_EN_USO', 'NOMBRE_INVALIDO'].includes(e.code)) {
      console.error('[DB] Error actualizarAdminNegocioSuperadmin:', e.message);
    }
    throw e;
  } finally {
    client.release();
  }
}

// Historial de invitaciones del negocio para la UI de Superadmin: estados
// derivados y correo destino -- JAMÁS expone token_hash ni token alguno.
export async function obtenerInvitacionesNegocio(negocioId) {
  const { rows } = await pool.query(
    `SELECT i.id, i.created_at, i.expires_at, i.used_at, i.revoked_at,
            u.email AS correo_destino, u.nombre AS usuario_nombre,
            cb.nombre AS creada_por,
            CASE
              WHEN i.used_at IS NOT NULL THEN 'aceptada'
              WHEN i.revoked_at IS NOT NULL THEN 'cancelada'
              WHEN i.expires_at < NOW() THEN 'expirada'
              ELSE 'pendiente'
            END AS estado
     FROM invitaciones_usuario i
     JOIN usuarios u ON u.id = i.usuario_id
     LEFT JOIN usuarios cb ON cb.id = i.created_by
     WHERE i.negocio_id = $1
     ORDER BY i.created_at DESC
     LIMIT 50`,
    [negocioId]
  );
  return rows;
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

// ─── Recuperación de contraseña ─────────────────────────────────────────────
// Mismo mecanismo probado de las invitaciones (012): token aleatorio de 256
// bits enviado por correo, del que la base guarda ÚNICAMENTE su SHA-256.
// Diferencias con una invitación: lo pide el propio usuario (no un
// superadmin), vive mucho menos y no activa membresías.
//
// Quién puede recuperar: una cuenta ADMINISTRATIVA — con correo, con
// contraseña y con al menos una membresía activa en un negocio activo. Un
// mesero no entra por aquí: no tiene correo ni contraseña, su acceso es un
// PIN y quien se lo repone es un administrador desde Usuarios. Son dos
// sistemas separados a propósito y esta función nunca toca pin_hash.
const RESET_DURACION_MS = 60 * 60 * 1000; // 1 hora

export function normalizarEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Devuelve { creado, token, usuario } — el token EN CRUDO solo en este
// retorno, para que el llamador lo mande por correo; nunca se guarda ni se
// devuelve por HTTP. Si el correo no corresponde a una cuenta que pueda
// recuperar, devuelve { creado: false } SIN decir por qué: la respuesta
// pública es la misma en todos los casos.
export async function crearSolicitudResetPassword(email) {
  const normalizado = normalizarEmail(email);
  if (!normalizado) return { creado: false };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Elegible = correo + contraseña + membresía viva. Se compara en
    // minúsculas porque quien olvidó su contraseña también teclea su correo
    // como se le ocurre.
    const { rows } = await client.query(
      `SELECT u.id, u.nombre, u.email
         FROM usuarios u
        WHERE LOWER(u.email) = $1
          AND u.activo = TRUE
          AND u.password_hash IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM usuario_negocios un
              JOIN negocios n ON n.id = un.negocio_id
             WHERE un.usuario_id = u.id AND un.activo = TRUE AND n.activo = TRUE
               AND un.rol <> 'mesero'
          )
        LIMIT 1`,
      [normalizado]
    );
    if (!rows.length) { await client.query('COMMIT'); return { creado: false }; }
    const usuario = rows[0];
    // Solo el último enlace sirve: pedir otro invalida los anteriores.
    await client.query(
      `UPDATE password_reset_tokens SET revoked_at = NOW()
        WHERE usuario_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
      [usuario.id]
    );
    const token = randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + RESET_DURACION_MS);
    await client.query(
      `INSERT INTO password_reset_tokens (usuario_id, token_hash, expires_at) VALUES ($1,$2,$3)`,
      [usuario.id, hashToken(token), expiresAt]
    );
    await client.query('COMMIT');
    return { creado: true, token, expiresAt, usuario: { id: usuario.id, nombre: usuario.nombre, email: usuario.email } };
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('[DB] Error crearSolicitudResetPassword:', e.message);
    return { creado: false };
  } finally {
    client.release();
  }
}

// Para que la pantalla sepa qué mostrar antes de pedir la contraseña nueva.
// Nunca devuelve el correo ni el negocio: solo el primer nombre, igual que
// la validación de invitaciones.
export async function validarTokenReset(token) {
  if (!token || typeof token !== 'string') return { estado: 'invalido' };
  try {
    const { rows } = await pool.query(
      `SELECT t.used_at, t.revoked_at, t.expires_at, u.nombre
         FROM password_reset_tokens t JOIN usuarios u ON u.id = t.usuario_id
        WHERE t.token_hash = $1`,
      [hashToken(token)]
    );
    if (!rows.length) return { estado: 'invalido' };
    const t = rows[0];
    if (t.used_at) return { estado: 'usado' };
    // Un enlace revocado (porque se pidió otro) no se distingue de uno
    // inválido: no hay razón para contarle a nadie que existió.
    if (t.revoked_at) return { estado: 'invalido' };
    if (new Date(t.expires_at) < new Date()) return { estado: 'expirado' };
    return { estado: 'valido', nombreParcial: (t.nombre || '').trim().split(/\s+/)[0] || '' };
  } catch (e) {
    console.error('[DB] Error validarTokenReset:', e.message);
    return { estado: 'invalido' };
  }
}

// Consume el enlace y cambia la contraseña. Todo en UNA transacción con
// SELECT ... FOR UPDATE sobre el token, para que dos solicitudes simultáneas
// con el mismo enlace no lo usen las dos.
//
// Al terminar se marca `sesiones_invalidas_antes`: las sesiones abiertas con
// la contraseña vieja dejan de servir de inmediato (ver
// obtenerMembresiaUsuarioNegocio). El PIN de un mesero nunca se toca aquí.
export async function restablecerPasswordConToken(token, password) {
  if (!token || typeof token !== 'string') { const e = new Error('Enlace inválido'); e.code = 'INVALIDO'; throw e; }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT t.id, t.usuario_id, t.used_at, t.revoked_at, t.expires_at, u.email, u.activo
         FROM password_reset_tokens t JOIN usuarios u ON u.id = t.usuario_id
        WHERE t.token_hash = $1 FOR UPDATE`,
      [hashToken(token)]
    );
    if (!rows.length) { const e = new Error('Enlace inválido'); e.code = 'INVALIDO'; throw e; }
    const t = rows[0];
    if (t.used_at) { const e = new Error('Este enlace ya fue utilizado'); e.code = 'USADO'; throw e; }
    if (t.revoked_at) { const e = new Error('Enlace inválido'); e.code = 'INVALIDO'; throw e; }
    if (new Date(t.expires_at) < new Date()) { const e = new Error('Este enlace expiró'); e.code = 'EXPIRADO'; throw e; }
    if (!t.activo) { const e = new Error('Enlace inválido'); e.code = 'INVALIDO'; throw e; }
    // Mismas reglas que al crear la contraseña inicial: una sola política.
    if (typeof password !== 'string' || password.length < 8) {
      const e = new Error('La contraseña debe tener al menos 8 caracteres'); e.code = 'PASSWORD_INVALIDA'; throw e;
    }
    if (t.email && password.toLowerCase() === t.email.toLowerCase()) {
      const e = new Error('La contraseña no puede ser igual a tu correo'); e.code = 'PASSWORD_INVALIDA'; throw e;
    }

    await client.query(
      `UPDATE usuarios SET password_hash = $1, sesiones_invalidas_antes = NOW(), updated_at = NOW() WHERE id = $2`,
      [hashPassword(password), t.usuario_id]
    );
    await client.query('UPDATE password_reset_tokens SET used_at = NOW() WHERE id = $1', [t.id]);
    // Defensivo: cualquier otro enlace vigente del mismo usuario muere aquí.
    await client.query(
      `UPDATE password_reset_tokens SET revoked_at = NOW()
        WHERE usuario_id = $1 AND id <> $2 AND used_at IS NULL AND revoked_at IS NULL`,
      [t.usuario_id, t.id]
    );
    await client.query('COMMIT');
    return { usuarioId: t.usuario_id };
  } catch (e) {
    await client.query('ROLLBACK');
    if (!e.code) console.error('[DB] Error restablecerPasswordConToken:', e.message);
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
