// «Este formulario ya no está disponible», de punta a punta en una base local
// test_botones_* con un número como los de producción (521 + 10 dígitos).
//
// 23-oct-2026: en 14 días, 23 de 207 formularios de Obispado y Acuña acabaron
// así. Esta suite prueba las tres causas que se arreglaron:
//   personal   un «¿Pudo hacer su pedido?» del personal (lo que el panel le
//              recomienda) callaba al bot y mataba el formulario, porque
//              resolverIntervencionHumana buscaba la conversación con el
//              número SIN el 1. Las suites usaban números sin el 1.
//   vigencia   el formulario vencía a los 30 min del ENVÍO aunque el cliente lo
//              estuviera usando; ahora 30 min sin actividad (navegar cuenta),
//              tope 2 h. El envío final usa la misma regla.
//   reenvío    «Es que me sale que ya no está disponible» manda otro formulario.
// Red solo local, sin modelo, sin Meta.
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import express from 'express';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { atenderFlowRepetible } from '../src/mesero-agente/flowRepetibleSql.js';
import { registrarEndpointFlow } from '../src/mesero-agente/flowEndpoint.js';
import { resolverIntervencionHumana } from '../src/services/asistenciaFormulario.js';
import { varianteDeGrupo } from '../src/mesero-agente/catalogoFlowTienda.js';
import { peticionCifrada } from './lib-flow-cifrado.mjs';

Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });
const sinEfectos = async () => { throw Error('NO_PEDIDOS_PAGOS_TICKETS'); };
const IDS = { categorias: '66666666666', carrito: '77777777777', categoriasDir: '88888888888', carritoDir: '99999999999',
  categoriasNota: '12121212121', carritoNota: '13131313131', tienda: '14141414141' };
let n = 0, fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').filter(Boolean);
async function caso(clave, nombre, fn) {
  if (SOLO.length && !SOLO.includes(clave)) return;
  try { await fn(); console.log(`OK no-disponible-db ${++n} [${clave}]: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 300)} · esperado=${JSON.stringify(e.expected)?.slice(0, 200)}` : '';
    console.log(`FALLA no-disponible-db [${clave}]: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// ── El endpoint HTTP cifrado, como lo llama Meta ──────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
const ENV_HTTP = { WHATSAPP_FLOW_ENDPOINT: 'true', WHATSAPP_FLOW_PRIVATE_KEY: privateKey, META_APP_SECRET: 'secreto-local', NODE_ENV: 'test' };
const app = express();
// Sin promoción ni vitrina de la base: esta suite mide la vigencia.
registrarEndpointFlow(app, { db: pool, env: ENV_HTTP, atender: (db, s) => atenderFlowRepetible(db, s, { vitrina: async () => null, promo: async () => null }) });
const servidor = app.listen(0, '127.0.0.1'); await new Promise((r) => servidor.once('listening', r));
const URL_FLOWS = `http://127.0.0.1:${servidor.address().port}/webhook/flows/pedido`;
async function llamarCifrado(solicitud) {
  const p = peticionCifrada({ version: '3.0', ...solicitud }, publicKey, ENV_HTTP.META_APP_SECRET);
  const r = await fetch(URL_FLOWS, { method: 'POST', body: p.body, headers: p.headers });
  const cuerpo = await r.text();
  return { status: r.status, ...(r.status === 200 || r.status === 427 ? { respuesta: p.descifrar(cuerpo) } : {}) };
}

// ── Mapolato con la tienda y un cliente 521 ───────────────────────────────
// El modo formulario (IA recepcionista), como Obispado y Acuña: sus precondiciones.
const MODO_FORMULARIO = { whatsapp_ia_modo_v1: 'formulario', whatsapp_ia_modo_alcance: 'todos',
  whatsapp_flow_facturacion_id: '15151515151', whatsapp_flow_evento_id: '16161616161', whatsapp_eventos_formulario_v1: 'true',
  whatsapp_rescate_humano_v1: 'true', whatsapp_flujos_caducan_v1: 'true' };

async function fixture({ conUno = true, modoFormulario = false } = {}) {
  const f = await prepararNegocioBotones({ conUno });
  const reglas = { restaurante: 'Prueba aislada', timezone: 'America/Matamoros',
    horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
      .map((d) => [d, { abierto: true, apertura: '00:00', cierre: '24:00' }])),
    pedidos: { modalidades: ['recoger en tienda', 'entrega a domicilio'], tiempo_preparacion_minutos: 20,
      pedido_minimo_entrega: 0, costo_envio: 60, pago_aceptado: ['efectivo'], zonas_entrega: [{ nombre: 'Centro', costo: 60 }] },
    cierres_especiales: [], promociones: [], politicas: [] };
  const { rows: [cat] } = await pool.query("INSERT INTO menu_categorias(negocio_id,nombre,activa,orden) VALUES($1,'CHILAQUILES',true,0) RETURNING id", [f.negocioId]);
  const { rows: [p] } = await pool.query(`INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible,orden)
    VALUES($1,$2,'Chilaquiles Sencillos',195,true,0) RETURNING id`, [f.negocioId, cat.id]);
  await pool.query('INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado) VALUES($1,$2,true)', [f.negocioId, p.id]);
  for (const [orden, [nombre, opciones]] of [['Salsa', ['Roja', 'Verde']], ['Proteína', ['Pollo', 'Huevo']]].entries()) {
    const { rows: [g] } = await pool.query(`INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
      VALUES($1,$2,$3,true,1,1,$4) RETURNING id`, [f.negocioId, p.id, nombre, orden]);
    for (const [i, o] of opciones.entries()) await pool.query(`INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
      VALUES($1,$2,$3,0,true,$4)`, [f.negocioId, g.id, o, i]);
  }
  f.estado.carrito.items = [];
  await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2', [f.negocioId, `agente:${f.telefono}`, JSON.stringify(f.estado)]);
  await actualizarConfiguracion({ nombre: 'Mapolato Acuña', reglas_atencion: JSON.stringify(reglas),
    whatsapp_inicio_mapo_v1: 'true', whatsapp_atencion_general_v1: 'true', bot_whatsapp_solo_prueba: 'false',
    mesero_agente_porcentaje: '100', mesero_agente_telefonos: '', whatsapp_flows_v1: 'true', whatsapp_flows_telefonos: '',
    whatsapp_beta_hibrido_v1: 'true', whatsapp_beta_telefonos: '', whatsapp_carrito_unificado_v1: 'true',
    whatsapp_interactivos_elecciones_v1: 'true', whatsapp_flow_categorias_id: IDS.categorias, whatsapp_flow_carrito_id: IDS.carrito,
    whatsapp_flow_configurar_id: '44444444444', whatsapp_trazabilidad_formularios_v1: 'true',
    whatsapp_flow_categorias_dir_id: IDS.categoriasDir, whatsapp_flow_carrito_dir_id: IDS.carritoDir,
    whatsapp_flow_nota_v1: 'true', whatsapp_flow_categorias_nota_id: IDS.categoriasNota, whatsapp_flow_carrito_nota_id: IDS.carritoNota,
    whatsapp_flow_tienda_v1: 'true', whatsapp_flow_tienda_id: IDS.tienda, ...(modoFormulario ? MODO_FORMULARIO : {}) }, f.negocioId);
  const handoffs = [];

  const leer = () => leerEstadoVersionado(f.negocioId, f.telefono);
  const ident = () => ({ id: 'wamid.nd.' + randomUUID(), from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)) });
  const texto = (body) => ({ ...ident(), type: 'text', text: { body } });
  const recibo = (q, campos) => ({ ...ident(), type: 'interactive', context: { id: q.wamid }, interactive: { type: 'nfm_reply', nfm_reply: {
    name: 'flow', body: 'Sent', response_json: JSON.stringify({ flow_token: q.interactivo.action.parameters.flow_token, ...campos }) } } });
  const procesar = async (m) => {
    await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')
      ON CONFLICT (negocio_id,wamid) DO UPDATE SET estado='completado'`, [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
    const interaccion = m.type === 'interactive' ? { interaccion: { mensajes: [m], mixto: false } } : {};
    const r = await atenderConAgente({ ...f, mensaje: m.text?.body || '', wamids: [m.id], ...interaccion,
      llamarModelo: async () => { throw Error('NO_DEBE_LLAMAR_MODELO'); },
      escalarAHumano: async (neg, tel, motivo) => { handoffs.push(motivo); return true; },
      registrar: sinEfectos, emitir: sinEfectos, guardar: sinEfectos, crearPago: sinEfectos });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.outbox) return { r };
    const { rows: [fila] } = await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1', [r.outbox.clave]);
    const wamid = 'wamid.salida.' + randomUUID();
    if (!r.yaEntregado) assert.equal((await entregarRespuesta({ outboxClave: fila.evento_clave,
      enviar: async () => ({ messages: [{ id: wamid }] }), alHumano: sinEfectos })).estado, 'entregado');
    const { rows: [pregunta] } = await pool.query(`SELECT q.id,b.datos FROM agente_preguntas_interactivas q
      LEFT JOIN agente_botones b ON b.pregunta_id=q.id WHERE q.outbox_clave=$1 LIMIT 1`, [fila.evento_clave]);
    return { ...fila.carga, r, wamid, foto: pregunta?.datos ?? null, preguntaId: pregunta?.id ?? null };
  };
  const flow = (q) => {
    const flow_token = q.interactivo.action.parameters.flow_token;
    return { crudo: (s) => llamarCifrado({ flow_token, ...s }),
      init: () => llamarCifrado({ flow_token, action: 'INIT' }),
      paso: (screen, data) => llamarCifrado({ flow_token, action: 'data_exchange', screen, data }) };
  };
  /**
   * Envejece el formulario: el envío fue hace `envio` minutos (y con él todo lo
   * que llegó antes, para no fabricar un «texto posterior») y la última
   * actividad de su borrador hace `actividad` minutos.
   */
  const envejecer = async (preguntaId, { envio, actividad = null }) => {
    const i = `${Number(envio)} minutes`;
    await pool.query(`UPDATE agente_preguntas_interactivas SET created_at=created_at-$2::interval WHERE id=$1`, [preguntaId, i]);
    await pool.query(`UPDATE whatsapp_entradas SET recibido_at=recibido_at-$3::interval WHERE negocio_id=$1 AND telefono=$2`, [f.negocioId, f.telefono, i]);
    await pool.query(`UPDATE agente_outbox SET created_at=created_at-$2::interval, entregado_at=entregado_at-$2::interval
      WHERE evento_clave=(SELECT outbox_clave FROM agente_preguntas_interactivas WHERE id=$1)`, [preguntaId, i]);
    if (actividad !== null) await pool.query(`UPDATE agente_flows_borradores SET actualizado_at=now()-$2::interval WHERE pregunta_id=$1`,
      [preguntaId, `${Number(actividad)} minutes`]);
  };
  const actividadDe = async (preguntaId) => (await pool.query(`SELECT EXTRACT(EPOCH FROM now()-actualizado_at)::int s
    FROM agente_flows_borradores WHERE pregunta_id=$1`, [preguntaId])).rows[0]?.s;
  return { ...f, productoId: p.id, leer, texto, recibo, procesar, flow, envejecer, actividadDe, handoffs };
}

/** «ver» + «agregar» unos chilaquiles (Verde, Pollo). Devuelve la respuesta. */
async function agregarChilaquiles(fl, foto) {
  const producto = `p${foto.productos.findIndex((p) => p.nombre === 'Chilaquiles Sencillos')}`;
  const ficha = foto.productos[Number(producto.slice(1))];
  let v = await fl.paso('CATEGORIA', { operacion: 'ver', producto });
  assert.equal(v.status, 200, JSON.stringify(v.respuesta));
  const datos = { operacion: 'agregar', apertura: v.respuesta.data.apertura, producto, cantidad: '1', observaciones: '' };
  for (const [grupo, nombre] of [['Salsa', 'Verde'], ['Proteína', 'Pollo']]) {
    const g = ficha.grupos.findIndex((x) => x.nombre === grupo), o = `o${ficha.grupos[g].opciones.findIndex((x) => x.nombre === nombre)}`;
    const variante = varianteDeGrupo(ficha.grupos[g]);
    datos[`g${g}_${variante}`] = variante === 'm' ? [o] : o;
  }
  v = await fl.paso('PERSONALIZAR', datos);
  assert.equal(v.status, 200, JSON.stringify(v.respuesta));
  assert.equal(v.respuesta.screen, 'CATEGORIA', JSON.stringify(v.respuesta.data?.error));
  return v;
}

try {
  await caso('P1', 'personal con el número 521: «¿Pudo hacer su pedido?» es ayuda y el formulario sigue vivo; «¿para recoger o a domicilio?» toma el chat', async () => {
    const f = await fixture();
    assert.match(f.telefono, /^521\d{10}$/, 'el número es como los de producción');
    const q = await f.procesar(f.texto('Quiero ordenar'));
    assert.equal(q.foto?.version, 'tienda_v1', JSON.stringify(q.texto));
    const fl = f.flow(q);
    assert.equal((await fl.init()).status, 200);
    const transporte = `52${f.telefono.slice(3)}`;
    // Las tres formas en que llega el número: la de la conversación, la de Meta/panel, y con formato.
    for (const telefono of [f.telefono, transporte, `+52 1 ${f.telefono.slice(3, 6)} ${f.telefono.slice(6, 9)} ${f.telefono.slice(9)}`]) {
      const r = await resolverIntervencionHumana({ db: pool, negocioId: f.negocioId, telefono, texto: 'Pudo hacer su pedido? 🍎☺️' });
      assert.deepEqual(r, { ok: true, modo: 'ayuda_formulario' }, telefono);
    }
    assert.deepEqual(await resolverIntervencionHumana({ db: pool, negocioId: f.negocioId, telefono: transporte, texto: 'Buen día pudo hacer su pedido?' }),
      { ok: true, modo: 'ayuda_formulario' });
    assert.equal((await fl.paso('MENU', { operacion: 'ver_carrito' })).status, 200, 'tras la ayuda, el formulario sigue');
    // Tomar el pedido a mano sí toma el chat.
    assert.deepEqual(await resolverIntervencionHumana({ db: pool, negocioId: f.negocioId, telefono: transporte, texto: 'Para recoger o a domicilio?' }),
      { ok: true, modo: 'manual' });
    // La pausa del chat (con el número de la conversación) se respeta: sin bot, no hay ayuda sobre el formulario.
    await pool.query(`INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)
      ON CONFLICT (negocio_id,telefono) DO UPDATE SET bot_pausado=true`, [f.negocioId, f.telefono]);
    assert.deepEqual(await resolverIntervencionHumana({ db: pool, negocioId: f.negocioId, telefono: transporte, texto: 'Pudo hacer su pedido?' }),
      { ok: true, modo: 'manual' });
  });

  await caso('P2', 'y con el número de siempre (52 + 10) sigue igual que antes', async () => {
    const f = await fixture({ conUno: false });
    assert.match(f.telefono, /^52\d{10}$/);
    const q = await f.procesar(f.texto('Quiero ordenar'));
    assert.equal((await f.flow(q).init()).status, 200);
    assert.deepEqual(await resolverIntervencionHumana({ db: pool, negocioId: f.negocioId, telefono: f.telefono, texto: 'Pudo hacer su pedido?' }),
      { ok: true, modo: 'ayuda_formulario' });
  });

  await caso('V1', 'vigencia por actividad en el endpoint: enviado hace 35 min y usado hace 5 sigue; 31 min quieto, no; navegar renueva', async () => {
    const f = await fixture();
    const q = await f.procesar(f.texto('Quiero ordenar'));
    const fl = f.flow(q);
    assert.equal((await fl.init()).status, 200);
    await f.envejecer(q.preguntaId, { envio: 35, actividad: 5 });
    let v = await fl.paso('MENU', { operacion: 'ver_carrito' });
    assert.equal(v.status, 200, 'antes: 427 a los 30 min del envío aunque lo estuviera usando');
    assert(await f.actividadDe(q.preguntaId) <= 5, 'ver el carrito (solo lectura) renueva la actividad');
    await f.envejecer(q.preguntaId, { envio: 0, actividad: 31 });
    v = await fl.paso('MENU', { operacion: 'ver_carrito' });
    assert.equal(v.status, 427);
    assert.match(v.respuesta.error_msg, /ya no está disponible/);
  });

  await caso('V2', 'tope de 2 h desde el envío aunque haya actividad', async () => {
    const f = await fixture();
    const q = await f.procesar(f.texto('Quiero ordenar'));
    const fl = f.flow(q);
    assert.equal((await fl.init()).status, 200);
    await f.envejecer(q.preguntaId, { envio: 119, actividad: 1 });
    assert.equal((await fl.paso('MENU', { operacion: 'ver_carrito' })).status, 200);
    await f.envejecer(q.preguntaId, { envio: 2, actividad: 1 });
    assert.equal((await fl.paso('MENU', { operacion: 'ver_carrito' })).status, 427);
  });

  await caso('F1', 'envío final a los 45 min del envío, con actividad reciente: se aplica (antes «aviso»); quieto 31 min, no', async () => {
    for (const [actividad, aplica] of [[2, true], [31, false]]) {
      const f = await fixture();
      const q = await f.procesar(f.texto('Quiero ordenar'));
      const fl = f.flow(q);
      assert.equal((await fl.init()).status, 200);
      await agregarChilaquiles(fl, q.foto);
      let v = await fl.paso('CATEGORIA', { operacion: 'ver_carrito' });
      v = await fl.paso('CARRITO', { operacion: 'continuar', revision: v.respuesta.data.revision });
      assert.equal(v.respuesta.screen, 'ENTREGA');
      v = await fl.paso('ENTREGA', { operacion: 'revisar', revision: v.respuesta.data.revision, modalidad: 'm0', pago: 'p0', nota: '' });
      assert.equal(v.respuesta.screen, 'SUCCESS');
      await f.envejecer(q.preguntaId, { envio: 45, actividad });
      const fin = await f.procesar(f.recibo(q, { revision: v.respuesta.data.extension_message_response.params.revision }));
      const e = await f.leer();
      assert.equal(e.carrito.items.length, aplica ? 1 : 0, `actividad hace ${actividad} min: ${fin.texto}`);
      if (aplica) assert.equal(e.pendiente?.tipo, 'confirmar_resumen', fin.texto);
    }
  });

  await caso('R1', '«Es que me sale que ya no está disponible» manda un formulario nuevo (no «no te entendí» ni una persona)', async () => {
    const f = await fixture();
    const q = await f.procesar(f.texto('Quiero ordenar'));
    assert.equal(q.foto?.version, 'tienda_v1');
    await f.envejecer(q.preguntaId, { envio: 40, actividad: 35 });
    assert.equal((await f.flow(q).init()).status, 427, 'el viejo venció');
    const r = await f.procesar(f.texto('Es que me sale que ya no está disponible'));
    assert.equal(r.interactivo?.type, 'flow', `debió mandar otro formulario: ${r.texto}`);
    assert.notEqual(r.preguntaId, q.preguntaId);
    assert.equal((await f.flow(r).init()).status, 200, 'el nuevo abre');
    const e = await f.leer();
    assert.notEqual(e.handoff?.motivo, 'RECEPCION_INSISTE');
  });

  await caso('R2', 'el caso de Acuña en modo formulario: vencido, «Me podría mandar de nuevo» y «…ya no está disponible» reciben formulario, no «no te entendí» ni persona', async () => {
    const f = await fixture({ modoFormulario: true });
    const q = await f.procesar(f.texto('Hola buen día para hacer pedido a domicilio'));
    assert.equal(q.foto?.version, 'tienda_v1', `modo formulario: «Haz tu pedido» con la tienda: ${q.texto}`);
    await f.envejecer(q.preguntaId, { envio: 33, actividad: 31 });
    assert.equal((await f.flow(q).init()).status, 427, 'el viejo venció');
    let anterior = q;
    for (const frase of ['Me podría mandar de nuevo', 'Es que me sale que ya no está disponible']) {
      const r = await f.procesar(f.texto(frase));
      assert.equal(r.interactivo?.type, 'flow', `«${frase}» debió recibir otro formulario: ${r.texto}`);
      assert.match(r.texto, /^Aquí tienes el formulario de nuevo/, r.texto);
      assert.notEqual(r.preguntaId, anterior.preguntaId);
      assert.equal((await f.flow(r).init()).status, 200, 'el nuevo abre');
      anterior = r;
    }
    assert.deepEqual(f.handoffs, [], 'nadie pasó a una persona');
  });
} finally {
  servidor.closeAllConnections(); await new Promise((r) => servidor.close(r));
  await pool.end();
}
console.log(`RESULTADO: ${n} pasadas, ${fallidas} fallidas de ${n + fallidas} (formulario no disponible, base local)`);
process.exit(fallidas ? 1 : 0);
