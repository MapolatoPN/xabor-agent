// Operación explícita del dueño: activa (o revierte) el formulario «tienda»
// (contrato tienda_v1) de un negocio. No envía mensajes ni publica en Meta;
// solo escribe whatsapp_flow_tienda_id, la bandera whatsapp_flow_tienda_v1, los
// teléfonos de prueba y su respaldo, juntos. Ejecutar sobre el SHA revisado y
// desplegado, a una hora sin formularios abiertos. Exige la dirección y la
// nota ya activas (activar-flows-direccion.mjs, activar-flows-nota.mjs) y el
// Flow de la tienda PUBLICADO en la WABA del negocio
// (publicar-flows-pedido.mjs <negocio> publicar tienda).
//
//   node scripts/activar-flows-tienda.mjs <negocioId> <sha> activar <flowId> --prueba <tel[,tel…]> [--con-formularios-abiertos]
//   node scripts/activar-flows-tienda.mjs <negocioId> <sha> activar <flowId> --todos [--con-formularios-abiertos]
//   node scripts/activar-flows-tienda.mjs <negocioId> <sha> revertir
//
// Activar se niega si hay formularios abiertos en los últimos 30 minutos que la
// tienda cortaría (la misma barrera del endpoint, sinTiendaVieja): con --prueba,
// solo los de los teléfonos de la lista. El flag lo fuerza: esos formularios
// responderán «ya no está disponible». Pasar de --prueba a --todos es otra
// activación sobre el mismo Flow: conserva el respaldo original. Revertir no espera ni consulta Meta: es la salida de
// emergencia; una tienda abierta responde «ya no está disponible» y el cliente
// recibe otra vez «Arma tu pedido» o «Tu carrito» de siempre.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { pool } from '../src/services/database.js';
import { credencialFlows, clienteMetaFlows } from './lib-meta-flows.mjs';
import { CLAVE_RESPALDO_TIENDA, planActivacionTienda, planReversaTienda } from '../src/mesero-agente/activacionTienda.js';
import { sinTiendaVieja } from '../src/mesero-agente/disponibilidadTienda.js';
import { definicionFlowTienda, nombreFlowTienda, validarFlowTienda } from './definicion-flow-tienda.mjs';

export const ENDPOINT_FLOWS = 'https://xabor.mx/webhook/flows/pedido';
const leerCfg = async (db, negocioId, bloquear) => Object.fromEntries((await db.query(
  `SELECT clave,valor FROM configuracion WHERE negocio_id=$1${bloquear ? ' FOR UPDATE' : ''}`, [negocioId])).rows.map((r) => [r.clave, r.valor]));

/**
 * Comprueba en Meta cada Flow del plan: de la WABA de ESTE negocio (el nombre
 * por huella es el mismo en todos los negocios), PUBLICADO, sin errores, con el
 * endpoint de Xabor y con el nombre de la definición de este build.
 */
export async function revisarFlowsEnMeta(negocioId, flows, definicion) {
  const cred = await credencialFlows(negocioId), api = clienteMetaFlows(cred.token);
  const propios = (await api(`${cred.wabaId}/flows?fields=id&limit=100`)).data.map((x) => x.id);
  for (const [id] of flows) {
    assert(propios.includes(id), `Flow ${id} no es de la WABA de este negocio`);
    const f = await api(`${id}?fields=id,name,status,validation_errors,endpoint_uri`);
    assert.equal(f.status, 'PUBLISHED', `Flow ${id} no publicado`);
    assert(!f.validation_errors?.length, `Flow ${id} con errores`);
    assert.equal(f.endpoint_uri, ENDPOINT_FLOWS, `Flow ${id} con otro endpoint`);
    assert.equal(f.name, nombreFlowTienda(definicion), `Flow ${id} no es la definición de la tienda de este build`);
  }
}

/**
 * La operación entera. `revisarMeta` se inyecta en las pruebas (sin red); el
 * comando usa revisarFlowsEnMeta. Devuelve lo que imprime el comando.
 */
export async function operarTienda({ db = pool, negocioId, sha, modo, flowId, alcance = {}, forzar = false,
  revisarMeta = revisarFlowsEnMeta, definicion = definicionFlowTienda() } = {}) {
  assert.match(negocioId || '', /^[0-9a-f-]{36}$/);
  assert.match(sha || '', /^[a-f0-9]{40}$/);
  assert(['activar', 'revertir'].includes(modo));
  // La definición de ESTE build: su nombre en Meta es su huella. Un Flow con otra
  // definición recibiría datos que no declara (Meta rechazaría la pantalla).
  assert.deepEqual(validarFlowTienda(definicion), [], 'La definición de la tienda de este build no pasa su validador');
  // Meta se consulta ANTES de abrir la transacción: nada queda bloqueado
  // mientras responde (los mensajes, el outbox y la impresión siguen).
  if (modo === 'activar') {
    const plan = planActivacionTienda(await leerCfg(db, negocioId, false), flowId, alcance);
    assert(!plan.error, plan.error);
    await revisarMeta(negocioId, plan.flows, definicion);
  }
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL lock_timeout='3s'");
    // La misma llave que activar-flows-direccion.mjs y activar-flows-nota.mjs:
    // las tres escriben la misma configuración y la tienda depende de las otras dos.
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('activar-flows-direccion:' || $1,0))", [negocioId]);
    const { rows: [n] } = await tx.query('SELECT id FROM negocios WHERE id=$1', [negocioId]);
    assert(n, 'Negocio inexistente');
    // Releída con FOR UPDATE: si cambió mientras se revisaba Meta, el plan se
    // vuelve a calcular sobre lo que hay (y falla si ya no cuadra).
    const cfg = await leerCfg(tx, negocioId, true);
    let aplicar, abiertos = null;
    if (modo === 'activar') {
      const plan = planActivacionTienda(cfg, flowId, alcance);
      assert(!plan.error, plan.error);
      // Un «Arma tu pedido» o «Tu carrito» abierto deja de servir al encender la
      // tienda PARA SU CLIENTE. Cuentan solo los que la barrera del endpoint
      // (sinTiendaVieja, con la configuración resultante) cortaría: en modo
      // 'prueba', los de los teléfonos de la lista; al cambiar el alcance, también
      // la tienda abierta de quien sale de ella. Sesión ilegible: cuenta.
      const despues = Object.fromEntries(Object.entries({ ...cfg, ...plan.cambios }).filter(([, v]) => v !== null));
      const { rows: abiertas } = await tx.query(`SELECT q.session_id, b.datos FROM agente_preguntas_interactivas q
        JOIN agente_botones b ON b.pregunta_id=q.id
        WHERE q.negocio_id=$1 AND q.estado='disponible' AND b.accion IN ('flow_productos','flow_configurar')
          AND q.created_at>clock_timestamp()-interval '30 minutes'`, [negocioId]);
      abiertos = { n: abiertas.filter((q) => {
        const telefono = /^agente:(\d{8,15})$/.exec(q.session_id || '')?.[1];
        return !telefono || sinTiendaVieja(despues, q.datos, telefono);
      }).length };
      assert(forzar || abiertos.n === 0, `Hay ${abiertos.n} formulario(s) abierto(s) en los últimos 30 minutos que la tienda cortaría: intenta más tarde`);
      await tx.query(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
        ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`,
      [negocioId, CLAVE_RESPALDO_TIENDA, JSON.stringify({ build: sha, fecha: new Date().toISOString(), ...plan.respaldo })]);
      aplicar = plan.cambios;
    } else {
      const plan = planReversaTienda(cfg);
      assert(!plan.error, plan.error);
      aplicar = plan.aplicar;
      await tx.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [negocioId, CLAVE_RESPALDO_TIENDA]);
    }
    for (const [k, v] of Object.entries(aplicar)) {
      if (v === null) await tx.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [negocioId, k]);
      else await tx.query(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
        ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`, [negocioId, k, v]);
    }
    await tx.query('COMMIT');
    return { modo, negocioId, build: sha, cambios: aplicar, formulariosAbiertos: abiertos?.n ?? null, envios: 0 };
  } catch (e) { await tx.query('ROLLBACK').catch(() => {}); throw e; }
  finally { tx.release(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), [negocioId, sha, modo, flowId] = args;
  try {
    assert.equal(process.env.RAILWAY_GIT_COMMIT_SHA, sha, 'Build distinto al revisado');
    const todos = args.includes('--todos'), iPrueba = args.indexOf('--prueba');
    if (modo === 'activar') assert(todos !== (iPrueba >= 0), 'Indica el alcance: --prueba <teléfonos> o --todos (uno de los dos)');
    const alcance = { modo: todos ? 'true' : 'prueba', telefonos: iPrueba >= 0 ? args[iPrueba + 1] : '' };
    console.log(JSON.stringify(await operarTienda({ negocioId, sha, modo, flowId, alcance, forzar: args.includes('--con-formularios-abiertos') })));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
