/**
 * equiposImpresion.js — «Olvidar este equipo» (Config → Impresoras).
 *
 * Un equipo es una PC con Xabor Edge (una fila de `terminales`). Hasta ahora
 * no había forma de quitar uno desde el panel, y se juntaban fantasmas: altas
 * de «Conectar otro equipo» cuyo instalador nunca terminó (5 en Acuña y 4 en
 * Obispado al 20-oct-2026), o la PC que se cambió y dejó 70 comandas
 * esperándola.
 *
 * Olvidar NO borra filas: deja el equipo apagado y sin credencial, con su
 * historial de trabajos intacto. En una sola transacción:
 *
 *   - cancela lo que seguía esperando a ese equipo (pendiente, entregado sin
 *     confirmar o fallido con reintentos), con su motivo, para que no salga de
 *     golpe si la PC volviera y no cuente como pendiente en ningún lado.
 *     «incierto» y «agotado» no se tocan: ya los revisa una persona;
 *   - quita las rutas de sus impresoras (lo que salía ahí pasa a Cocina) y
 *     apaga esas impresoras;
 *   - apaga el equipo, le retira la credencial y cancela un código de
 *     vinculación sin usar: aunque la PC volviera, ya no entra;
 *   - les cambia el nombre a equipo e impresoras («… (olvidado 2026-10-20 ·
 *     1a2b3c4d)»): los nombres son únicos por sucursal, y sin esto no se podría
 *     volver a dar de alta «caja» ni configurar una impresora del mismo modelo
 *     en la PC nueva;
 *   - lo deja escrito en auditoria_plataforma.
 *
 * Un equipo conectado (o que dio señal en los últimos minutos) no se puede
 * olvidar: está imprimiendo.
 */
import { pool, registrarAuditoriaPlataforma } from './database.js';
import { MINUTOS_GRACIA_CONEXION } from './impresionService.js';

function errorCodigo(mensaje, code) {
  const e = new Error(mensaje);
  e.code = code;
  return e;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ESTADOS_EN_ESPERA = ['pendiente', 'entregado', 'fallido'];
export const MOTIVO_OLVIDO = 'Equipo olvidado desde el panel';

async function equipoDelNegocio(cliente, negocioId, terminalId, { bloquear = false } = {}) {
  if (typeof terminalId !== 'string' || !UUID_RE.test(terminalId)) throw errorCodigo('Equipo no encontrado', 'EDGE_NO_ENCONTRADO');
  const { rows: [t] } = await cliente.query(
    `SELECT t.id, t.nombre, t.ultima_conexion,
            COALESCE(t.ultima_conexion > NOW() - make_interval(mins => $3), false) AS visto_reciente
       FROM terminales t JOIN sucursales s ON s.id = t.sucursal_id
      WHERE t.id = $1 AND s.negocio_id = $2 AND t.activo
      ${bloquear ? 'FOR UPDATE OF t' : ''}`,
    [terminalId, negocioId, MINUTOS_GRACIA_CONEXION]);
  if (!t) throw errorCodigo('Equipo no encontrado', 'EDGE_NO_ENCONTRADO');
  return t;
}

const conectado = (t, estaConectado) => {
  let vivo = false;
  try { vivo = estaConectado(t.id) === true; } catch { vivo = false; }
  return vivo || t.visto_reciente === true;
};

// Lo que se perdería, para que el panel lo diga ANTES de confirmar.
export async function resumenParaOlvidar(negocioId, terminalId, { estaConectado = () => false } = {}) {
  const t = await equipoDelNegocio(pool, negocioId, terminalId);
  const { rows: impresoras } = await pool.query(
    `SELECT nombre FROM impresoras WHERE terminal_id = $1 ORDER BY nombre`, [t.id]);
  const { rows: rutas } = await pool.query(
    `SELECT r.ambito, r.clave, i.nombre AS impresora
       FROM impresion_rutas r JOIN impresoras i ON i.id = r.impresora_id
      WHERE i.terminal_id = $1 ORDER BY r.ambito, r.clave`, [t.id]);
  const { rows: [espera] } = await pool.query(
    `SELECT count(*)::int AS n FROM impresion_trabajos WHERE terminal_id = $1 AND estado = ANY($2::text[])`,
    [t.id, ESTADOS_EN_ESPERA]);
  return {
    id: t.id,
    nombre: t.nombre,
    ultimaConexion: t.ultima_conexion,
    conectado: conectado(t, estaConectado),
    impresoras: impresoras.map((i) => i.nombre),
    rutas: rutas.map((r) => ({ ambito: r.ambito, clave: r.clave, impresora: r.impresora })),
    trabajosEnEspera: espera.n,
  };
}

export async function olvidarEquipo(negocioId, terminalId, { estaConectado = () => false, actor = null } = {}) {
  const cliente = await pool.connect();
  try {
    await cliente.query('BEGIN');
    const t = await equipoDelNegocio(cliente, negocioId, terminalId, { bloquear: true });
    if (conectado(t, estaConectado)) {
      throw errorCodigo('Ese equipo está conectado ahora mismo. Si de verdad ya no se usa, cierra Xabor Edge en esa computadora y vuelve a intentarlo en unos minutos.', 'EQUIPO_CONECTADO');
    }
    const marca = `olvidado ${new Date().toISOString().slice(0, 10)} · ${t.id.slice(0, 8)}`;

    const { rows: cancelados } = await cliente.query(
      `UPDATE impresion_trabajos SET estado = 'cancelado', motivo = $3, updated_at = NOW()
        WHERE terminal_id = $1 AND estado = ANY($2::text[]) RETURNING id`,
      [t.id, ESTADOS_EN_ESPERA, MOTIVO_OLVIDO]);
    const { rows: rutas } = await cliente.query(
      `DELETE FROM impresion_rutas r USING impresoras i
        WHERE i.id = r.impresora_id AND i.terminal_id = $1
        RETURNING r.ambito, r.clave, i.nombre AS impresora`, [t.id]);
    const { rows: impresoras } = await cliente.query(
      `UPDATE impresoras SET activa = false, nombre = nombre || ' (' || $2 || ')'
        WHERE terminal_id = $1 RETURNING id`, [t.id, marca]);
    await cliente.query(
      `UPDATE terminales SET activo = false, token_hash = NULL,
              nombre = nombre || ' (' || $2 || ')', codigo = codigo || '-olvidado-' || left(id::text, 8)
        WHERE id = $1`, [t.id, marca]);
    await cliente.query(
      `UPDATE edge_emparejamientos SET usado_at = NOW() WHERE terminal_id = $1 AND usado_at IS NULL`, [t.id]);

    if (actor) {
      await registrarAuditoriaPlataforma({
        ...actor, accion: 'olvidar_equipo_impresion', negocioId,
        estadoAnterior: { terminalId: t.id, nombre: t.nombre, ultimaConexion: t.ultima_conexion },
        estadoNuevo: { activo: false, trabajosCancelados: cancelados.length, rutasQuitadas: rutas, impresorasApagadas: impresoras.length },
      }, cliente);
    }
    await cliente.query('COMMIT');
    return { ok: true, nombre: t.nombre, trabajosCancelados: cancelados.length, rutasQuitadas: rutas.length, impresorasApagadas: impresoras.length };
  } catch (e) {
    await cliente.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    cliente.release();
  }
}
