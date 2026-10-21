// La promoción dentro del formulario «tienda», de punta a punta en una base
// local test_botones_*: el canal manda «Haz tu pedido», el endpoint CIFRADO
// recorre la tienda con dos Chilaquiles Sencillos y el MOTOR REAL
// (previsualizarPedido → calcularPromociones) pone el 2x1 en «Tu pedido», en el
// carrito y en «Entrega y pago»; el recibo deja en el chat el MISMO total que
// el formulario mostró. Red solo local, sin modelo, sin Meta.
//
// Reproduce el incidente del 21-oct-2026 en Mapolato Acuña: «Miércoles de
// Chilaquiles» (2x1, salsa Roja o Verde, proteína sin costo extra) y una
// clienta con dos chilaquiles participantes (Roja y Verde, pollo, frijoles con
// chorizo y prensado de $30) que leyó «Continuar · $450» y escribió «cuando voy
// a pagar no se me aplica la promoción del día». Con este cambio el formulario
// dice «Continuar · $255» (450 − 195), igual que el POS cobró XAB-2096.
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
import { olvidarPromosDelFormulario, promoDelBorrador } from '../src/mesero-agente/promoDelFormulario.js';
import { varianteDeGrupo } from '../src/mesero-agente/catalogoFlowTienda.js';
import { partesEnZona } from '../src/services/tiendaOnline.js';
import { peticionCifrada } from './lib-flow-cifrado.mjs';

Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });
const sinEfectos = async () => { throw Error('NO_PEDIDOS_PAGOS_TICKETS'); };
const IDS = { categorias: '66666666666', carrito: '77777777777', categoriasDir: '88888888888', carritoDir: '99999999999',
  categoriasNota: '12121212121', carritoNota: '13131313131', tienda: '14141414141' };
let n = 0, fallidas = 0;
async function caso(nombre, fn) {
  olvidarPromosDelFormulario();
  try { await fn(); console.log(`OK promo-formulario-db ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 300)} · esperado=${JSON.stringify(e.expected)?.slice(0, 200)}` : '';
    console.log(`FALLA promo-formulario-db: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// ── El endpoint HTTP cifrado, como lo llama Meta ──────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
const ENV_HTTP = { WHATSAPP_FLOW_ENDPOINT: 'true', WHATSAPP_FLOW_PRIVATE_KEY: privateKey, META_APP_SECRET: 'secreto-local', NODE_ENV: 'test' };
// El cálculo de la promoción: el real, salvo que el caso ponga otro.
let promoDePrueba = null;
const app = express();
registrarEndpointFlow(app, { db: pool, env: ENV_HTTP, atender: (db, s) => atenderFlowRepetible(db, s, promoDePrueba ? { promo: promoDePrueba } : {}) });
const servidor = app.listen(0, '127.0.0.1'); await new Promise((r) => servidor.once('listening', r));
const URL_FLOWS = `http://127.0.0.1:${servidor.address().port}/webhook/flows/pedido`;
async function llamarCifrado(solicitud) {
  const p = peticionCifrada({ version: '3.0', ...solicitud }, publicKey, ENV_HTTP.META_APP_SECRET);
  const r = await fetch(URL_FLOWS, { method: 'POST', body: p.body, headers: p.headers });
  const cuerpo = await r.text();
  return { status: r.status, ...(r.status === 200 || r.status === 427 ? { respuesta: p.descifrar(cuerpo) } : {}) };
}

// ── Mapolato con la carta de chilaquiles de Acuña y su promoción ──────────
const SALSAS = ['Roja', 'Suiza', 'Verde', 'Mole', 'Chipotle'];
const PROTEINAS = ['Huevos Estrellados', 'Huevos Revueltos', 'Pechuga de pollo', 'Chicharron Prensado'];
const GUARNICIONES = ['Frijolitos naturales', 'Frijolitos con chorizo', 'Papas a la mexicana', 'Papas con chorizo', 'Prensado'];
const hoy = () => partesEnZona(new Date(), 'America/Matamoros').diaSemana;

async function fixture({ dias = 'hoy', interruptor = null } = {}) {
  const f = await prepararNegocioBotones();
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
  const grupos = {};
  for (const [orden, [nombre, minimo, maximo, opciones, extras]] of [
    ['Salsa', 1, 1, SALSAS, {}], ['Proteína', 1, 1, PROTEINAS, {}], ['Guarniciones', 1, 2, GUARNICIONES, { Prensado: 30 }]].entries()) {
    const { rows: [g] } = await pool.query(`INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden)
      VALUES($1,$2,$3,true,$4,$5,$6) RETURNING id`, [f.negocioId, p.id, nombre, minimo, maximo, orden]);
    grupos[nombre] = { id: g.id, opciones: {} };
    for (const [i, o] of opciones.entries()) {
      const { rows: [op] } = await pool.query(`INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible,orden)
        VALUES($1,$2,$3,$4,true,$5) RETURNING id`, [f.negocioId, g.id, o, extras[o] || 0, i]);
      grupos[nombre].opciones[o] = op.id;
    }
  }
  // Como la de Acuña: 2x1 automático, WhatsApp incluido, solo Chilaquiles
  // Sencillos con salsa Roja o Verde y proteína sin costo extra.
  const diasSemana = dias === 'hoy' ? [hoy()] : [(hoy() + 1) % 7];
  await pool.query(`INSERT INTO tienda_promociones(negocio_id,nombre,tipo,automatica,valor,canales,productos,dias_semana,
      cantidad_requerida,cantidad_beneficiada,condiciones_modificadores,activa)
    VALUES($1,'Miercoles de Chilaquiles','2x1',true,0,'["pos","whatsapp","tienda_online"]'::jsonb,$2::jsonb,$3::jsonb,2,1,$4::jsonb,true)`,
  [f.negocioId, JSON.stringify([p.id]), JSON.stringify(diasSemana), JSON.stringify([
    { producto_id: p.id, grupo_id: grupos.Salsa.id, operador: 'una_de', option_ids: [grupos.Salsa.opciones.Roja, grupos.Salsa.opciones.Verde], min: null, max: null },
    { producto_id: p.id, grupo_id: grupos['Proteína'].id, operador: 'una_de', option_ids: PROTEINAS.map((o) => grupos['Proteína'].opciones[o]), min: null, max: null }])]);
  // El pedido empieza vacío: «Quiero ordenar» manda «Haz tu pedido».
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
    whatsapp_flow_tienda_v1: 'true', whatsapp_flow_tienda_id: IDS.tienda,
    ...(interruptor !== null ? { whatsapp_flow_tienda_promos_v1: interruptor } : {}) }, f.negocioId);

  const leer = () => leerEstadoVersionado(f.negocioId, f.telefono);
  const ident = () => ({ id: 'wamid.promo.' + randomUUID(), from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)) });
  const texto = (body) => ({ ...ident(), type: 'text', text: { body } });
  const recibo = (q, campos) => ({ ...ident(), type: 'interactive', context: { id: q.wamid }, interactive: { type: 'nfm_reply', nfm_reply: {
    name: 'flow', body: 'Sent', response_json: JSON.stringify({ flow_token: q.interactivo.action.parameters.flow_token, ...campos }) } } });
  const procesar = async (m) => {
    await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')
      ON CONFLICT (negocio_id,wamid) DO UPDATE SET estado='completado'`, [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
    const interaccion = m.type === 'interactive' ? { interaccion: { mensajes: [m], mixto: false } } : {};
    const r = await atenderConAgente({ ...f, mensaje: m.text?.body || '', wamids: [m.id], ...interaccion,
      llamarModelo: async () => { throw Error('NO_DEBE_LLAMAR_MODELO'); },
      registrar: sinEfectos, emitir: sinEfectos, guardar: sinEfectos, crearPago: sinEfectos });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.outbox) return { r };
    const { rows: [fila] } = await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1', [r.outbox.clave]);
    const wamid = 'wamid.salida.' + randomUUID();
    if (!r.yaEntregado) assert.equal((await entregarRespuesta({ outboxClave: fila.evento_clave,
      enviar: async () => ({ messages: [{ id: wamid }] }), alHumano: sinEfectos })).estado, 'entregado');
    const { rows: [pregunta] } = await pool.query('SELECT b.datos FROM agente_preguntas_interactivas q LEFT JOIN agente_botones b ON b.pregunta_id=q.id WHERE q.outbox_clave=$1 LIMIT 1', [fila.evento_clave]);
    return { ...fila.carga, r, wamid, foto: pregunta?.datos ?? null };
  };
  const flow = (q) => {
    const flow_token = q.interactivo.action.parameters.flow_token;
    const llamar = async (s) => { const r = await llamarCifrado({ flow_token, ...s }); assert.equal(r.status, 200, JSON.stringify(r.respuesta)); return r.respuesta; };
    return { init: () => llamar({ action: 'INIT' }), paso: (screen, data) => llamar({ action: 'data_exchange', screen, data }) };
  };
  return { ...f, productoId: p.id, leer, texto, recibo, procesar, flow };
}

/** «ver» + «agregar» unos chilaquiles con salsa, proteína y guarniciones por nombre. */
async function agregarChilaquiles(f, fl, foto, { salsa, proteina = 'Pechuga de pollo', guarniciones = ['Frijolitos con chorizo', 'Prensado'] }) {
  const producto = `p${foto.productos.findIndex((p) => p.nombre === 'Chilaquiles Sencillos')}`;
  const ficha = foto.productos[Number(producto.slice(1))];
  let v = await fl.paso('CATEGORIA', { operacion: 'ver', producto });
  assert.equal(v.screen, 'PERSONALIZAR', JSON.stringify(v.data?.error));
  const datos = { operacion: 'agregar', apertura: v.data.apertura, producto, cantidad: '1', observaciones: '' };
  // Cada grupo viaja por la variante que su ficha dibuja (Radio r / Dropdown s / Checkbox m).
  for (const [grupo, nombres] of [['Salsa', [salsa]], ['Proteína', [proteina]], ['Guarniciones', guarniciones]]) {
    const g = ficha.grupos.findIndex((x) => x.nombre === grupo);
    const ids = nombres.map((nm) => `o${ficha.grupos[g].opciones.findIndex((x) => x.nombre === nm)}`);
    const variante = varianteDeGrupo(ficha.grupos[g]);
    datos[`g${g}_${variante}`] = variante === 'm' ? ids : ids[0];
  }
  v = await fl.paso('PERSONALIZAR', datos);
  assert.equal(v.screen, 'CATEGORIA', JSON.stringify(v.data?.error));
  return v;
}

try {
  await caso('el incidente: dos chilaquiles participantes muestran el 2x1 en «Tu pedido», el carrito y «Entrega y pago», y el resumen del chat cobra lo mismo', async () => {
    const f = await fixture();
    const q = await f.procesar(f.texto('Quiero ordenar'));
    assert.equal(q.foto?.version, 'tienda_v1', JSON.stringify(q.texto));
    assert.match(q.texto, /^\*Haz tu pedido\*/);
    const fl = f.flow(q);
    let v = await fl.init();
    assert.equal(v.screen, 'MENU');
    v = await agregarChilaquiles(f, fl, q.foto, { salsa: 'Roja' });
    // Uno solo no hace 2x1: la barra dice el precio completo y nada de promoción.
    assert.equal(v.data.barra[0].end.title, '$225');
    assert.doesNotMatch(v.data.barra[0]['main-content'].metadata, /promoción/);
    v = await agregarChilaquiles(f, fl, q.foto, { salsa: 'Verde' });
    assert.equal(v.data.barra[0].end.title, '$255', 'la barra ya trae el 2x1: 450 − 195');
    assert.match(v.data.barra[0]['main-content'].metadata, /promoción aplicada$/);
    v = await fl.paso('CATEGORIA', { operacion: 'ver_carrito' });
    assert.equal(v.screen, 'CARRITO');
    assert.equal(v.data.boton, 'Continuar · $255');
    assert.equal(v.data.resumen, 'Tu pedido: 2 platillos · $255 con promoción');
    assert.match(v.data.importe, /^Productos: \$450\.00\. Promoción Miercoles de Chilaquiles: -\$195\.00\. Total con promoción: \$255\.00; el envío se suma al revisar\./);
    v = await fl.paso('CARRITO', { operacion: 'continuar', revision: v.data.revision });
    assert.equal(v.screen, 'ENTREGA');
    assert.equal(v.data.resumen, 'Tu pedido: 2 platillos · $255 con promoción. Elige cómo lo recibes y cómo pagas.');
    v = await fl.paso('ENTREGA', { operacion: 'revisar', revision: v.data.revision, modalidad: 'm0', pago: 'p0', nota: '' });
    assert.equal(v.screen, 'SUCCESS');
    // El recibo: el resumen del chat (motor del registro) cobra lo que el formulario mostró.
    const fin = await f.procesar(f.recibo(q, { revision: v.data.extension_message_response.params.revision }));
    assert.match(fin.texto, /Promoción Miercoles de Chilaquiles: -\$195/, fin.texto);
    assert.match(fin.texto, /Total: \$255/, fin.texto);
    const e = await f.leer();
    assert.equal(e.carrito.items.length, 2); assert.equal(e.pendiente?.tipo, 'confirmar_resumen');
  });

  await caso('uno con salsa Suiza: no hay descuento y el carrito dice por qué (salsa Roja o Verde), igual que el diagnóstico del chat', async () => {
    const f = await fixture();
    const q = await f.procesar(f.texto('Quiero ordenar'));
    const fl = f.flow(q);
    await fl.init();
    await agregarChilaquiles(f, fl, q.foto, { salsa: 'Verde' });
    let v = await agregarChilaquiles(f, fl, q.foto, { salsa: 'Suiza' });
    assert.equal(v.data.barra[0].end.title, '$450');
    v = await fl.paso('CATEGORIA', { operacion: 'ver_carrito' });
    assert.equal(v.data.boton, 'Continuar · $450');
    assert.equal(v.data.resumen, 'Tu pedido: 2 platillos · $450');
    assert.match(v.data.importe, /^Para agregar bebidas u otros platillos, toca «Seguir pidiendo»\. Productos: \$450\.00\. La promoción "Miercoles de Chilaquiles" no se aplicó porque elegiste Suiza en salsa\./, v.data.importe);
    assert.match(v.data.importe, /Roja o Verde/);
    assert.match(v.data.importe, /Envío y promociones se calculan al revisar\.$/);
  });

  await caso('promoción de otro día: el formulario es el de siempre (ni descuento ni avisos)', async () => {
    const f = await fixture({ dias: 'manana' });
    const q = await f.procesar(f.texto('Quiero ordenar'));
    const fl = f.flow(q);
    await fl.init();
    await agregarChilaquiles(f, fl, q.foto, { salsa: 'Roja' });
    await agregarChilaquiles(f, fl, q.foto, { salsa: 'Verde' });
    const v = await fl.paso('CATEGORIA', { operacion: 'ver_carrito' });
    assert.equal(v.data.boton, 'Continuar · $450');
    assert.equal(v.data.importe, 'Para agregar bebidas u otros platillos, toca «Seguir pidiendo». Productos: $450.00. Envío y promociones se calculan al revisar.');
  });

  await caso('interruptor whatsapp_flow_tienda_promos_v1=false: el formulario de siempre aunque la promo aplique', async () => {
    const f = await fixture({ interruptor: 'false' });
    const q = await f.procesar(f.texto('Quiero ordenar'));
    const fl = f.flow(q);
    await fl.init();
    await agregarChilaquiles(f, fl, q.foto, { salsa: 'Roja' });
    let v = await agregarChilaquiles(f, fl, q.foto, { salsa: 'Verde' });
    assert.equal(v.data.barra[0].end.title, '$450');
    v = await fl.paso('CATEGORIA', { operacion: 'ver_carrito' });
    assert.equal(v.data.boton, 'Continuar · $450');
    assert.equal(v.data.importe, 'Para agregar bebidas u otros platillos, toca «Seguir pidiendo». Productos: $450.00. Envío y promociones se calculan al revisar.');
  });

  await caso('el cálculo que falla o tarda no tumba el formulario: responde 200 con el subtotal de siempre', async () => {
    const f = await fixture();
    const q = await f.procesar(f.texto('Quiero ordenar'));
    const fl = f.flow(q);
    await fl.init();
    try {
      promoDePrueba = async () => { throw Error('motor caído'); };
      await agregarChilaquiles(f, fl, q.foto, { salsa: 'Roja' });
      let v = await agregarChilaquiles(f, fl, q.foto, { salsa: 'Verde' });
      assert.equal(v.data.barra[0].end.title, '$450');
      // Un motor que nunca contesta: el tope de la promoción suelta la respuesta.
      promoDePrueba = (args) => promoDelBorrador({ ...args, previsualizar: () => new Promise(() => {}), esperaMs: 200 });
      const inicio = Date.now();
      v = await fl.paso('CATEGORIA', { operacion: 'ver_carrito' });
      assert(Date.now() - inicio < 3000, `tardó ${Date.now() - inicio} ms`);
      assert.equal(v.data.boton, 'Continuar · $450');
    } finally { promoDePrueba = null; }
  });
} finally {
  servidor.closeAllConnections(); await new Promise((r) => servidor.close(r));
  await pool.end();
}
console.log(`RESULTADO: ${n} pasadas, ${fallidas} fallidas de ${n + fallidas} (promoción en el formulario, base local)`);
process.exit(fallidas ? 1 : 0);
