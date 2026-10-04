// Operación explícita del dueño: activa (o revierte) el modo formulario /
// recepcionista del WhatsApp de un negocio (src/mesero-agente/recepcionista.js:
// los pedidos SOLO en el formulario; la IA, recepcionista para dudas). No envía
// mensajes ni toca Meta; solo escribe whatsapp_ia_modo_v1, el alcance, los
// teléfonos de prueba, la publicación del selector, las preguntas frecuentes
// aprobadas (si se pasan) y su respaldo, juntos y en una transacción. Ejecutar
// sobre el SHA revisado y desplegado.
//
//   node scripts/activar-modo-ia.mjs <negocioId> <sha> plan     --formulario|--recepcionista --prueba <tel[,tel…]>|--todos [--publicar-selector] [--faqs archivo.json]
//   node scripts/activar-modo-ia.mjs <negocioId> <sha> activar  (mismos argumentos)
//   node scripts/activar-modo-ia.mjs <negocioId> <sha> revertir
//
// `plan` no escribe nada: imprime las precondiciones, los avisos, el cambio de
// claves y el de las preguntas frecuentes (por pregunta). `activar` se niega si
// el plan tiene un error o una precondición que bloquea (Mesero con alcance
// completo, formularios, botones, rescate, inicio Mapo, beta híbrida, eventos
// por formulario y el formulario de pedido con la carta publicada), o si el
// archivo de preguntas no pasa validarArchivoFaqs (marcas [CONFIRMAR…], tarifas,
// repetidas, temas de la configuración…). Pasar de --prueba a --todos, de
// formulario a recepcionista o publicar el selector es otra activación sobre el
// mismo respaldo. Revertir restaura las claves de antes y las preguntas
// frecuentes de antes, sin pisar un cambio ajeno.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { pool, obtenerMetodosPagoDisponibles } from '../src/services/database.js';
import { CLAVE_RESPALDO_MODO_IA, planActivacionModoIA, planReversaModoIA, precondicionesDeActivacion } from '../src/mesero-agente/activacionModoIA.js';
import { telefonosDePrueba } from '../src/mesero-agente/activacionTienda.js';

const leerCfg = async (db, negocioId, bloquear) => Object.fromEntries((await db.query(
  `SELECT clave,valor FROM configuracion WHERE negocio_id=$1${bloquear ? ' FOR UPDATE' : ''}`, [negocioId])).rows.map((r) => [r.clave, r.valor]));

/**
 * Lo que las precondiciones necesitan saber de la base (solo lectura): la carta
 * publicada, el menú en imagen, la tienda en línea, el bot comercial heredado,
 * las modalidades, las formas de pago y las reglas.
 */
export async function leerHechos(db, negocioId, cfg) {
  const { obtenerCatalogoDelAgente } = await import('../src/services/catalogoWhatsapp.js');
  const { obtenerConfigTienda } = await import('../src/services/tiendaOnline.js');
  const catalogo = await obtenerCatalogoDelAgente(negocioId).catch(() => null);
  const { rows: [menu] } = await db.query('SELECT activo FROM whatsapp_menu_automatico WHERE negocio_id=$1', [negocioId]);
  const { rows: [modulo] } = await db.query(`SELECT estado FROM negocio_modulos
    WHERE negocio_id=$1 AND modulo='asistente_comercial_cotizaciones'`, [negocioId]);
  let reglas = {};
  try { reglas = JSON.parse(cfg.reglas_atencion || '{}') || {}; } catch { reglas = {}; }
  return {
    carta: Array.isArray(catalogo?.carta) && !catalogo?.error ? catalogo.carta : [],
    menuAutomaticoActivo: menu?.activo === true,
    configTienda: await obtenerConfigTienda(negocioId).catch(() => null),
    comercialCatering: cfg.cotizacion_perfil === 'catering' && modulo?.estado === 'activo',
    modalidades: Array.isArray(reglas?.pedidos?.modalidades) ? reglas.pedidos.modalidades : null,
    metodosPago: await obtenerMetodosPagoDisponibles(negocioId, { paraBot: true }).catch(() => []),
    reglas,
  };
}

/** El cambio de preguntas frecuentes, por pregunta (para `plan`). */
function diferenciaDeFaqs(cfg, nuevas) {
  if (!nuevas) return null;
  let antes = [];
  try { antes = JSON.parse(cfg.reglas_atencion || '{}')?.bot?.faqs || []; } catch { antes = []; }
  const porPregunta = (l) => new Map(l.map((f) => [String(f.pregunta || '').trim(), String(f.respuesta || '').trim()]));
  const a = porPregunta(antes), d = porPregunta(nuevas);
  return {
    quedan: [...d.keys()].filter((p) => a.has(p) && a.get(p) === d.get(p)),
    cambian: [...d.keys()].filter((p) => a.has(p) && a.get(p) !== d.get(p)),
    nuevas: [...d.keys()].filter((p) => !a.has(p)),
    salen: [...a.keys()].filter((p) => !d.has(p)),
  };
}

const escribirClaves = async (tx, negocioId, claves) => {
  for (const [k, v] of Object.entries(claves)) {
    if (v === null) await tx.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [negocioId, k]);
    else await tx.query(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
      ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`, [negocioId, k, v]);
  }
};

/**
 * La operación entera. `hechosDe` se inyecta en las pruebas. `faqs` es el
 * contenido YA LEÍDO del archivo (un arreglo) o null. Devuelve lo que imprime
 * el comando.
 */
export async function operarModoIA({ db = pool, negocioId, sha, accion, modo, alcance, telefonos = '', publicarSelector = false,
  faqs = null, hechosDe = leerHechos } = {}) {
  assert.match(negocioId || '', /^[0-9a-f-]{36}$/);
  assert.match(sha || '', /^[a-f0-9]{40}$/);
  assert(['plan', 'activar', 'revertir'].includes(accion), 'Acción: plan, activar o revertir');
  if (accion === 'plan') {
    const cfg = await leerCfg(db, negocioId, false);
    const hechos = await hechosDe(db, negocioId, cfg);
    const plan = planActivacionModoIA(cfg, { modo, alcance, telefonos, hechos, publicarSelector, faqs });
    const lista = alcance === 'prueba' ? telefonosDePrueba(telefonos) || [] : [];
    return { accion, negocioId, build: sha, error: plan.error || null,
      precondiciones: plan.precondiciones || precondicionesDeActivacion(cfg, { alcance, telefonos: lista, hechos }),
      avisos: plan.avisos || [], cambios: plan.cambios || null,
      antes: plan.cambios ? Object.fromEntries(Object.keys(plan.cambios).map((k) => [k, cfg[k] ?? null])) : null,
      faqs: plan.error ? null : diferenciaDeFaqs(cfg, plan.faqs), escrituras: 0 };
  }
  // Las lecturas de la carta y la tienda van ANTES de la transacción: nada
  // queda bloqueado mientras se leen.
  const hechos = accion === 'activar' ? await hechosDe(db, negocioId, await leerCfg(db, negocioId, false)) : null;
  const tx = await db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL lock_timeout='3s'");
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('activar-modo-ia:' || $1,0))", [negocioId]);
    const { rows: [n] } = await tx.query('SELECT id FROM negocios WHERE id=$1', [negocioId]);
    assert(n, 'Negocio inexistente');
    // Releída con FOR UPDATE: el plan se vuelve a calcular sobre lo que hay.
    const cfg = await leerCfg(tx, negocioId, true);
    let aplicar, extra = {}, avisos = [];
    if (accion === 'activar') {
      const plan = planActivacionModoIA(cfg, { modo, alcance, telefonos, hechos, publicarSelector, faqs });
      assert(!plan.error, plan.error);
      avisos = plan.avisos;
      await escribirClaves(tx, negocioId, { [CLAVE_RESPALDO_MODO_IA]:
        JSON.stringify({ build: sha, fecha: new Date().toISOString(), ...plan.respaldo }) });
      aplicar = plan.cambios;
      extra = plan.extra || {};
    } else {
      const plan = planReversaModoIA(cfg);
      assert(!plan.error, plan.error);
      aplicar = plan.aplicar;
      extra = plan.extra || {};
      await tx.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [negocioId, CLAVE_RESPALDO_MODO_IA]);
    }
    await escribirClaves(tx, negocioId, { ...aplicar, ...extra });
    await tx.query('COMMIT');
    return { accion, negocioId, build: sha, cambios: aplicar, faqs: extra.reglas_atencion ? 'reemplazadas' : 'sin cambio', avisos, envios: 0 };
  } catch (e) { await tx.query('ROLLBACK').catch(() => {}); throw e; }
  finally { tx.release(); }
}

/** Lee el archivo de --faqs (JSON). Un archivo ilegible es un error, nunca «sin faqs». */
export function leerArchivoFaqs(ruta) {
  assert(ruta && !ruta.startsWith('--'), 'Con --faqs indica la ruta del archivo JSON');
  return JSON.parse(readFileSync(ruta, 'utf8'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2), [negocioId, sha, accion] = args;
  try {
    assert.equal(process.env.RAILWAY_GIT_COMMIT_SHA, sha, 'Build distinto al revisado');
    const todos = args.includes('--todos'), iPrueba = args.indexOf('--prueba'), iFaqs = args.indexOf('--faqs');
    const formulario = args.includes('--formulario'), recepcionista = args.includes('--recepcionista');
    if (accion !== 'revertir') {
      assert(todos !== (iPrueba >= 0), 'Indica el alcance: --prueba <teléfonos> o --todos (uno de los dos)');
      assert(formulario !== recepcionista, 'Indica el modo: --formulario o --recepcionista (uno de los dos)');
    }
    console.log(JSON.stringify(await operarModoIA({ negocioId, sha, accion,
      modo: formulario ? 'formulario' : 'recepcionista', alcance: todos ? 'todos' : 'prueba',
      telefonos: iPrueba >= 0 ? args[iPrueba + 1] : '', publicarSelector: args.includes('--publicar-selector'),
      faqs: iFaqs >= 0 && accion !== 'revertir' ? leerArchivoFaqs(args[iFaqs + 1]) : null }), null, 2));
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
