// «Este formulario ya no está disponible», opción A (24-nov-2026): con la
// bandera whatsapp_formulario_sobrevive_chat_v1 y el modo formulario, lo que el
// cliente escribe en el chat (y lo que el bot le contesta) ya no corta la
// tienda que tiene abierta. De punta a punta en una base local test_botones_*,
// con un número como los de producción (521 + 10 dígitos).
//
// Medido del 9 al 24-nov en Obispado y Acuña: en 7 de 30 «no disponible» el
// cliente escribió y volvió segundos después al MISMO formulario; en otros 6
// volvió al viejo después de recibir uno más nuevo.
//
// Lo que sigue cortándolo también se prueba aquí: una persona atendiendo, una
// foto, un pedido registrado, otro carrito, un resumen por confirmar, la
// vigencia y estar fuera del modo formulario. Con la bandera apagada, todo
// como antes (también el envío final y el texto del error).
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
import { varianteDeGrupo } from '../src/mesero-agente/catalogoFlowTienda.js';
import { AVISOS_NO_DISPONIBLE, CLAVE_SOBREVIVE_CHAT, carritoComoEnLaFoto, formularioSobreviveAlChat, sobreviveAlChatActivo }
  from '../src/mesero-agente/formularioSobreviveAlChat.js';
import { barrerasDeBotones } from '../src/mesero-agente/interactivos.js';
import { peticionCifrada } from './lib-flow-cifrado.mjs';

Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });
const sinEfectos = async () => { throw Error('NO_PEDIDOS_PAGOS_TICKETS'); };
const IDS = { categorias: '66666666666', carrito: '77777777777', categoriasDir: '88888888888', carritoDir: '99999999999',
  categoriasNota: '12121212121', carritoNota: '13131313131', tienda: '14141414141' };
const DE_SIEMPRE = /^Este formulario ya no está disponible: se actualizó o venció\./;
let n = 0, fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').filter(Boolean);
async function caso(clave, nombre, fn) {
  if (SOLO.length && !SOLO.includes(clave)) return;
  try { await fn(); console.log(`OK sobrevive-chat-db ${++n} [${clave}]: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 300)} · esperado=${JSON.stringify(e.expected)?.slice(0, 200)}` : '';
    console.log(`FALLA sobrevive-chat-db [${clave}]: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// ── El endpoint HTTP cifrado, como lo llama Meta ──────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
const ENV_HTTP = { WHATSAPP_FLOW_ENDPOINT: 'true', WHATSAPP_FLOW_PRIVATE_KEY: privateKey, META_APP_SECRET: 'secreto-local', NODE_ENV: 'test' };
const app = express();
registrarEndpointFlow(app, { db: pool, env: ENV_HTTP, atender: (db, s) => atenderFlowRepetible(db, s, { vitrina: async () => null, promo: async () => null }) });
const servidor = app.listen(0, '127.0.0.1'); await new Promise((r) => servidor.once('listening', r));
const URL_FLOWS = `http://127.0.0.1:${servidor.address().port}/webhook/flows/pedido`;
async function llamarCifrado(solicitud) {
  const p = peticionCifrada({ version: '3.0', ...solicitud }, publicKey, ENV_HTTP.META_APP_SECRET);
  const r = await fetch(URL_FLOWS, { method: 'POST', body: p.body, headers: p.headers });
  const cuerpo = await r.text();
  return { status: r.status, ...(r.status === 200 || r.status === 427 ? { respuesta: p.descifrar(cuerpo) } : {}) };
}

// ── Mapolato con la tienda, el modo formulario y un cliente 521 ───────────
// Las banderas del modo formulario como en Obispado y Acuña el 24-nov (conversión incluida).
const MODO_FORMULARIO = { whatsapp_ia_modo_v1: 'formulario', whatsapp_ia_modo_alcance: 'todos',
  whatsapp_flow_facturacion_id: '15151515151', whatsapp_flow_evento_id: '16161616161', whatsapp_eventos_formulario_v1: 'true',
  whatsapp_rescate_humano_v1: 'true', whatsapp_flujos_caducan_v1: 'true', whatsapp_formulario_conversion_v1: 'true' };

async function fixture({ sobrevive = true } = {}) {
  const f = await prepararNegocioBotones({ conUno: true });
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
    whatsapp_flow_tienda_v1: 'true', whatsapp_flow_tienda_id: IDS.tienda, ...MODO_FORMULARIO,
    // Apagada = la clave no existe, como hoy en producción.
    ...(sobrevive ? { [CLAVE_SOBREVIVE_CHAT]: 'true' } : {}) }, f.negocioId);
  const handoffs = [];
  const sesion = `agente:${f.telefono}`;
  const leer = () => leerEstadoVersionado(f.negocioId, f.telefono);
  const ident = () => ({ id: 'wamid.sc.' + randomUUID(), from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)) });
  const texto = (body) => ({ ...ident(), type: 'text', text: { body } });
  const foto = () => ({ ...ident(), type: 'image', image: { id: 'img-local', mime_type: 'image/jpeg' } });
  const recibo = (q, campos) => ({ ...ident(), type: 'interactive', context: { id: q.wamid }, interactive: { type: 'nfm_reply', nfm_reply: {
    name: 'flow', body: 'Sent', response_json: JSON.stringify({ flow_token: q.interactivo.action.parameters.flow_token, ...campos }) } } });
  // Lo que llega del cliente y todavía no contesta nadie (el cliente vuelve al formulario en segundos).
  const llega = (m) => pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')
      ON CONFLICT (negocio_id,wamid) DO UPDATE SET estado='completado'`, [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
  const procesar = async (m) => {
    await llega(m);
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
    const { rows: [pregunta] } = await pool.query(`SELECT q.id,q.dialogo_id,b.datos FROM agente_preguntas_interactivas q
      LEFT JOIN agente_botones b ON b.pregunta_id=q.id WHERE q.outbox_clave=$1 LIMIT 1`, [fila.evento_clave]);
    return { ...fila.carga, r, wamid, foto: pregunta?.datos ?? null, preguntaId: pregunta?.id ?? null, dialogoId: pregunta?.dialogo_id ?? null };
  };
  const flow = (q) => {
    const flow_token = q.interactivo.action.parameters.flow_token;
    return { init: () => llamarCifrado({ flow_token, action: 'INIT' }),
      paso: (screen, data) => llamarCifrado({ flow_token, action: 'data_exchange', screen, data }) };
  };
  const mutarEstado = async (fn) => {
    const { rows: [s] } = await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2', [f.negocioId, sesion]);
    fn(s.estado);
    await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2', [f.negocioId, sesion, JSON.stringify(s.estado)]);
  };
  const envejecer = async (preguntaId, { envio, actividad = null }) => {
    const i = `${Number(envio)} minutes`;
    await pool.query(`UPDATE agente_preguntas_interactivas SET created_at=created_at-$2::interval WHERE id=$1`, [preguntaId, i]);
    await pool.query(`UPDATE whatsapp_entradas SET recibido_at=recibido_at-$3::interval WHERE negocio_id=$1 AND telefono=$2`, [f.negocioId, f.telefono, i]);
    await pool.query(`UPDATE agente_outbox SET created_at=created_at-$2::interval, entregado_at=entregado_at-$2::interval
      WHERE evento_clave=(SELECT outbox_clave FROM agente_preguntas_interactivas WHERE id=$1)`, [preguntaId, i]);
    if (actividad !== null) await pool.query(`UPDATE agente_flows_borradores SET actualizado_at=now()-$2::interval WHERE pregunta_id=$1`,
      [preguntaId, `${Number(actividad)} minutes`]);
  };
  return { ...f, sesion, leer, texto, foto, recibo, llega, procesar, flow, mutarEstado, envejecer, handoffs };
}

/** «ver» + «agregar» unos chilaquiles (Verde, Pollo). */
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

/** Del menú al «listo» del formulario. Devuelve la revisión del recibo final. */
async function hastaElFinal(fl, foto) {
  await agregarChilaquiles(fl, foto);
  let v = await fl.paso('CATEGORIA', { operacion: 'ver_carrito' });
  v = await fl.paso('CARRITO', { operacion: 'continuar', revision: v.respuesta.data.revision });
  assert.equal(v.respuesta.screen, 'ENTREGA', JSON.stringify(v.respuesta));
  v = await fl.paso('ENTREGA', { operacion: 'revisar', revision: v.respuesta.data.revision, modalidad: 'm0', pago: 'p0', nota: '' });
  assert.equal(v.respuesta.screen, 'SUCCESS', JSON.stringify(v.respuesta));
  return v.respuesta.data.extension_message_response.params.revision;
}

/** La tienda «Haz tu pedido» del modo formulario, ya abierta una vez. */
async function tiendaAbierta(f) {
  const q = await f.procesar(f.texto('Hola buen día para hacer pedido'));
  assert.equal(q.foto?.version, 'tienda_v1', `modo formulario: «Haz tu pedido» con la tienda: ${q.texto}`);
  const fl = f.flow(q);
  assert.equal((await fl.init()).status, 200, 'recién enviada abre');
  return { q, fl };
}

try {
  await caso('A0', 'bandera apagada: un texto del cliente corta la tienda como hoy, con el texto de siempre', async () => {
    const f = await fixture({ sobrevive: false });
    const { fl } = await tiendaAbierta(f);
    await f.llega(f.texto('Cuentas con envío'));
    const v = await fl.paso('MENU', { operacion: 'ver_carrito' });
    assert.equal(v.status, 427);
    assert.match(v.respuesta.error_msg, DE_SIEMPRE);
  });

  await caso('A1', 'escribe en el chat y vuelve segundos después, antes de que conteste el bot: la tienda sigue', async () => {
    const f = await fixture();
    const { q, fl } = await tiendaAbierta(f);
    await f.llega(f.texto('Sería a domicilio'));
    assert.equal((await fl.paso('MENU', { operacion: 'ver_carrito' })).status, 200, 'antes: 427 por texto_posterior');
    await agregarChilaquiles(fl, q.foto);
  });

  await caso('A2', 'el bot contesta (diálogo nuevo) y la tienda sigue; se termina y el pedido se aplica', async () => {
    const f = await fixture();
    const { q, fl } = await tiendaAbierta(f);
    await f.procesar(f.texto('Cuentas con envío?'));
    const e = await f.leer();
    assert.notEqual(e.pendiente?.dialogo_id ?? null, q.dialogoId, 'la respuesta del bot estrenó diálogo (lo que antes la cortaba)');
    const revision = await hastaElFinal(fl, q.foto);
    const fin = await f.procesar(f.recibo(q, { revision }));
    const despues = await f.leer();
    assert.equal(despues.carrito.items.length, 1, `el pedido del formulario se aplicó: ${fin.texto}`);
    assert.equal(despues.pendiente?.tipo, 'confirmar_resumen', fin.texto);
  });

  await caso('A3', 'un formulario más nuevo no corta al viejo; el primero que se envía gana y el otro ya no sirve', async () => {
    const f = await fixture();
    const { q, fl } = await tiendaAbierta(f);
    const nuevo = await f.procesar(f.texto('Me podría mandar de nuevo'));
    assert.equal(nuevo.foto?.version, 'tienda_v1', `le llegó otra tienda: ${nuevo.texto}`);
    assert.notEqual(nuevo.preguntaId, q.preguntaId);
    assert.equal((await f.flow(nuevo).init()).status, 200, 'el nuevo abre');
    const revision = await hastaElFinal(fl, q.foto);
    const fin = await f.procesar(f.recibo(q, { revision }));
    assert.equal((await f.leer()).carrito.items.length, 1, `el viejo se aplicó: ${fin.texto}`);
    // Ya hay carrito y un resumen por confirmar: el otro formulario no puede ser un segundo pedido.
    const otra = await f.flow(nuevo).paso('MENU', { operacion: 'ver_carrito' });
    assert.equal(otra.status, 427, 'el otro ya no sirve');
  });

  await caso('A4', 'lo que la sigue cortando: una persona atendiendo (pausa, takeover, revisión), con su propio texto', async () => {
    const formas = {
      pausa: (f) => pool.query(`INSERT INTO conversaciones_control(negocio_id,telefono,bot_pausado) VALUES($1,$2,true)
        ON CONFLICT (negocio_id,telefono) DO UPDATE SET bot_pausado=true`, [f.negocioId, f.telefono]),
      takeover: async (f) => {
        await pool.query(`INSERT INTO clientes(telefono,negocio_id,nombre) VALUES($1,$2,'Prueba') ON CONFLICT DO NOTHING`, [f.telefono, f.negocioId]);
        const { rowCount } = await pool.query(`UPDATE clientes SET human_takeover_until=now()+interval '30 minutes'
          WHERE telefono=$1 AND (negocio_id=$2 OR negocio_id IS NULL)`, [f.telefono, f.negocioId]);
        assert(rowCount >= 1, 'takeover marcado');
      },
      revision: (f) => pool.query(`INSERT INTO whatsapp_conversaciones(negocio_id,telefono,requiere_revision) VALUES($1,$2,true)
        ON CONFLICT (negocio_id,telefono) DO UPDATE SET requiere_revision=true`, [f.negocioId, f.telefono]),
    };
    for (const [forma, marcar] of Object.entries(formas)) {
      const f = await fixture();
      const { fl } = await tiendaAbierta(f);
      await f.llega(f.texto('Cuentas con envío'));
      await marcar(f);
      const v = await fl.paso('MENU', { operacion: 'ver_carrito' });
      assert.equal(v.status, 427, forma);
      assert.equal(v.respuesta.error_msg, AVISOS_NO_DISPONIBLE.persona, forma);
    }
  });

  await caso('A5', 'lo que la sigue cortando: foto, pedido registrado, otro carrito, resumen por confirmar, fuera del modo formulario', async () => {
    const formas = {
      foto: (f) => f.llega(f.foto()),
      folio: (f) => f.mutarEstado((e) => { e.folio = 'XAB-9999'; }),
      carrito: (f) => f.mutarEstado((e) => { e.carrito.items = [{ lid: 'l-otro', id: 'otro', nombre: 'Otro', cantidad: 1, precio: 10 }]; }),
      resumen: (f) => f.mutarEstado((e) => { e.pendiente = { ...(e.pendiente || {}), tipo: 'confirmar_resumen', huella: 'h-local' }; }),
      fuera: (f) => actualizarConfiguracion({ whatsapp_ia_modo_alcance: 'prueba', whatsapp_ia_modo_telefonos: '5210000000000' }, f.negocioId),
      bandera: (f) => actualizarConfiguracion({ [CLAVE_SOBREVIVE_CHAT]: 'TRUE' }, f.negocioId),
    };
    for (const [forma, marcar] of Object.entries(formas)) {
      const f = await fixture();
      const { fl } = await tiendaAbierta(f);
      await f.llega(f.texto('Cuentas con envío'));
      await marcar(f);
      const v = await fl.paso('MENU', { operacion: 'ver_carrito' });
      assert.equal(v.status, 427, forma);
      assert.match(v.respuesta.error_msg, DE_SIEMPRE, forma);
    }
  });

  await caso('A6', 'vencida (31 min sin actividad) la corta igual, con su propio texto', async () => {
    const f = await fixture();
    const { q, fl } = await tiendaAbierta(f);
    await f.llega(f.texto('Cuentas con envío'));
    await f.envejecer(q.preguntaId, { envio: 33, actividad: 31 });
    const v = await fl.paso('MENU', { operacion: 'ver_carrito' });
    assert.equal(v.status, 427);
    assert.equal(v.respuesta.error_msg, AVISOS_NO_DISPONIBLE.vencido);
  });

  await caso('F1', 'envío final después de un texto: con la bandera se aplica; apagada, no (como hoy)', async () => {
    for (const sobrevive of [true, false]) {
      const f = await fixture({ sobrevive });
      const { q, fl } = await tiendaAbierta(f);
      const revision = await hastaElFinal(fl, q.foto);
      // Escribe ANTES de tocar «Enviar pedido»; el bot le contesta.
      await f.procesar(f.texto('Cuentas con envío?'));
      const fin = await f.procesar(f.recibo(q, { revision }));
      const e = await f.leer();
      assert.equal(e.carrito.items.length, sobrevive ? 1 : 0, `bandera ${sobrevive ? 'encendida' : 'apagada'}: ${fin.texto}`);
    }
  });

  await caso('U1', 'la regla, condición por condición (la configuración completa del negocio de prueba)', async () => {
    const f = await fixture();
    const { cfg } = await barrerasDeBotones(pool, f.negocioId, f.telefono);
    const telefono = f.telefono;
    assert.equal(sobreviveAlChatActivo(cfg, telefono), true, 'modo formulario completo y bandera');
    const datos = { version: 'tienda_v1', lineas: [], modalidad: '', pago: '' };
    const q = { accion: 'flow_productos', datos, estado: 'disponible', otro_posterior: false, ciclo: 'c1' };
    const estado = { conversacionId: 'c1', carrito: { items: [], datos: {} }, pendiente: { tipo: 'recepcion', menu: 'botones' }, hechos: {} };
    const si = (o = {}) => formularioSobreviveAlChat({ q, estado, cfg, telefono, ...o });
    assert.equal(si(), true);
    assert.equal(si({ estado: { ...estado, pendiente: null } }), true);
    for (const tipo of ['agregar_otro', 'editar_pedido', 'inicio_mapo']) assert.equal(si({ estado: { ...estado, pendiente: { tipo } } }), true, tipo);
    for (const tipo of ['confirmar_resumen', 'elegir_opcion', 'modalidad', 'pago', 'direccion', 'elegir_producto', 'configurar_pedido',
      'fecha_hora', 'formulario_servicio', 'datos_evento']) assert.equal(si({ estado: { ...estado, pendiente: { tipo } } }), false, tipo);
    assert.equal(si({ cfg: { ...cfg, [CLAVE_SOBREVIVE_CHAT]: 'false' } }), false, 'bandera');
    assert.equal(si({ cfg: { ...cfg, whatsapp_ia_modo_v1: 'recepcionista' } }), false, 'modo');
    assert.equal(si({ q: { ...q, otro_posterior: undefined } }), false, 'sin la columna calculada no sobrevive');
    assert.equal(si({ q: { ...q, otro_posterior: true } }), false, 'foto');
    assert.equal(si({ q: { ...q, estado: 'terminada' } }), false, 'terminada');
    assert.equal(si({ q: { ...q, ciclo: 'c0' } }), false, 'otra conversación');
    assert.equal(si({ q: { ...q, datos: { ...datos, version: 'carrito_v1' } } }), false, 'solo la tienda');
    assert.equal(si({ q: { ...q, accion: 'confirmar' } }), false, 'solo formularios');
    for (const k of ['folio', 'evento', 'confirmacionIncierta', 'botonesReserva']) assert.equal(si({ estado: { ...estado, [k]: 'x' } }), false, k);
    assert.equal(si({ estado: { ...estado, hechos: { pedido: true } } }), false, 'hechos');
    assert.equal(carritoComoEnLaFoto(datos, { carrito: { items: [], datos: { modalidad: 'm0' } } }), false, 'otra entrega');
    const conLinea = { ...datos, lineas: [{ linea_id: 'l1', cantidad: 2, ficha: { id: '7' } }] };
    assert.equal(carritoComoEnLaFoto(conLinea, { carrito: { items: [{ lid: 'l1', id: 7, cantidad: 2 }], datos: {} } }), true);
    assert.equal(carritoComoEnLaFoto(conLinea, { carrito: { items: [{ lid: 'l1', id: 7, cantidad: 3 }], datos: {} } }), false, 'cantidad');
    assert.equal(carritoComoEnLaFoto(conLinea, { carrito: { items: [], datos: {} } }), false, 'sin líneas');
  });
} finally {
  servidor.closeAllConnections(); await new Promise((r) => servidor.close(r));
  await pool.end();
}
console.log(`RESULTADO: ${n} pasadas, ${fallidas} fallidas de ${n + fallidas} (formulario sobrevive al chat, base local)`);
process.exit(fallidas ? 1 : 0);
