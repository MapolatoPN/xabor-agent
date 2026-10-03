// Operación explícita del dueño (2-oct-2026): dejar la configuración de un
// negocio igual a la de otro (Mapolato Acuña igual a Obispado), salvo sus datos
// generales. Copia una LISTA CERRADA de claves del origen; los Flows, los
// teléfonos de prueba, el horario y lo propio del destino llegan en un archivo
// de ajustes (local, sin commit: lleva teléfonos). Guarda respaldo y revierte.
// El origen solo se lee. Se corre con la base de producción (DATABASE_URL).
//
//   node scripts/copiar-configuracion-negocio.mjs <origen> <destino> preparar <ajustes.json>
//   node scripts/copiar-configuracion-negocio.mjs <origen> <destino> abrir
//   node scripts/copiar-configuracion-negocio.mjs <origen> <destino> revertir
//
// «preparar» deja el destino en SOLO PRUEBA (atiende únicamente los teléfonos de
// prueba) y exige el bot del destino apagado. «abrir» pasa a atender a todos.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { validarEstructuraReglas } from '../src/agent/prompts.js';

/** Se copian iguales del origen: banderas del canal y criterios de operación. */
export const CLAVES_COPIADAS = Object.freeze([
  'mesero_agente_v1', 'mesero_agente_shadow', 'whatsapp_interactivos_v1', 'whatsapp_interactivos_elecciones_v1',
  'whatsapp_flows_v1', 'whatsapp_beta_hibrido_v1', 'whatsapp_carrito_unificado_v1', 'whatsapp_flow_carrito_duplicar_v1',
  'whatsapp_catalogo_nativo_v1', 'whatsapp_promociones_proactivas_v1', 'whatsapp_trazabilidad_formularios_v1',
  'whatsapp_inicio_mapo_v1', 'timezone', 'iva_pct_default', 'anticipo_porcentaje_default', 'vigencia_dias_default',
  'cotizacion_perfil', 'terminos_cotizacion_default', 'bot_avisos', 'color_primario', 'logo_base64', 'logo_url',
  'caja_propinas_tarjeta_efectivo',
]);
/** Flows: son de la WABA de cada negocio; el destino trae los suyos. */
export const CLAVES_FLOWS = Object.freeze(['whatsapp_flow_productos_id', 'whatsapp_flow_configurar_id', 'whatsapp_flow_pedido_id',
  'whatsapp_flow_editar_id', 'whatsapp_flow_repetible_id', 'whatsapp_flow_categorias_id', 'whatsapp_flow_carrito_id',
  'whatsapp_flow_facturacion_id', 'whatsapp_flow_evento_id']);
export const CLAVE_RESPALDO = 'configuracion_copia_respaldo';
export const CLAVE_RESPALDO_APERTURA = 'configuracion_apertura_respaldo';
const APERTURA = Object.freeze({ bot_whatsapp_solo_prueba: 'false', whatsapp_atencion_general_v1: 'true',
  mesero_agente_porcentaje: '100', mesero_agente_telefonos: '' });
const DIAS = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];

/** Los cambios de «preparar», o lanza con el motivo. Puro: lo prueba el chequeo. */
export function planPreparar(cfgOrigen, cfgDestino, ajustes) {
  const cambios = {};
  for (const k of CLAVES_COPIADAS) if (cfgOrigen[k] !== undefined) cambios[k] = cfgOrigen[k];
  const flows = ajustes.flows || {};
  for (const [k, id] of Object.entries(flows)) {
    assert(CLAVES_FLOWS.includes(k), `clave de Flow desconocida: ${k}`);
    assert.match(String(id), /^\d{10,30}$/, `flowId inválido en ${k}`);
    assert.notEqual(String(id), cfgOrigen[k], `${k}: es el Flow del origen (otra WABA)`);
    cambios[k] = String(id);
  }
  const telefonos = ajustes.telefonosPrueba;
  assert(Array.isArray(telefonos) && telefonos.length && telefonos.every((t) => /^\d{12,13}$/.test(t)), 'telefonosPrueba: lista de números 52/521');
  Object.assign(cambios, { bot_whatsapp_solo_prueba: 'true', mesero_agente_porcentaje: '0', mesero_agente_telefonos: telefonos.join(','),
    whatsapp_flows_telefonos: telefonos.join(','), whatsapp_beta_telefonos: telefonos.join(','), whatsapp_atencion_general_v1: 'false' });
  if (ajustes.horarioTexto !== undefined) { assert.equal(typeof ajustes.horarioTexto, 'string'); cambios.horario = ajustes.horarioTexto; }
  // Reglas del bot: las del origen, con el horario, las zonas y el texto propios del destino.
  const reglas = structuredClone(JSON.parse(cfgOrigen.reglas_atencion));
  assert(ajustes.horarios && DIAS.every((d) => typeof ajustes.horarios[d]?.abierto === 'boolean'), 'horarios: los 7 días con abierto');
  reglas.horarios = ajustes.horarios;
  reglas.pedidos.zonas_entrega = Array.isArray(ajustes.zonas) ? ajustes.zonas : [];
  if (ajustes.informacionImportante !== undefined) reglas.bot = { ...(reglas.bot || {}), informacion_importante: String(ajustes.informacionImportante) };
  // Las preguntas frecuentes llevan datos propios del negocio (el 3-oct, el
  // teléfono para preguntar por mesas). Si el origen las tiene, el destino
  // debe dar las suyas: nunca se copia el teléfono de otra sucursal.
  if (reglas.bot?.faqs?.length || ajustes.faqs !== undefined) {
    assert(Array.isArray(ajustes.faqs), 'faqs: el origen tiene preguntas frecuentes propias; da las del destino en ajustes.faqs');
    reglas.bot = { ...(reglas.bot || {}), faqs: ajustes.faqs };
  }
  assert(validarEstructuraReglas(reglas), 'las reglas resultantes no tienen la estructura esperada');
  cambios.reglas_atencion = JSON.stringify(reglas);
  for (const k of [CLAVE_RESPALDO, CLAVE_RESPALDO_APERTURA]) assert(!(k in cambios));
  return cambios;
}

async function escribir(db, negocioId, cambios) {
  for (const [k, v] of Object.entries(cambios)) {
    if (v === null) await db.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [negocioId, k]);
    else await db.query(`INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)
      ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor`, [negocioId, k, v]);
  }
}
const leerCfg = async (db, id, bloquear) => Object.fromEntries((await db.query(
  `SELECT clave,valor FROM configuracion WHERE negocio_id=$1${bloquear ? ' FOR UPDATE' : ''}`, [id])).rows.map((r) => [r.clave, r.valor]));

export async function ejecutar(pool, { origen, destino, modo, ajustes }) {
  assert.notEqual(origen, destino, 'origen y destino son el mismo negocio');
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SET LOCAL lock_timeout='5s'");
    await db.query("SELECT pg_advisory_xact_lock(hashtextextended('copiar-configuracion:' || $1, 0))", [destino]);
    const { rows: [neg] } = await db.query('SELECT bot_whatsapp_activo FROM negocios WHERE id=$1', [destino]);
    assert(neg, 'destino inexistente');
    const cfgO = await leerCfg(db, origen, false), cfgD = await leerCfg(db, destino, true);
    let aplicar, respaldoClave, respaldo = null;
    if (modo === 'preparar') {
      assert.equal(neg.bot_whatsapp_activo, false, 'Preparar con el bot del destino apagado');
      const cambios = planPreparar(cfgO, cfgD, ajustes);
      const previo = cfgD[CLAVE_RESPALDO] ? JSON.parse(cfgD[CLAVE_RESPALDO]) : null;
      if (previo) {
        assert(Object.entries(cambios).every(([k, v]) => cfgD[k] === v), 'Ya hay una copia con otros valores: revertir antes');
        await db.query('ROLLBACK');
        return { sinCambios: true };
      }
      respaldoClave = CLAVE_RESPALDO;
      respaldo = { origen, fecha: new Date().toISOString(), antes: Object.fromEntries(Object.keys(cambios).map((k) => [k, cfgD[k] ?? null])), despues: cambios };
      aplicar = cambios;
    } else if (modo === 'abrir') {
      assert(cfgD[CLAVE_RESPALDO], 'Primero «preparar»');
      assert.equal(neg.bot_whatsapp_activo, true, 'El bot del destino está apagado: enciéndelo y pruébalo antes de abrir');
      if (Object.entries(APERTURA).every(([k, v]) => cfgD[k] === v)) { await db.query('ROLLBACK'); return { sinCambios: true }; }
      assert(!cfgD[CLAVE_RESPALDO_APERTURA], 'Ya hay respaldo de apertura con otros valores');
      respaldoClave = CLAVE_RESPALDO_APERTURA;
      respaldo = { fecha: new Date().toISOString(), antes: Object.fromEntries(Object.keys(APERTURA).map((k) => [k, cfgD[k] ?? null])), despues: APERTURA };
      aplicar = APERTURA;
    } else if (modo === 'revertir') {
      const clave = cfgD[CLAVE_RESPALDO_APERTURA] ? CLAVE_RESPALDO_APERTURA : CLAVE_RESPALDO;
      assert(cfgD[clave], 'Sin respaldo no se revierte');
      const r = JSON.parse(cfgD[clave]);
      aplicar = {};
      for (const [k, despues] of Object.entries(r.despues)) {
        const actual = cfgD[k] ?? null, antes = r.antes[k] ?? null;
        if (actual === despues) aplicar[k] = antes;
        else assert.equal(actual, antes, `La configuración cambió después (${k}): no sobrescribir`);
      }
      await db.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2', [destino, clave]);
    } else throw new Error('Modo: preparar | abrir | revertir');
    if (respaldo) await db.query('INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)', [destino, respaldoClave, JSON.stringify(respaldo)]);
    await escribir(db, destino, aplicar);
    const final = await leerCfg(db, destino, false);
    for (const [k, v] of Object.entries(aplicar)) assert.equal(final[k] ?? null, v, `no quedó ${k}`);
    await db.query('COMMIT');
    return { modo, claves: Object.keys(aplicar).length, botDestinoActivo: neg.bot_whatsapp_activo };
  } catch (e) { await db.query('ROLLBACK').catch(() => {}); throw e; }
  finally { db.release(); }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [origen, destino, modo, archivo] = process.argv.slice(2);
  for (const id of [origen, destino]) assert.match(id || '', /^[0-9a-f-]{36}$/, 'negocio inválido');
  const ajustes = modo === 'preparar' ? JSON.parse(fs.readFileSync(archivo, 'utf8')) : null;
  const { pool } = await import('../src/services/database.js');
  try { console.log(JSON.stringify(await ejecutar(pool, { origen, destino, modo, ajustes }))); }
  catch (e) { console.error('FALLA:', e.message); process.exitCode = 1; }
  finally { await pool.end(); }
}
