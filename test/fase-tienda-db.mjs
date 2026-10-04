// Fase 2B del formulario «tienda» (contrato tienda_v1), de punta a punta en una
// base local test_botones_*: el canal arma el formulario, el transporte lo deja
// salir, el endpoint CIFRADO recorre la tienda (INIT → ver → agregar → MENU →
// carrito B → editar → quitar → continuar → ENTREGA → DIRECCION → FINAL) y el
// recibo opaco {flow_token, revision} deja el MISMO pedido, resumen y huella
// que «Tu carrito» (carrito_v1). También las barreras: formulario viejo al
// activar, revisión obsoleta, apertura repetida, flowId distinto (427) y
// reversa; la telemetría con la migración 114; y la bandera apagada, igual que
// hoy. Red solo local, sin modelo, sin Meta.
import assert from 'node:assert/strict';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import express from 'express';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { atenderConAgente } from '../src/mesero-agente/canalDelAgente.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { atenderFlowRepetible } from '../src/mesero-agente/flowRepetibleSql.js';
import { registrarEndpointFlow } from '../src/mesero-agente/flowEndpoint.js';
import { operarTienda } from '../scripts/activar-flows-tienda.mjs';
import { CLAVE_RESPALDO_TIENDA } from '../src/mesero-agente/activacionTienda.js';
import { esperarPrecalentamiento } from '../src/services/vitrinaTienda.js';
import { miniaturasMenu } from '../src/services/miniaturasMenu.js';
import { peticionCifrada } from './lib-flow-cifrado.mjs';

Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });
const sinEfectos = async () => { throw Error('NO_PEDIDOS_PAGOS_TICKETS'); };
const IDS = { categorias: '66666666666', carrito: '77777777777', categoriasDir: '88888888888', carritoDir: '99999999999',
  categoriasNota: '12121212121', carritoNota: '13131313131', tienda: '14141414141' };
const CFG_NOTA = { whatsapp_flow_nota_v1: 'true', whatsapp_flow_categorias_nota_id: IDS.categoriasNota, whatsapp_flow_carrito_nota_id: IDS.carritoNota };
const SHA = 'a'.repeat(40);
let n = 0, fallidas = 0;
async function caso(nombre, fn) {
  try { await fn(); console.log(`OK tienda-db ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 200)} · esperado=${JSON.stringify(e.expected)?.slice(0, 120)}` : '';
    console.log(`FALLA tienda-db: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// ── El endpoint HTTP cifrado, como lo llama Meta ──────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048,
  privateKeyEncoding: { format: 'pem', type: 'pkcs8' }, publicKeyEncoding: { format: 'pem', type: 'spki' } });
const ENV_HTTP = { WHATSAPP_FLOW_ENDPOINT: 'true', WHATSAPP_FLOW_PRIVATE_KEY: privateKey, META_APP_SECRET: 'secreto-local', NODE_ENV: 'test' };
// La vitrina que el endpoint usa: la real (consulta a la base) salvo que el caso
// ponga otra. `soltada` registra si la transacción ya se había devuelto al pool.
let vitrinaDePrueba = null;
const registro = { llamadas: 0, conTransaccionAbierta: 0, abiertas: 0 };
const dbVigilada = { connect: async () => {
  const tx = await pool.connect(); registro.abiertas++;
  let soltada = false;
  return { query: (...a) => tx.query(...a), release: (...a) => { if (!soltada) { soltada = true; registro.abiertas--; } return tx.release(...a); } };
}, query: (...a) => pool.query(...a) };
const app = express();
registrarEndpointFlow(app, { db: dbVigilada, env: ENV_HTTP, atender: (db, s) => atenderFlowRepetible(db, s, vitrinaDePrueba ? {
  vitrina: async (negocioId) => { registro.llamadas++; if (registro.abiertas) registro.conTransaccionAbierta++; return vitrinaDePrueba(negocioId); } } : {}) });
const servidor = app.listen(0, '127.0.0.1'); await new Promise((r) => servidor.once('listening', r));
const URL_FLOWS = `http://127.0.0.1:${servidor.address().port}/webhook/flows/pedido`;
async function llamarCifrado(solicitud) {
  const p = peticionCifrada({ version: '3.0', ...solicitud }, publicKey, ENV_HTTP.META_APP_SECRET);
  const r = await fetch(URL_FLOWS, { method: 'POST', body: p.body, headers: p.headers });
  const cuerpo = await r.text();
  return { status: r.status, ...(r.status === 200 || r.status === 427 ? { respuesta: p.descifrar(cuerpo) } : {}) };
}

// ── Mapolato con dirección y nota, y una carta con opciones y tacos ──────
async function fixture({ tienda = 'true', telefonosPrueba = null, vacio = false, incompleto = false } = {}) {
  const f = await prepararNegocioBotones();
  const reglas = { restaurante: 'Prueba aislada', timezone: 'America/Matamoros',
    horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
      .map((d) => [d, { abierto: true, apertura: '00:00', cierre: '24:00' }])),
    pedidos: { modalidades: ['recoger en tienda', 'entrega a domicilio'], tiempo_preparacion_minutos: 20,
      pedido_minimo_entrega: 0, costo_envio: 60, pago_aceptado: ['efectivo'], zonas_entrega: [{ nombre: 'UTNC', costo: 150 }, { nombre: 'Cervecera', costo: 150 }] },
    cierres_especiales: [], promociones: [], politicas: [] };
  const { rows: [bebidas] } = await pool.query('SELECT categoria_id FROM menu_productos WHERE id=$1', [f.productoId]);
  await pool.query('UPDATE menu_categorias SET orden=1 WHERE id=$1', [bebidas.categoria_id]);
  const categoria = async (nombre, orden) => (await pool.query('INSERT INTO menu_categorias(negocio_id,nombre,activa,orden) VALUES($1,$2,true,$3) RETURNING id', [f.negocioId, nombre, orden])).rows[0].id;
  const producto = async (cat, nombre, precio, orden, grupos, descripcion = null) => {
    const { rows: [p] } = await pool.query('INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible,orden,descripcion) VALUES($1,$2,$3,$4,true,$5,$6) RETURNING id',
      [f.negocioId, cat, nombre, precio, orden, descripcion]);
    await pool.query('INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado) VALUES($1,$2,true)', [f.negocioId, p.id]);
    for (const [i, [g, opciones, extras = {}]] of grupos.entries()) {
      const { rows: [gr] } = await pool.query('INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES($1,$2,$3,true,1,1,$4) RETURNING id', [f.negocioId, p.id, g, i]);
      for (const [j, o] of opciones.entries()) await pool.query('INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible,orden) VALUES($1,$2,$3,$4,true,$5)', [f.negocioId, gr.id, o, extras[o] || 0, j]);
    }
    return p.id;
  };
  const desayunos = await categoria('Desayunos', 0), tacos = await categoria('Tacos', 2);
  const chilaquilesId = await producto(desayunos, 'Chilaquiles', 145, 0, [['Salsa', ['Roja', 'Verde', 'Chipotle'], { Chipotle: 10 }], ['Proteína', ['Huevo', 'Pollo', 'Bistec'], { Bistec: 30 }]],
    'Totopos bañados en salsa, con crema y queso.');
  await producto(tacos, 'Taco de Barbacoa', 30, 0, [['Tortilla', ['Harina', 'Maíz']]]);
  await producto(tacos, 'Taco de Pastor', 28, 1, [['Tortilla', ['Harina', 'Maíz']]]);
  await actualizarConfiguracion({ nombre: 'Mapolato Obispado', reglas_atencion: JSON.stringify(reglas),
    whatsapp_inicio_mapo_v1: 'true', whatsapp_atencion_general_v1: 'true', bot_whatsapp_solo_prueba: 'false',
    mesero_agente_porcentaje: '100', mesero_agente_telefonos: '', whatsapp_flows_v1: 'true', whatsapp_flows_telefonos: '',
    whatsapp_beta_hibrido_v1: 'true', whatsapp_beta_telefonos: '', whatsapp_carrito_unificado_v1: 'true',
    whatsapp_interactivos_elecciones_v1: 'true', whatsapp_flow_categorias_id: IDS.categorias, whatsapp_flow_carrito_id: IDS.carrito,
    whatsapp_flow_configurar_id: '44444444444', whatsapp_trazabilidad_formularios_v1: 'true',
    whatsapp_flow_categorias_dir_id: IDS.categoriasDir, whatsapp_flow_carrito_dir_id: IDS.carritoDir, ...CFG_NOTA,
    ...(tienda ? { whatsapp_flow_tienda_v1: tienda, whatsapp_flow_tienda_id: IDS.tienda } : {}),
    ...(telefonosPrueba !== null ? { whatsapp_flow_tienda_telefonos: telefonosPrueba === 'este' ? f.telefono : telefonosPrueba } : {}) }, f.negocioId);
  if (vacio || incompleto) {
    // incompleto: unos chilaquiles sin salsa ni proteína (el pedido no se puede resumir todavía).
    f.estado.carrito.items = incompleto ? [{ lid: 'chil-1', id: chilaquilesId, nombre: 'Chilaquiles', cantidad: 1, modificadores: [], notas: '' }] : [];
    await pool.query('UPDATE conversacion_estado SET estado=$3 WHERE negocio_id=$1 AND session_id=$2', [f.negocioId, `agente:${f.telefono}`, JSON.stringify(f.estado)]);
  }
  const leer = () => leerEstadoVersionado(f.negocioId, f.telefono);
  const ident = () => ({ id: 'wamid.tienda.' + randomUUID(), from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)) });
  const texto = (body) => ({ ...ident(), type: 'text', text: { body } });
  const recibo = (q, campos) => ({ ...ident(), type: 'interactive', context: { id: q.wamid }, interactive: { type: 'nfm_reply', nfm_reply: {
    name: 'flow', body: 'Sent', response_json: JSON.stringify({ flow_token: q.interactivo.action.parameters.flow_token, ...campos }) } } });
  const enviados = [];
  const procesar = async (m, { modelo = null } = {}) => {
    await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')
      ON CONFLICT (negocio_id,wamid) DO UPDATE SET estado='completado'`, [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
    const interaccion = m.type === 'interactive' ? { interaccion: { mensajes: [m], mixto: false } } : {};
    const r = await atenderConAgente({ ...f, mensaje: m.text?.body || '', wamids: [m.id], ...interaccion,
      llamarModelo: modelo || (async () => { throw Error('NO_DEBE_LLAMAR_MODELO'); }),
      registrar: sinEfectos, emitir: sinEfectos, guardar: sinEfectos, crearPago: sinEfectos });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.outbox) return { r };
    const { rows: [fila] } = await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1', [r.outbox.clave]);
    const wamid = 'wamid.salida.' + randomUUID();
    if (!r.yaEntregado) assert.equal((await entregarRespuesta({ outboxClave: fila.evento_clave,
      enviar: async (x) => { enviados.push(x); return { messages: [{ id: wamid }] }; }, alHumano: sinEfectos })).estado, 'entregado');
    const { rows: [pregunta] } = await pool.query('SELECT q.huella,b.datos FROM agente_preguntas_interactivas q LEFT JOIN agente_botones b ON b.pregunta_id=q.id WHERE q.outbox_clave=$1 LIMIT 1', [fila.evento_clave]);
    return { ...fila.carga, r, wamid, clave: fila.evento_clave, enviado: enviados.at(-1), huella: pregunta?.huella ?? null, foto: pregunta?.datos ?? null };
  };
  // El endpoint por HTTP cifrado; `paso` falla si la respuesta no es 200.
  const flow = (q) => {
    const flow_token = q.interactivo.action.parameters.flow_token;
    const llamar = async (s) => { const r = await llamarCifrado({ flow_token, ...s }); assert.equal(r.status, 200, JSON.stringify(r.respuesta)); return r.respuesta; };
    return { flow_token, crudo: (s) => llamarCifrado({ flow_token, ...s }), init: () => llamar({ action: 'INIT' }),
      atras: (screen) => llamar({ action: 'BACK', screen }), paso: (screen, data) => llamar({ action: 'data_exchange', screen, data }) };
  };
  return { ...f, leer, texto, recibo, procesar, flow, chilaquilesId };
}
const indice = (foto, nombre) => foto.productos.findIndex((p) => p.nombre === nombre);
const actividad = async (negocioId) => (await pool.query(`SELECT a.tipo,a.paso FROM agente_actividad_formulario a
  JOIN agente_preguntas_interactivas q ON q.id=a.pregunta_id WHERE q.negocio_id=$1 ORDER BY a.observado_at`, [negocioId])).rows;
const sinTelefono = (huella) => { const h = JSON.parse(huella); h.cliente[1] = 'tel'; return JSON.stringify(h); };

try {
  execFileSync(process.execPath, ['scripts/predeploy-110-agente-actividad-formulario.mjs'], { stdio: 'pipe', timeout: 30000 });
  await caso('migración 114: amplía los pasos sin tocar eventos; repetida es idéntica; su reversa vuelve a la regla de la 110', async () => {
    const regla = async () => (await pool.query(`SELECT pg_get_constraintdef(oid) AS r FROM pg_constraint
      WHERE conrelid='agente_actividad_formulario'::regclass AND conname='agente_actividad_formulario_paso_check'`)).rows[0].r;
    const conteo = async () => (await pool.query('SELECT count(*)::int n, count(paso)::int p FROM agente_actividad_formulario')).rows[0];
    const antes = await conteo();
    for (let i = 0; i < 2; i++) execFileSync(process.execPath, ['scripts/predeploy-114-actividad-formulario-tienda.mjs'], { stdio: 'pipe', timeout: 30000 });
    assert.match(await regla(), /'TIENDA'/); assert.match(await regla(), /'DIRECCION'/); assert.match(await regla(), /'MENU'/);
    assert.deepEqual(await conteo(), antes);
    await pool.query(readFileSync(new URL('../migrations/114_actividad_formulario_tienda_down.sql', import.meta.url), 'utf8'));
    assert.doesNotMatch(await regla(), /TIENDA|DIRECCION/);
    execFileSync(process.execPath, ['scripts/predeploy-114-actividad-formulario-tienda.mjs'], { stdio: 'pipe', timeout: 30000 });
    assert.match(await regla(), /'TIENDA'/);
  });

  await caso('migración 114 mientras el binario vivo escribe telemetría: un evento a mitad no la aborta en falso', async () => {
    // El evento entra en una transacción abierta ANTES de la migración y se
    // confirma mientras ella espera su candado. Si contara antes de tomarlo, el
    // «después» vería una fila más y abortaría el despliegue sin haber tocado nada.
    const f = await fixture({ tienda: null });
    const q = await f.procesar(f.texto('seguir pedido'));
    const { rows: [pregunta] } = await pool.query('SELECT id FROM agente_preguntas_interactivas WHERE outbox_clave=$1', [q.clave]);
    const escritor = await pool.connect();
    let hijo;
    try {
      await escritor.query('BEGIN');
      await escritor.query(`INSERT INTO agente_actividad_formulario(pregunta_id,clave,tipo,paso,revision) VALUES($1,$2,'paso','CARRITO',1)`,
        [pregunta.id, randomUUID().replaceAll('-', '').repeat(2)]);
      hijo = new Promise((resolver) => execFile(process.execPath, ['scripts/predeploy-114-actividad-formulario-tienda.mjs'], { timeout: 30000 },
        (error, stdout, stderr) => resolver({ codigo: error ? (error.code ?? 1) : 0, salida: `${stdout}${stderr}` })));
      let terminado = false; hijo.then(() => { terminado = true; });
      // Espera a que la migración esté detenida por el candado de la tabla.
      for (let i = 0; i < 200 && !terminado; i++) {
        const { rows: [w] } = await pool.query(`SELECT count(*)::int n FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND pid<>pg_backend_pid()`);
        if (w.n) break;
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(terminado, false, 'la migración debía esperar a la escritura abierta');
      await escritor.query('COMMIT');
    } finally { escritor.release(); }
    const r = await hijo;
    assert.equal(r.codigo, 0, r.salida.trim());
    assert.equal((await pool.query('SELECT count(*)::int n FROM agente_actividad_formulario WHERE pregunta_id=$1', [pregunta.id])).rows[0].n, 1);
  });

  await caso('bandera apagada (o prueba para otro cliente): el canal manda «Tu carrito» de hoy y el endpoint lo atiende como hoy', async () => {
    for (const [tienda, telefonosPrueba] of [['false', null], ['prueba', '5210000000000'], [null, null]]) {
      const f = await fixture({ tienda, telefonosPrueba });
      const q = await f.procesar(f.texto('seguir pedido'));
      assert.equal(q.interactivo?.action?.parameters?.flow_id, IDS.carritoNota, `${tienda}`);
      assert.equal(q.foto.version, 'carrito_v1'); assert.equal(q.foto.sin_tienda, undefined);
      assert.equal(q.enviado.interactivo?.action?.parameters?.flow_id, IDS.carritoNota);
      const fl = f.flow(q), v = await fl.init();
      assert.equal(v.screen, 'CARRITO'); assert.equal(v.data.hay_items, true);
    }
  });

  await caso('de punta a punta por el endpoint cifrado: INIT (MENU) → carrito → seguir → ver → agregar → CATEGORIA → carrito → editar → quitar → continuar → ENTREGA → DIRECCION → FINAL', async () => {
    const f = await fixture();
    const q = await f.procesar(f.texto('seguir pedido'));
    assert.equal(q.interactivo?.type, 'flow', JSON.stringify(q.texto));
    const p = q.interactivo.action.parameters;
    // «seguir pedido» retoma el pedido: la invitación es «Tu pedido» (abrir=CARRITO), pero
    // la tienda abre en el MENU (el teléfono rechaza abrir en otra pantalla, 4-oct) con «Tu pedido» hasta arriba.
    assert.equal(p.flow_id, IDS.tienda); assert.equal(p.flow_action, 'data_exchange'); assert.equal(p.flow_cta, 'Ver mi pedido');
    assert.match(q.texto, /^\*Tu pedido\*/); assert.equal(q.foto.abrir, 'CARRITO');
    assert.equal(q.enviado.interactivo?.action?.parameters?.flow_id, IDS.tienda, 'el transporte deja salir la tienda');
    assert.equal(q.foto.version, 'tienda_v1'); assert.equal(q.foto.lineas.length, 1);
    assert.equal((await f.leer()).pendiente?.tipo, 'editar_pedido', 'como «Tu carrito»: la pregunta pendiente es editar el pedido');
    const fl = f.flow(q), chilaquiles = `p${indice(q.foto, 'Chilaquiles')}`;
    let v = await fl.init();
    assert.equal(v.screen, 'MENU'); assert.equal(v.data.barra[0]['main-content'].description, '1 platillo');
    v = await fl.paso('MENU', { operacion: 'ver_carrito' });
    assert.equal(v.screen, 'CARRITO'); assert.deepEqual(v.data.filas.map((x) => x.id), ['e0']);
    v = await fl.paso('CARRITO', { operacion: 'seguir' });
    assert.equal(v.screen, 'MENU');
    assert.deepEqual(v.data.categorias.map((c) => c['main-content'].title), ['Desayunos', 'Bebidas', 'Tacos']);
    assert.equal(v.data.barra[0]['main-content'].description, '1 platillo');
    // La vitrina real (dentro del INIT): la descripción del platillo viaja en la categoría.
    const desayunos = v.data.categorias[0]['on-click-action'].payload.platillos;
    assert.equal(desayunos[0]['main-content'].metadata, 'Totopos bañados en salsa, con crema y queso.');
    assert.equal(v.data.categorias[2]['on-click-action'].payload.platillos[0]['main-content'].title, 'Varios tacos a la vez');
    v = await fl.paso('CATEGORIA', { operacion: 'ver', producto: chilaquiles });
    assert.equal(v.screen, 'PERSONALIZAR'); assert.match(v.data.boton, /^Agregar · desde \$145$/);
    const apertura = v.data.apertura;
    v = await fl.paso('PERSONALIZAR', { operacion: 'agregar', apertura, producto: chilaquiles, cantidad: '1', observaciones: '', g0_r: 'o1', g1_r: 'o1' });
    // A la categoría del platillo (la pantalla de antes), con «Tu pedido» al día.
    assert.equal(v.screen, 'CATEGORIA'); assert.equal(v.data.categoria_titulo, 'Desayunos');
    assert.match(v.data.barra[0]['main-content'].metadata, /Agregaste: 1 × Chilaquiles/);
    assert.equal((await f.leer()).carrito.items.length, 1, 'el pedido no cambia hasta el recibo');
    v = await fl.paso('CATEGORIA', { operacion: 'ver_carrito' });
    assert.equal(v.screen, 'CARRITO'); assert.deepEqual(v.data.filas.map((x) => x.id), ['e0', 'n0']);
    assert.match(v.data.boton, /^Continuar · \$\d+/); assert.equal(v.data.puede_deshacer, true);
    v = await fl.paso('CARRITO', { operacion: 'editar', fila: 'e0' });
    assert.equal(v.screen, 'EDITAR');
    v = await fl.paso('EDITAR', { operacion: 'quitar', revision: v.data.revision, fila: 'e0' });
    assert.equal(v.screen, 'CARRITO'); assert.deepEqual(v.data.filas.map((x) => x.id), ['n0']);
    v = await fl.paso('CARRITO', { operacion: 'continuar', revision: v.data.revision });
    assert.equal(v.screen, 'ENTREGA'); assert.match(v.data.resumen, /Tu pedido: 1 platillo/);
    v = await fl.paso('ENTREGA', { operacion: 'revisar', revision: v.data.revision, modalidad: 'm1', pago: 'p0', nota: 'Tocar el timbre' });
    assert.equal(v.screen, 'DIRECCION');
    v = await fl.paso('DIRECCION', { operacion: 'direccion', revision: v.data.revision, zona: 'z0', calle: 'Edificio 3', colonia: '', referencias: 'Caseta norte' });
    assert.equal(v.screen, 'SUCCESS');
    const params = v.data.extension_message_response.params;
    assert.deepEqual(Object.keys(params).sort(), ['flow_token', 'revision'], 'el recibo es opaco');
    const fin = await f.procesar(f.recibo(q, { revision: params.revision }));
    const e = await f.leer();
    assert.deepEqual(e.carrito.items.map((i) => [i.nombre, i.cantidad, i.modificadores.map((m) => m.opciones.join('+')).join('|')]), [['Chilaquiles', 1, 'Verde|Pollo']]);
    assert.equal(e.carrito.datos.cliente.direccion, 'Edificio 3, UTNC'); assert.equal(Number(e.carrito.datos.costo_envio), 150);
    assert.equal(e.carrito.datos.notas, 'Tocar el timbre');
    assert.match(fin.texto, /Revisa tu pedido/); assert.equal(e.folio, null);
    // Telemetría: la tienda registra sus etapas (migración 114).
    const pasos = (await actividad(f.negocioId)).map((a) => a.paso);
    assert(pasos.includes('TIENDA') && pasos.includes('ENTREGA') && pasos.includes('DIRECCION'), pasos.join(','));
    // El mismo pedido por «Tu carrito» (carrito_v1): mismo resumen y misma huella.
    const c = await fixture({ tienda: null });
    const qc = await c.procesar(c.texto('seguir pedido'));
    assert.equal(qc.foto.version, 'carrito_v1');
    const fc = c.flow(qc), pc = indice(qc.foto, 'Chilaquiles');
    let w = await fc.init();
    w = await fc.paso('CARRITO', { revision: w.data.revision, operacion: 'agregar' });
    w = await fc.paso('MENU', { revision: w.data.revision, operacion: 'categoria', categoria: w.data.categorias.find((x) => x.title === 'Desayunos').id });
    w = await fc.paso('PLATILLO', { revision: w.data.revision, operacion: 'agregar', producto0: `p${pc}`, g0_s: `p${pc}g0o1`, g1_s: `p${pc}g1o1`, cantidad: '1', observaciones: '' });
    // «Agregar más» regresa al MENU con el aviso (4-oct: del platillo al carrito el teléfono no deja saltar); «Ver carrito» al carrito.
    assert.deepEqual([w.screen, w.data.error], ['MENU', 'Listo: agregamos 1 × Chilaquiles.']);
    w = await fc.paso('MENU', { revision: w.data.revision, operacion: 'terminar' });
    assert.equal(w.screen, 'CARRITO', JSON.stringify(w.data.error));
    w = await fc.paso('CARRITO', { revision: w.data.revision, operacion: 'guardar', q0: '0' });
    w = await fc.paso('ENTREGA', { revision: w.data.revision, operacion: 'revisar', modalidad: 'm1', pago: 'p0', nota: 'Tocar el timbre' });
    w = await fc.paso('DIRECCION', { revision: w.data.revision, operacion: 'direccion', zona: 'z0', calle: 'Edificio 3', colonia: '', referencias: 'Caseta norte' });
    assert.equal(w.screen, 'SUCCESS');
    const finc = await c.procesar(c.recibo(qc, { revision: w.data.extension_message_response.params.revision }));
    // Dos negocios de prueba: solo cambia el teléfono del cliente.
    const resumen = (texto, tel) => texto.replaceAll(tel, 'TEL');
    assert.equal(resumen(fin.texto, f.telefono), resumen(finc.texto, c.telefono), `el mismo resumen en el chat:\n${fin.texto}\n---\n${finc.texto}`.replaceAll('\n', ' ¶ '));
    assert(fin.huella && finc.huella);
    assert.equal(sinTelefono(fin.huella), sinTelefono(finc.huella), 'la misma huella (salvo el teléfono del cliente)');
  });

  await caso('modo prueba, teléfono de la lista: «Arma tu pedido» es la tienda y su recibo se aplica (la vigencia y el aplicar usan el teléfono)', async () => {
    const f = await fixture({ tienda: 'prueba', telefonosPrueba: 'este', vacio: true });
    const q = await f.procesar(f.texto('Quiero ordenar'));
    assert.equal(q.foto.version, 'tienda_v1'); assert.equal(q.foto.tipo, 'flow_productos');
    assert.equal(q.interactivo.action.parameters.flow_cta, 'Ver menú'); assert.match(q.texto, /^\*Haz tu pedido\*/);
    const fl = f.flow(q), cafe = `p${indice(q.foto, 'Café americano')}`;
    let v = await fl.init(); assert.equal(v.screen, 'MENU'); assert.equal(v.data.barra[0]['main-content'].description, 'Vacío');
    v = await fl.paso('CATEGORIA', { operacion: 'ver', producto: cafe });
    v = await fl.paso('PERSONALIZAR', { operacion: 'agregar', apertura: v.data.apertura, producto: cafe, cantidad: '2', observaciones: 'Sin azúcar' });
    v = await fl.paso('MENU', { operacion: 'ver_carrito' });
    v = await fl.paso('CARRITO', { operacion: 'continuar', revision: v.data.revision });
    v = await fl.paso('ENTREGA', { operacion: 'revisar', revision: v.data.revision, modalidad: 'm0', pago: 'p0', nota: '' });
    assert.equal(v.screen, 'SUCCESS');
    const fin = await f.procesar(f.recibo(q, { revision: v.data.extension_message_response.params.revision }));
    assert.match(fin.texto, /Revisa tu pedido/); assert.doesNotMatch(fin.texto, /No apliqué/);
    const e = await f.leer();
    assert.deepEqual(e.carrito.items.map((i) => [i.nombre, i.cantidad, i.notas]), [['Café americano', 2, 'Sin azúcar']]);
    assert.equal(e.carrito.datos.modalidad, 'recoger en tienda'); assert.equal(e.pendiente?.tipo, 'confirmar_resumen');
  });

  await caso('una pregunta a mitad de la tienda devuelve al cliente a lo que ya eligió («Continuar pedido» con su borrador)', async () => {
    const f = await fixture({ vacio: true });
    const q = await f.procesar(f.texto('quiero ordenar'));
    assert.equal(q.foto.version, 'tienda_v1');
    const fl = f.flow(q), cafe = `p${indice(q.foto, 'Café americano')}`;
    let v = await fl.init();
    v = await fl.paso('CATEGORIA', { operacion: 'ver', producto: cafe });
    v = await fl.paso('PERSONALIZAR', { operacion: 'agregar', apertura: v.data.apertura, producto: cafe, cantidad: '2', observaciones: '' });
    assert.equal(v.data.barra[0]['main-content'].description, '2 platillos');
    const respuesta = 'El enlace de pago es un link seguro para pagar con tarjeta desde tu celular.';
    const c = await f.procesar(f.texto('Qué es enlace de pago ?'), { modelo: async () => ({ content: [{ type: 'text', text: respuesta }], stop_reason: 'end_turn' }) });
    assert(c.texto.includes(respuesta), c.texto);
    assert.equal(c.interactivo?.action.parameters.flow_cta, 'Continuar pedido');
    assert.equal(c.foto.version, 'tienda_v1');
    const retomada = await f.flow(c).init();
    assert.equal(retomada.data.barra[0]['main-content'].description, '2 platillos', 'retoma lo que ya eligió');
    assert.equal((await fl.crudo({ action: 'INIT' })).status, 427);
    assert.equal((await f.leer()).carrito.items.length, 0, 'retomar no agrega nada al carrito');
  });

  await caso('tienda encendida y la carta se agota a mitad: la pregunta se contesta sin formulario (no hay qué retomar) y el turno no falla', async () => {
    // construirFormulario devuelve null (toda la carta agotada): el bloque que
    // retoma el borrador no debe leer `tentativo.botones` de un null.
    const f = await fixture({ vacio: true });
    const q = await f.procesar(f.texto('quiero ordenar'));
    assert.equal(q.foto.version, 'tienda_v1');
    const fl = f.flow(q), cafe = `p${indice(q.foto, 'Café americano')}`;
    await fl.init();
    let v = await fl.paso('CATEGORIA', { operacion: 'ver', producto: cafe });
    v = await fl.paso('PERSONALIZAR', { operacion: 'agregar', apertura: v.data.apertura, producto: cafe, cantidad: '1', observaciones: '' });
    assert.equal(v.data.barra[0]['main-content'].description, '1 platillo');
    await pool.query('UPDATE menu_productos SET disponible=false WHERE negocio_id=$1', [f.negocioId]);
    const respuesta = 'El enlace de pago es un link seguro para pagar con tarjeta desde tu celular.';
    const c = await f.procesar(f.texto('Qué es enlace de pago ?'), { modelo: async () => ({ content: [{ type: 'text', text: respuesta }], stop_reason: 'end_turn' }) });
    assert(c.texto?.includes(respuesta), c.texto);
    assert.notEqual(c.interactivo?.type, 'flow', 'sin carta no hay tienda que mandar');
    assert.equal((await f.leer()).carrito.items.length, 0);
  });

  await caso('la tienda reenviada tras un texto que no cambia el pedido conserva lo elegido en la anterior (como «Tu carrito»)', async () => {
    // 2-oct, Obispado: el cliente escribía con «Tu carrito» abierto y el nuevo llegaba sin sus cambios.
    const f = await fixture({ incompleto: true });
    const q = await f.procesar(f.texto('seguir pedido'));
    assert.equal(q.foto.version, 'tienda_v1'); assert.equal(q.foto.tipo, 'flow_configurar');
    const fl = f.flow(q), cafe = `p${indice(q.foto, 'Café americano')}`;
    await fl.init();
    let v = await fl.paso('CATEGORIA', { operacion: 'ver', producto: cafe });
    v = await fl.paso('PERSONALIZAR', { operacion: 'agregar', apertura: v.data.apertura, producto: cafe, cantidad: '2', observaciones: '' });
    assert.equal(v.data.barra[0]['main-content'].description, '3 platillos');
    const antes = structuredClone((await f.leer()).carrito);
    const r = await f.procesar(f.texto('Ok'), { modelo: async () => ({ content: [{ type: 'text', text: '¡Perfecto!' }], stop_reason: 'end_turn' }) });
    assert.equal(r.foto?.version, 'tienda_v1', JSON.stringify(r.texto));
    assert.deepEqual((await f.leer()).carrito, antes, 'el texto no cambió el pedido');
    assert.equal((await fl.crudo({ action: 'INIT' })).status, 427, 'la anterior manda a la más reciente');
    const nueva = f.flow(r), retomada = await nueva.init();
    assert.equal(retomada.screen, 'MENU'); assert.equal(retomada.data.barra[0]['main-content'].description, '3 platillos');
    const carrito = await nueva.paso('MENU', { operacion: 'ver_carrito' });
    assert.deepEqual(carrito.data.filas.map((x) => x.id), ['e0', 'n0'], 'trae el café que agregó en la anterior');
  });

  await caso('al mandar una tienda se preparan las miniaturas de su foto (sin esperar); con la bandera apagada, no', async () => {
    for (const tienda of ['true', 'false']) {
      const f = await fixture({ tienda, vacio: true });
      await pool.query(`UPDATE menu_productos SET opciones=jsonb_build_object('imagen',jsonb_build_object('storage_key',$2::text)) WHERE id=$1`,
        [f.chilaquilesId, `development/negocios/${f.negocioId}/productos/no-existe-${randomUUID()}.jpg`]);
      await esperarPrecalentamiento();
      const antes = miniaturasMenu.estado().lecturas;
      const q = await f.procesar(f.texto('Quiero ordenar'));
      assert.equal(q.foto.version, tienda === 'true' ? 'tienda_v1' : 'repetible_v1');
      await esperarPrecalentamiento();
      // La foto no existe en el disco: la lectura falla y queda como fallida, pero se intentó.
      assert.equal(miniaturasMenu.estado().lecturas - antes, tienda === 'true' ? 1 : 0, tienda);
    }
  });

  await caso('la tienda se dibuja con la transacción ya devuelta: la vitrina (con sus miniaturas) llega después del COMMIT', async () => {
    const f = await fixture({ vacio: true });
    const q = await f.procesar(f.texto('Quiero ordenar'));
    assert.equal(q.foto.version, 'tienda_v1'); assert.equal(q.interactivo.action.parameters.flow_id, IDS.tienda);
    await esperarPrecalentamiento();
    const llave = (id) => `development/negocios/n/productos/${id}.jpg`;
    vitrinaDePrueba = async () => ({ categorias: [], error: null,
      productos: Object.fromEntries(q.foto.productos.map((p) => [p.id, { id: p.id, descripcion: `Desc ${p.nombre}`, storageKey: llave(p.id) }])),
      miniatura: () => '/9j/4AAQSkZJRgABAQAAAQABAAD' });
    try {
      const fl = f.flow(q), antes = { ...registro };
      const v = await fl.init();
      assert.equal(v.screen, 'MENU');
      assert(v.data.categorias.every((c) => c.start?.image), 'portadas desde la vitrina');
      assert.equal(registro.llamadas, antes.llamadas + 1); assert.equal(registro.conTransaccionAbierta, 0, 'nunca con la transacción abierta');
      const r = await fl.paso('CATEGORIA', { operacion: 'ver', producto: 'p0' });
      assert.equal(r.screen, 'PERSONALIZAR'); assert.equal(r.data.con_foto, true);
    } finally { vitrinaDePrueba = null; }
  });

  await caso('barreras de la tienda: revisión obsoleta y apertura repetida no escriben; doble toque concurrente agrega una vez', async () => {
    const f = await fixture();
    const q = await f.procesar(f.texto('seguir pedido'));
    const fl = f.flow(q), cafe = `p${indice(q.foto, 'Café americano')}`;
    let v = await fl.init();
    v = await fl.paso('CATEGORIA', { operacion: 'ver', producto: cafe });
    const agregar = { operacion: 'agregar', apertura: v.data.apertura, producto: cafe, cantidad: '2', observaciones: '' };
    const [a, b] = await Promise.all([fl.paso('PERSONALIZAR', agregar), fl.paso('PERSONALIZAR', agregar)]);
    assert.deepEqual(a, b, 'el mismo toque dos veces da la misma respuesta');
    const filas = async () => (await pool.query(`SELECT d.contenido FROM agente_flows_borradores d JOIN agente_preguntas_interactivas q ON q.id=d.pregunta_id
      WHERE q.outbox_clave=$1`, [q.clave])).rows[0].contenido;
    assert.equal((await filas()).filas.length, 2);
    // La misma ficha otra vez (Atrás hasta ella), con otra cantidad: no duplica.
    v = await fl.paso('PERSONALIZAR', { ...agregar, cantidad: '3' });
    assert.equal(v.screen, 'CATEGORIA'); assert.match(v.data.categoria_aviso, /Ya está en tu pedido/);
    assert.equal((await filas()).filas.length, 2);
    // Una revisión vieja: quitar no escribe.
    v = await fl.paso('CATEGORIA', { operacion: 'ver_carrito' });
    const vieja = String(Number(v.data.revision) - 1), revision = (await filas()).revision;
    v = await fl.paso('CARRITO', { operacion: 'continuar', revision: vieja });
    assert.equal(v.screen, 'CARRITO'); assert.equal(v.data.error_visible, true); assert.match(v.data.error, /La ventana cambió/);
    const despues = await filas();
    assert.equal(despues.revision, revision); assert.equal(despues.etapa, 'TIENDA');
  });

  await caso('flowId distinto, reversa y teléfono fuera de la prueba: la tienda abierta responde 427 sin tocar el pedido', async () => {
    for (const cambio of ['flowId', 'reversa', 'fuera de la prueba', 'sin nota']) {
      const f = await fixture(cambio === 'fuera de la prueba' ? { tienda: 'prueba', telefonosPrueba: 'este' } : {});
      const q = await f.procesar(f.texto('seguir pedido'));
      assert.equal(q.foto.version, 'tienda_v1', cambio);
      const fl = f.flow(q), antes = (await f.leer()).carrito;
      assert.equal((await fl.init()).screen, 'MENU');
      if (cambio === 'flowId') await actualizarConfiguracion({ whatsapp_flow_tienda_id: '15151515151' }, f.negocioId);
      if (cambio === 'reversa') await pool.query("DELETE FROM configuracion WHERE negocio_id=$1 AND clave IN ('whatsapp_flow_tienda_v1','whatsapp_flow_tienda_id')", [f.negocioId]);
      if (cambio === 'fuera de la prueba') await actualizarConfiguracion({ whatsapp_flow_tienda_telefonos: '5210000000000' }, f.negocioId);
      if (cambio === 'sin nota') await actualizarConfiguracion({ whatsapp_flow_nota_v1: 'false' }, f.negocioId);
      const r = await fl.crudo({ action: 'INIT' });
      assert.equal(r.status, 427, cambio); assert.match(r.respuesta.error_msg, /no está disponible/);
      assert.deepEqual((await f.leer()).carrito, antes, cambio);
    }
  });

  await caso('activar: se niega con un formulario abierto; forzado, corta el «Tu carrito» viejo en el endpoint (427); revertir vuelve a «Tu carrito»', async () => {
    const f = await fixture({ tienda: null });
    const q = await f.procesar(f.texto('seguir pedido'));
    assert.equal(q.foto.version, 'carrito_v1');
    let revisadas = 0;
    const revisarMeta = async (negocioId, flows) => { revisadas++; assert.deepEqual(flows, [[IDS.tienda, 'tienda']]); };
    const op = (extra) => operarTienda({ db: pool, negocioId: f.negocioId, sha: SHA, revisarMeta, ...extra });
    await assert.rejects(op({ modo: 'activar', flowId: IDS.tienda, alcance: { modo: 'prueba', telefonos: f.telefono } }), /formulario\(s\) abierto/);
    assert.equal((await pool.query("SELECT count(*)::int n FROM configuracion WHERE negocio_id=$1 AND clave LIKE 'whatsapp_flow%tienda%'", [f.negocioId])).rows[0].n, 0, 'nada escrito');
    const r = await op({ modo: 'activar', flowId: IDS.tienda, alcance: { modo: 'prueba', telefonos: f.telefono }, forzar: true });
    assert.equal(r.formulariosAbiertos, 1); assert.equal(revisadas, 2);
    const antes = (await f.leer()).carrito;
    const viejo = await f.flow(q).crudo({ action: 'INIT' });
    assert.equal(viejo.status, 427, 'el «Tu carrito» abierto antes de encender la tienda se corta al abrirlo');
    assert.deepEqual((await f.leer()).carrito, antes);
    const t = await f.procesar(f.texto('seguir pedido'));
    assert.equal(t.foto.version, 'tienda_v1');
    // Pasar a todos conserva el respaldo; revertir deja la configuración de antes.
    await pool.query("UPDATE agente_preguntas_interactivas SET created_at=now()-interval '31 minutes' WHERE negocio_id=$1", [f.negocioId]);
    await op({ modo: 'activar', flowId: IDS.tienda, alcance: { modo: 'true' } });
    const cfg = Object.fromEntries((await pool.query('SELECT clave,valor FROM configuracion WHERE negocio_id=$1', [f.negocioId])).rows.map((x) => [x.clave, x.valor]));
    assert.equal(cfg.whatsapp_flow_tienda_v1, 'true'); assert.equal(cfg.whatsapp_flow_tienda_telefonos, undefined);
    assert.deepEqual(JSON.parse(cfg[CLAVE_RESPALDO_TIENDA]).antes, { whatsapp_flow_tienda_id: null, whatsapp_flow_tienda_v1: null, whatsapp_flow_tienda_telefonos: null });
    const t2 = await f.procesar(f.texto('seguir pedido'));
    assert.equal(t2.foto.version, 'tienda_v1');
    assert.equal((await f.flow(t2).crudo({ action: 'INIT' })).status, 200);
    await op({ modo: 'revertir' });
    assert.equal((await pool.query("SELECT count(*)::int n FROM configuracion WHERE negocio_id=$1 AND clave LIKE 'whatsapp_flow%tienda%'", [f.negocioId])).rows[0].n, 0);
    assert.equal((await f.flow(t2).crudo({ action: 'INIT' })).status, 427, 'la tienda abierta se corta');
    assert.equal((await f.procesar(f.texto('seguir pedido'))).foto.version, 'carrito_v1');
  });
  await caso('activar en prueba cuenta solo lo que la tienda cortaría: el «Tu carrito» de un cliente fuera de la lista no la detiene ni se corta', async () => {
    const f = await fixture({ tienda: null });
    const q = await f.procesar(f.texto('seguir pedido'));
    assert.equal(q.foto.version, 'carrito_v1');
    const op = (extra) => operarTienda({ db: pool, negocioId: f.negocioId, sha: SHA, revisarMeta: async () => {}, ...extra });
    const r = await op({ modo: 'activar', flowId: IDS.tienda, alcance: { modo: 'prueba', telefonos: '5210000000000' } });
    assert.equal(r.formulariosAbiertos, 0, 'el formulario abierto es de otro cliente');
    assert.equal((await f.flow(q).crudo({ action: 'INIT' })).status, 200, 'y sigue abriendo');
    // Pasar a todos sí lo cortaría: sin forzar, se niega y no escribe.
    await assert.rejects(op({ modo: 'activar', flowId: IDS.tienda, alcance: { modo: 'true' } }), /Hay 1 formulario\(s\) abierto\(s\).*cortaría/);
    const bandera = (await pool.query("SELECT valor FROM configuracion WHERE negocio_id=$1 AND clave='whatsapp_flow_tienda_v1'", [f.negocioId])).rows[0]?.valor;
    assert.equal(bandera, 'prueba');
  });
  console.log(`tienda-db: ${n}/${n + fallidas}. Red solo local, sin pedidos, pagos, tickets ni Meta.`);
} finally {
  servidor.closeAllConnections(); await new Promise((r) => servidor.close(r));
  await pool.end();
}
process.exit(fallidas ? 1 : 0);
