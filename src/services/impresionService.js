// ─── Impresión: impresoras, reglas de destino y trabajos ────────────────────
//
// Este módulo es la mitad "nube" de Xabor Edge. Su responsabilidad es
// convertir un hecho del negocio ("se envió la ronda 2 de la mesa 4") en
// filas de `impresion_trabajos`, una por destino, con un snapshot congelado.
//
// Lo que este módulo NUNCA hace:
//   * abrir un socket hacia una impresora -- `host` y `puerto` son datos que
//     viajan al Edge y nada más (ver docs/xabor-edge-arquitectura.md, SSRF);
//   * lanzar una excepción hacia el flujo de Restaurante -- si la impresión
//     no se puede preparar, la comanda ya está guardada y eso manda;
//   * confiar en un negocioId o un impresoraId que venga del cliente sin
//     comprobar a quién pertenece.
import { pool } from './database.js';
import { indexarReglas, agruparItemsPorImpresora, destinosDeDocumento, normalizarClave } from '../printing/routingEngine.js';

function errorCodigo(mensaje, code) {
  const e = new Error(mensaje);
  e.code = code;
  return e;
}

function exigirNegocio(negocioId) {
  if (typeof negocioId !== 'string' || !negocioId.trim()) {
    throw errorCodigo('negocioId requerido', 'TENANT_CONTEXT_REQUIRED');
  }
  return negocioId.trim();
}

const TRANSPORTES = new Set(['mock', 'tcp_raw', 'windows_spooler']);
const AMBITOS = new Set(['categoria', 'producto', 'documento']);
const MODOS = new Set(['agregar', 'exclusivo']);

// ─── Impresoras ─────────────────────────────────────────────────────────────

export async function listarImpresoras(negocioId, { sucursalId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT i.id, i.negocio_id, i.sucursal_id, i.terminal_id, i.nombre, i.transporte,
            i.host, i.puerto, i.ancho_columnas, i.activa, i.config,
            i.created_at, i.updated_at,
            t.nombre AS terminal_nombre, t.activo AS terminal_activa, t.ultima_conexion
       FROM impresoras i
       JOIN terminales t ON t.id = i.terminal_id
      WHERE i.negocio_id = $1 AND ($2::uuid IS NULL OR i.sucursal_id = $2)
      ORDER BY i.nombre`,
    [nid, sucursalId]
  );
  return rows;
}

// La terminal manda: de ella se derivan negocio y sucursal. El llamador no
// puede colocar una impresora en un negocio ajeno aunque mande su id, porque
// negocio_id y sucursal_id NO se leen del cuerpo del request.
export async function crearImpresora(negocioId, { terminalId, nombre, transporte = 'mock', host = null, puerto = null, anchoColumnas = 42, config = {} }) {
  const nid = exigirNegocio(negocioId);
  if (typeof nombre !== 'string' || !nombre.trim()) throw errorCodigo('El nombre de la impresora es obligatorio', 'NOMBRE_REQUERIDO');
  if (!TRANSPORTES.has(transporte)) throw errorCodigo(`Transporte no soportado: ${transporte}`, 'TRANSPORTE_INVALIDO');

  const { rows: term } = await pool.query(
    `SELECT t.id, t.sucursal_id, s.negocio_id
       FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id
      WHERE t.id = $1`,
    [terminalId]
  );
  if (!term.length) throw errorCodigo('Terminal no encontrada', 'TERMINAL_NO_ENCONTRADA');
  if (term[0].negocio_id !== nid) throw errorCodigo('Terminal no encontrada', 'TERMINAL_NO_ENCONTRADA');

  if (transporte === 'tcp_raw') {
    if (typeof host !== 'string' || !host.trim()) throw errorCodigo('tcp_raw exige host', 'HOST_REQUERIDO');
    const p = Number(puerto);
    if (!Number.isInteger(p) || p < 1 || p > 65535) throw errorCodigo('tcp_raw exige un puerto válido (1-65535)', 'PUERTO_INVALIDO');
  }
  const ancho = Number(anchoColumnas);
  if (!Number.isInteger(ancho) || ancho < 20 || ancho > 96) throw errorCodigo('ancho_columnas fuera de rango (20-96)', 'ANCHO_INVALIDO');

  try {
    const { rows } = await pool.query(
      `INSERT INTO impresoras (negocio_id, sucursal_id, terminal_id, nombre, transporte, host, puerto, ancho_columnas, config)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [nid, term[0].sucursal_id, term[0].id, nombre.trim(), transporte,
       host ? String(host).trim() : null, puerto === null || puerto === '' ? null : Number(puerto),
       ancho, JSON.stringify(config || {})]
    );
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw errorCodigo('Ya existe una impresora con ese nombre en la sucursal', 'NOMBRE_DUPLICADO');
    throw e;
  }
}

export async function actualizarImpresora(negocioId, impresoraId, cambios = {}) {
  const nid = exigirNegocio(negocioId);
  const permitidos = { nombre: 'nombre', transporte: 'transporte', host: 'host', puerto: 'puerto', anchoColumnas: 'ancho_columnas', activa: 'activa', config: 'config' };
  const sets = [];
  const valores = [nid, impresoraId];

  for (const [clave, columna] of Object.entries(permitidos)) {
    if (!(clave in cambios)) continue;
    let v = cambios[clave];
    if (clave === 'transporte' && !TRANSPORTES.has(v)) throw errorCodigo(`Transporte no soportado: ${v}`, 'TRANSPORTE_INVALIDO');
    if (clave === 'puerto') v = (v === null || v === '') ? null : Number(v);
    if (clave === 'anchoColumnas') v = Number(v);
    if (clave === 'config') v = JSON.stringify(v || {});
    if (clave === 'nombre') v = String(v || '').trim();
    valores.push(v);
    sets.push(`${columna} = $${valores.length}`);
  }
  if (!sets.length) throw errorCodigo('Nada que actualizar', 'SIN_CAMBIOS');

  const { rows } = await pool.query(
    `UPDATE impresoras SET ${sets.join(', ')} WHERE negocio_id = $1 AND id = $2 RETURNING *`,
    valores
  );
  if (!rows.length) throw errorCodigo('Impresora no encontrada', 'IMPRESORA_NO_ENCONTRADA');
  return rows[0];
}

// ─── Reglas de destino ──────────────────────────────────────────────────────

export async function listarRutas(negocioId, { sucursalId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT r.id, r.negocio_id, r.sucursal_id, r.impresora_id, r.ambito, r.clave, r.modo, r.activa,
            i.nombre AS impresora_nombre
       FROM impresion_rutas r
       JOIN impresoras i ON i.id = r.impresora_id
      WHERE r.negocio_id = $1 AND ($2::uuid IS NULL OR r.sucursal_id = $2)
      ORDER BY r.ambito, r.clave, i.nombre`,
    [nid, sucursalId]
  );
  return rows;
}

export async function crearRuta(negocioId, { impresoraId, ambito, clave, modo = 'agregar' }) {
  const nid = exigirNegocio(negocioId);
  if (!AMBITOS.has(ambito)) throw errorCodigo(`Ámbito inválido: ${ambito}`, 'AMBITO_INVALIDO');
  if (!MODOS.has(modo)) throw errorCodigo(`Modo inválido: ${modo}`, 'MODO_INVALIDO');
  const claveNorm = normalizarClave(clave);
  if (!claveNorm) throw errorCodigo('La clave de la regla es obligatoria', 'CLAVE_REQUERIDA');
  if (ambito === 'documento' && modo === 'exclusivo') {
    throw errorCodigo("Las reglas de documento no admiten modo 'exclusivo': no heredan de ninguna categoría", 'MODO_INVALIDO');
  }

  // La impresora tiene que ser de ESTE negocio. Sin esta comprobación, un
  // administrador podría enrutar sus comandas a la impresora de otro
  // restaurante mandando un uuid ajeno.
  const { rows: imp } = await pool.query(
    `SELECT id, sucursal_id FROM impresoras WHERE id = $1 AND negocio_id = $2`,
    [impresoraId, nid]
  );
  if (!imp.length) throw errorCodigo('Impresora no encontrada', 'IMPRESORA_NO_ENCONTRADA');

  try {
    const { rows } = await pool.query(
      `INSERT INTO impresion_rutas (negocio_id, sucursal_id, impresora_id, ambito, clave, modo)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [nid, imp[0].sucursal_id, impresoraId, ambito, claveNorm, modo]
    );
    return rows[0];
  } catch (e) {
    if (e.code === '23505') throw errorCodigo('Esa regla ya existe', 'RUTA_DUPLICADA');
    throw e;
  }
}

export async function eliminarRuta(negocioId, rutaId) {
  const nid = exigirNegocio(negocioId);
  const { rowCount } = await pool.query(`DELETE FROM impresion_rutas WHERE id = $1 AND negocio_id = $2`, [rutaId, nid]);
  if (!rowCount) throw errorCodigo('Regla no encontrada', 'RUTA_NO_ENCONTRADA');
  return { eliminada: true };
}

// ─── Creación de trabajos ───────────────────────────────────────────────────

// Clave de idempotencia: determinista, derivada solo de datos ya estables.
// Nunca Date.now(), nunca random. Si el mismo request se reintenta, la clave
// es idéntica, el INSERT choca contra el UNIQUE y sabemos que es duplicado.
export function construirClaveIdempotencia({ negocioId, origenTipo, origenId, impresoraId }) {
  return `${negocioId}:${origenTipo}:${origenId}:${impresoraId}`;
}

// Inserta un trabajo comprobando DE VERDAD si hubo conflicto.
//
// El error que este proyecto ya pagó una vez: hacer ON CONFLICT DO NOTHING y
// devolver éxito sin mirar si se insertó algo. Aquí, si RETURNING viene
// vacío, la fila ya existía -- se busca, se devuelve la existente y se marca
// `duplicado: true`. Quien llama sabe distinguir "creé un trabajo" de "ya
// estaba creado", que es lo único que impide imprimir dos veces.
async function insertarTrabajo(cliente, trabajo) {
  const { rows } = await cliente.query(
    `INSERT INTO impresion_trabajos
       (negocio_id, sucursal_id, terminal_id, impresora_id, impresora_nombre,
        documento, origen_tipo, origen_id, idempotency_key, payload, trabajo_original_id, reimpreso_por, motivo)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING *`,
    [trabajo.negocioId, trabajo.sucursalId, trabajo.terminalId, trabajo.impresoraId, trabajo.impresoraNombre,
     trabajo.documento, trabajo.origenTipo, trabajo.origenId, trabajo.idempotencyKey,
     JSON.stringify(trabajo.payload), trabajo.trabajoOriginalId ?? null, trabajo.reimpresoPor ?? null, trabajo.motivo ?? null]
  );

  if (rows.length) return { trabajo: rows[0], duplicado: false };

  const { rows: existente } = await cliente.query(
    `SELECT * FROM impresion_trabajos WHERE idempotency_key = $1`, [trabajo.idempotencyKey]
  );
  if (!existente.length) {
    // No se insertó y tampoco existe: algo va mal de verdad. Fallar es
    // preferible a devolver un éxito que nadie puede respaldar.
    throw errorCodigo('No se pudo persistir el trabajo de impresión', 'TRABAJO_NO_PERSISTIDO');
  }
  return { trabajo: existente[0], duplicado: true };
}

async function cargarReglas(negocioId, sucursalId) {
  const { rows } = await pool.query(
    `SELECT r.ambito, r.clave, r.modo, r.activa, r.impresora_id, i.nombre AS impresora_nombre
       FROM impresion_rutas r
       JOIN impresoras i ON i.id = r.impresora_id AND i.activa
      WHERE r.negocio_id = $1 AND r.sucursal_id = $2 AND r.activa`,
    [negocioId, sucursalId]
  );
  return indexarReglas(rows);
}

async function datosDeImpresoras(negocioId, ids) {
  if (!ids.length) return new Map();
  const { rows } = await pool.query(
    `SELECT id, nombre, terminal_id, sucursal_id FROM impresoras WHERE negocio_id = $1 AND id = ANY($2::uuid[])`,
    [negocioId, ids]
  );
  return new Map(rows.map(r => [r.id, r]));
}

// Sucursal por defecto del negocio. Xabor todavía es de una sucursal por
// negocio en la práctica; cuando eso cambie, quien llame pasará la suya.
export async function resolverSucursal(negocioId, sucursalId = null) {
  if (sucursalId) {
    const { rows } = await pool.query(`SELECT id FROM sucursales WHERE id = $1 AND negocio_id = $2 AND activo`, [sucursalId, negocioId]);
    return rows.length ? rows[0].id : null;
  }
  const { rows } = await pool.query(
    `SELECT id FROM sucursales WHERE negocio_id = $1 AND activo ORDER BY created_at LIMIT 1`, [negocioId]
  );
  return rows.length ? rows[0].id : null;
}

// ─── Comanda ────────────────────────────────────────────────────────────────
//
// Toma la ronda tal como la devuelve restauranteService.enviarComanda y crea
// un trabajo por cada impresora destino.
//
// NUNCA lanza hacia arriba: devuelve un resumen. La comanda digital ya está
// guardada; que falte configurar una impresora no puede convertirse en un
// error para el mesero que acaba de mandar la orden.
export async function crearTrabajosDeComanda({ negocioId, sucursalId = null, cuentaId, comanda }) {
  const resumen = { creados: [], duplicados: [], sinRuta: [], avisos: [], error: null };
  try {
    const nid = exigirNegocio(negocioId);
    const sid = await resolverSucursal(nid, sucursalId);
    if (!sid) { resumen.avisos.push('el negocio no tiene sucursal activa: no se generaron trabajos'); return resumen; }

    const reglas = await cargarReglas(nid, sid);
    const { grupos, sinRuta, avisos } = agruparItemsPorImpresora(comanda.items, reglas);
    resumen.sinRuta = sinRuta;
    resumen.avisos.push(...avisos);
    if (!grupos.length) return resumen;

    const impresoras = await datosDeImpresoras(nid, grupos.map(g => g.impresoraId));

    for (const grupo of grupos) {
      const imp = impresoras.get(grupo.impresoraId);
      if (!imp) { resumen.avisos.push(`impresora ${grupo.impresoraId} ya no existe`); continue; }

      // El snapshot: todo lo que hace falta para imprimir este papel dentro
      // de un año, sin consultar el menú ni la cuenta.
      const payload = {
        documento: 'comanda',
        negocioId: nid,
        mesa: comanda.mesa,
        personas: comanda.personas,
        mesero: comanda.mesero,
        ronda: comanda.comanda,
        tipoRonda: comanda.tipo,
        emitidoAt: new Date().toISOString(),
        impresora: imp.nombre,
        items: grupo.items.map(i => ({
          producto: i.producto ?? i.nombre,
          cantidad: i.cantidad,
          modificadores: Array.isArray(i.modificadores) ? i.modificadores : [],
          notas: i.notas ?? null,
        })),
      };

      const origenId = `${cuentaId}:${comanda.comanda}`;
      const { trabajo, duplicado } = await insertarTrabajo(pool, {
        negocioId: nid, sucursalId: sid, terminalId: imp.terminal_id,
        impresoraId: imp.id, impresoraNombre: imp.nombre,
        documento: 'comanda', origenTipo: 'restaurante_comanda', origenId,
        idempotencyKey: construirClaveIdempotencia({ negocioId: nid, origenTipo: 'restaurante_comanda', origenId, impresoraId: imp.id }),
        payload,
      });
      (duplicado ? resumen.duplicados : resumen.creados).push(trabajo);
    }
  } catch (e) {
    // Se registra y se sigue: la comanda manda.
    resumen.error = e.code || 'ERROR_IMPRESION';
    console.error(`[Impresion] no se pudieron crear los trabajos de la comanda (negocio=${negocioId}): ${e.message}`);
  }
  return resumen;
}

// ─── Documento completo (cuenta, cancelación) ───────────────────────────────
export async function crearTrabajosDeDocumento({ negocioId, sucursalId = null, documento, origenTipo, origenId, payload }) {
  const resumen = { creados: [], duplicados: [], sinRuta: [], avisos: [], error: null };
  try {
    const nid = exigirNegocio(negocioId);
    const sid = await resolverSucursal(nid, sucursalId);
    if (!sid) { resumen.avisos.push('el negocio no tiene sucursal activa: no se generaron trabajos'); return resumen; }

    const reglas = await cargarReglas(nid, sid);
    const destinos = destinosDeDocumento(documento, reglas);
    if (!destinos.length) {
      resumen.sinRuta.push(documento);
      resumen.avisos.push(`sin impresora configurada para el documento "${documento}"`);
      return resumen;
    }

    const impresoras = await datosDeImpresoras(nid, destinos.map(d => d.impresoraId));
    for (const d of destinos) {
      const imp = impresoras.get(d.impresoraId);
      if (!imp) continue;
      const { trabajo, duplicado } = await insertarTrabajo(pool, {
        negocioId: nid, sucursalId: sid, terminalId: imp.terminal_id,
        impresoraId: imp.id, impresoraNombre: imp.nombre,
        documento, origenTipo, origenId,
        idempotencyKey: construirClaveIdempotencia({ negocioId: nid, origenTipo, origenId, impresoraId: imp.id }),
        payload: { ...payload, documento, impresora: imp.nombre, emitidoAt: new Date().toISOString() },
      });
      (duplicado ? resumen.duplicados : resumen.creados).push(trabajo);
    }
  } catch (e) {
    resumen.error = e.code || 'ERROR_IMPRESION';
    console.error(`[Impresion] no se pudieron crear los trabajos del documento ${documento} (negocio=${negocioId}): ${e.message}`);
  }
  return resumen;
}

// ─── Prueba de impresora ────────────────────────────────────────────────────
//
// Pasa por la MISMA tubería que una comanda real: se crea un trabajo, se
// entrega al Edge, se reintenta si falla y se confirma con ACK. Si la prueba
// usara un atajo, probaría un camino que la operación real no recorre.
//
// A diferencia de una comanda, cada prueba es una intención nueva: dos
// pruebas seguidas deben imprimir dos papeles. Por eso su origenId lleva un
// identificador propio en vez de derivarse de una ronda.
export async function crearTrabajoDePrueba(negocioId, impresoraId, { solicitadoPor = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT i.id, i.nombre, i.terminal_id, i.sucursal_id, i.activa, i.transporte, i.ancho_columnas,
            n.nombre AS negocio_nombre, t.nombre AS terminal_nombre
       FROM impresoras i
       JOIN negocios n ON n.id = i.negocio_id
       JOIN terminales t ON t.id = i.terminal_id
      WHERE i.id = $1 AND i.negocio_id = $2`,
    [impresoraId, nid]
  );
  if (!rows.length) throw errorCodigo('Impresora no encontrada', 'IMPRESORA_NO_ENCONTRADA');
  const imp = rows[0];
  if (!imp.activa) throw errorCodigo('La impresora está desactivada', 'IMPRESORA_INACTIVA');

  const origenId = randomId();
  const { trabajo } = await insertarTrabajo(pool, {
    negocioId: nid, sucursalId: imp.sucursal_id, terminalId: imp.terminal_id,
    impresoraId: imp.id, impresoraNombre: imp.nombre,
    documento: 'prueba', origenTipo: 'prueba_manual', origenId,
    idempotencyKey: construirClaveIdempotencia({ negocioId: nid, origenTipo: 'prueba_manual', origenId, impresoraId: imp.id }),
    payload: {
      documento: 'prueba',
      negocio: imp.negocio_nombre,
      impresora: imp.nombre,
      terminal: imp.terminal_nombre,
      transporte: imp.transporte,
      anchoColumnas: imp.ancho_columnas,
      emitidoAt: new Date().toISOString(),
    },
    reimpresoPor: solicitadoPor,
  });
  return trabajo;
}

function randomId() {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ─── Reimpresión ────────────────────────────────────────────────────────────
//
// Reimprimir NO reintenta el trabajo viejo: crea uno nuevo que apunta al
// original. El histórico de lo que pasó con el primero queda intacto -- si
// se "reseteara", se perdería la evidencia de que hubo un problema.
export async function reimprimirTrabajo(negocioId, trabajoId, { usuarioId = null, motivo = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT * FROM impresion_trabajos WHERE id = $1 AND negocio_id = $2`, [trabajoId, nid]
  );
  if (!rows.length) throw errorCodigo('Trabajo no encontrado', 'TRABAJO_NO_ENCONTRADO');
  const original = rows[0];

  if (!original.impresora_id) throw errorCodigo('La impresora original ya no existe: elige otra', 'IMPRESORA_NO_ENCONTRADA');
  const { rows: imp } = await pool.query(
    `SELECT id, nombre, terminal_id, activa FROM impresoras WHERE id = $1 AND negocio_id = $2`,
    [original.impresora_id, nid]
  );
  if (!imp.length) throw errorCodigo('La impresora original ya no existe: elige otra', 'IMPRESORA_NO_ENCONTRADA');
  if (!imp[0].activa) throw errorCodigo('La impresora está desactivada', 'IMPRESORA_INACTIVA');

  const origenId = `${original.id}:${randomId()}`;
  const { trabajo } = await insertarTrabajo(pool, {
    negocioId: nid, sucursalId: original.sucursal_id, terminalId: imp[0].terminal_id,
    impresoraId: imp[0].id, impresoraNombre: imp[0].nombre,
    documento: original.documento, origenTipo: 'reimpresion', origenId,
    idempotencyKey: construirClaveIdempotencia({ negocioId: nid, origenTipo: 'reimpresion', origenId, impresoraId: imp[0].id }),
    payload: { ...original.payload, reimpresion: true, emitidoAt: new Date().toISOString() },
    trabajoOriginalId: original.id,
    reimpresoPor: usuarioId,
    motivo,
  });
  return trabajo;
}

// ─── Cola y estados ─────────────────────────────────────────────────────────

// Lo que un Edge debe intentar ahora: sus trabajos no terminados, de su
// sucursal, más antiguos primero. El filtro por terminal es lo que impide que
// un Edge reciba trabajos de otro -- y `terminalId` nunca viene del cliente,
// se toma de la conexión ya autenticada.
// `desde` es un cursor por (created_at, id): permite paginar la cola sin
// saltarse nada. Hace falta porque marcar un trabajo como 'entregado' NO lo
// saca de esta consulta -- un entregado sin confirmar sigue siendo trabajo
// pendiente de confirmar. Sin cursor, una cola mayor que el límite dejaría
// trabajos esperando a la siguiente reconexión, que podía no llegar en toda
// la noche.
export async function trabajosPendientesDeTerminal(terminalId, { limite = 50, desde = null } = {}) {
  const { rows } = await pool.query(
    `SELECT t.*, t.created_at::text AS cursor_created_at,
            i.transporte, i.host, i.puerto, i.ancho_columnas, i.config AS impresora_config
       FROM impresion_trabajos t
       LEFT JOIN impresoras i ON i.id = t.impresora_id
      WHERE t.terminal_id = $1
        AND t.estado IN ('pendiente','entregado','fallido')
        AND ($3::text IS NULL OR (t.created_at, t.id) > ($3::timestamptz, $4::uuid))
      ORDER BY t.created_at, t.id
      LIMIT $2`,
    [terminalId, limite, desde?.createdAt ?? null, desde?.id ?? null]
  );
  return rows;
}

// El cursor DEBE construirse con esta función, nunca con `fila.created_at`.
//
// Postgres guarda TIMESTAMPTZ con microsegundos y el driver lo entrega como
// un Date de JavaScript, que solo tiene milisegundos. Un cursor construido
// con ese Date queda por DEBAJO del valor real de la fila, así que la
// comparación `(created_at, id) > cursor` vuelve a incluirla: la última fila
// de cada página se entregaba dos veces. Con 100 pendientes salían 102.
//
// Por eso se arrastra `created_at::text`, que conserva la precisión completa
// y vuelve a timestamptz sin perder nada.
export function cursorDeTrabajo(fila) {
  return { createdAt: fila.cursor_created_at, id: fila.id };
}

export async function marcarEntregado(trabajoId, terminalId) {
  const { rows } = await pool.query(
    `UPDATE impresion_trabajos
        SET estado = 'entregado', entregado_at = NOW()
      WHERE id = $1 AND terminal_id = $2 AND estado IN ('pendiente','fallido')
      RETURNING id, estado`,
    [trabajoId, terminalId]
  );
  return rows[0] || null;
}

const ESTADOS_ACK = new Set(['enviado', 'fallido', 'incierto']);

// ACK del Edge. `terminalId` viene de la conexión autenticada, jamás del
// mensaje: un Edge no puede confirmar ni tocar el trabajo de otro. Si el
// filtro no encuentra fila, se rechaza -- no se crea nada ni se "arregla".
export async function registrarAckDeTerminal(terminalId, { trabajoId, resultado, error = null }) {
  if (!ESTADOS_ACK.has(resultado)) throw errorCodigo(`Resultado de ACK inválido: ${resultado}`, 'ACK_INVALIDO');

  const agotarSiToca = resultado === 'fallido';
  const { rows } = await pool.query(
    `UPDATE impresion_trabajos
        SET estado = CASE
                       WHEN $3 = 'enviado'  THEN 'enviado'
                       WHEN $3 = 'incierto' THEN 'incierto'
                       WHEN $4 AND intentos + 1 >= $5 THEN 'agotado'
                       ELSE 'fallido'
                     END,
            intentos = intentos + 1,
            ultimo_error = $6,
            acked_at = NOW()
      WHERE id = $1 AND terminal_id = $2 AND estado NOT IN ('enviado','cancelado')
      RETURNING id, estado, intentos, ultimo_error`,
    [trabajoId, terminalId, resultado, agotarSiToca, MAX_INTENTOS, error ? String(error).slice(0, 500) : null]
  );
  return rows[0] || null;
}

// Tras este número de intentos fallidos el trabajo pasa a 'agotado': deja de
// reintentarse solo, pero NO se pierde -- aparece en el estado como algo que
// necesita una persona (impresora sin papel, cable suelto, IP cambiada).
export const MAX_INTENTOS = 8;

export async function estadoImpresion(negocioId, { sucursalId = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const { rows: impresoras } = await pool.query(
    `SELECT i.id, i.nombre, i.activa, i.transporte, i.host, i.puerto,
            t.id AS terminal_id, t.nombre AS terminal_nombre, t.activo AS terminal_activa, t.ultima_conexion,
            (SELECT count(*)::int FROM impresion_trabajos j
              WHERE j.impresora_id = i.id AND j.estado IN ('pendiente','entregado','fallido')) AS pendientes,
            (SELECT count(*)::int FROM impresion_trabajos j
              WHERE j.impresora_id = i.id AND j.estado IN ('agotado','incierto')) AS requieren_atencion,
            (SELECT max(j.acked_at) FROM impresion_trabajos j
              WHERE j.impresora_id = i.id AND j.estado = 'enviado') AS ultimo_envio,
            (SELECT j.ultimo_error FROM impresion_trabajos j
              WHERE j.impresora_id = i.id AND j.ultimo_error IS NOT NULL
              ORDER BY j.updated_at DESC LIMIT 1) AS ultimo_error
       FROM impresoras i
       JOIN terminales t ON t.id = i.terminal_id
      WHERE i.negocio_id = $1 AND ($2::uuid IS NULL OR i.sucursal_id = $2)
      ORDER BY i.nombre`,
    [nid, sucursalId]
  );
  return { impresoras };
}

export async function listarTrabajos(negocioId, { limite = 50, estado = null } = {}) {
  const nid = exigirNegocio(negocioId);
  const { rows } = await pool.query(
    `SELECT id, documento, impresora_nombre, estado, intentos, ultimo_error,
            origen_tipo, origen_id, created_at, acked_at, trabajo_original_id
       FROM impresion_trabajos
      WHERE negocio_id = $1 AND ($2::text IS NULL OR estado = $2)
      ORDER BY created_at DESC LIMIT $3`,
    [nid, estado, Math.min(Number(limite) || 50, 200)]
  );
  return rows;
}
