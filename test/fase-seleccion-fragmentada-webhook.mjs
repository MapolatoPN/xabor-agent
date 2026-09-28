// Servidores REALES y Postgres desechable; proveedor, transporte y periféricos
// aislados. El preload impide cualquier conexión fuera del equipo.
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
import { cartaFragmentada } from '../scripts/check-seleccion-fragmentada.mjs';

const url = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1', 'localhost'].includes(url.hostname));
assert.match(url.pathname, /^\/test_fragmentada_/);
assert.match(process.env.NODE_OPTIONS || '', /red-solo-local/);
const marca = randomUUID(), telefono = `52879${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`, secreto = 'solo-local-fragmentada';
let s1, s2, ia, meta, liberarPrimera;
let retenida = false;
const entregadas = [];
const db = pool;
const { rows: [negocio] } = await db.query('INSERT INTO negocios(nombre,slug,bot_whatsapp_activo) VALUES($1,$2,true) RETURNING id',
  ['Prueba fragmentada aislada', `fragmentada-${marca}`]);
const negocioId = negocio.id;
const esperar = async (fn, etiqueta) => {
  const fin = Date.now() + 35000;
  while (Date.now() < fin) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw Error(`Timeout ${etiqueta}\n${s1?.obtenerSalida().slice(-3500)}\n${s2?.obtenerSalida().slice(-3500)}`);
};
const parar = async s => { if (!s || s.proc.exitCode !== null || s.proc.signalCode !== null) return; const fin = new Promise(r => s.proc.once('exit', r)); s.detener(); await fin; };
const leer = async () => (await db.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',
  [negocioId, `agente:${telefono}`])).rows[0]?.estado;
const publicar = async (base, mensajes, eco = false) => {
  const cuerpo = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{
    field: eco ? 'smb_message_echoes' : 'messages', value: { metadata: { phone_number_id: marca },
      ...(eco ? { message_echoes: mensajes } : { contacts: [{ wa_id: telefono, profile: { name: 'Cliente de prueba' } }], messages: mensajes }) },
  }] }] });
  const r = await fetch(`${base}/webhook/whatsapp`, { method: 'POST', body: cuerpo,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secreto).update(cuerpo).digest('hex')}` } });
  assert.equal(r.status, 200);
};
let secuencia = 0;
const entrada = texto => ({ id: `wamid.frag-${marca}-${++secuencia}`, from: telefono, type: 'text', text: { body: texto } });
async function enviar(texto, { duplicado = false } = {}) {
  const m = entrada(texto), antes = entregadas.length;
  await publicar(s2.base, [m]);
  if (duplicado) await publicar(s1?.proc.exitCode === null && s1?.proc.signalCode === null ? s1.base : s2.base, [m]);
  await esperar(async () => entregadas.length > antes && (await db.query(
    'SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2', [negocioId, m.id])).rows[0]?.estado === 'completado', texto);
  return m;
}
try {
  await db.query("INSERT INTO negocio_modulos(negocio_id,modulo,estado) VALUES($1,'whatsapp','activo')", [negocioId]);
  await db.query("INSERT INTO metodos_pago(negocio_id,tipo,habilitado,disponible_para_bot,disponible_para_operador,orden) VALUES($1,'efectivo',true,true,true,0)", [negocioId]);
  const { rows: [categoria] } = await db.query('INSERT INTO menu_categorias(negocio_id,nombre,activa) VALUES($1,$2,true) RETURNING id', [negocioId, 'Desayunos']);
  for (const p of cartaFragmentada[0].productos) {
    const { rows: [producto] } = await db.query('INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible,orden) VALUES($1,$2,$3,$4,true,$5) RETURNING id',
      [negocioId, categoria.id, p.nombre, p.precio, p.orden || 0]);
    await db.query('INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado) VALUES($1,$2,true)', [negocioId, producto.id]);
    for (const [orden, g] of (p.modificadores || []).entries()) {
      const { rows: [grupo] } = await db.query('INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES($1,$2,$3,true,1,$4,$5) RETURNING id',
        [negocioId, producto.id, g.nombre, g.maximo, orden]);
      for (const o of g.opciones) await db.query('INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible) VALUES($1,$2,$3,0,true)', [negocioId, grupo.id, o.nombre]);
    }
  }
  await db.query("INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,true)", [negocioId, marca]);
  const reglas = { restaurante: 'Prueba aislada', timezone: 'America/Matamoros',
    horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo'].map(d => [d, { abierto: true, apertura: '00:00', cierre: '24:00' }])),
    pedidos: { modalidades: ['recoger en tienda'], tiempo_preparacion_minutos: 20, pedido_minimo_entrega: 0, costo_envio: 0, pago_aceptado: ['efectivo'] },
    cierres_especiales: [], promociones: [], politicas: [] };
  await actualizarConfiguracion({ int_wa_phone_id: marca, int_wa_token: 'token-solo-local', mesero_agente_v1: 'true',
    mesero_agente_telefonos: telefono, reglas_atencion: JSON.stringify(reglas), pedido_requiere_pago: 'true' }, negocioId);
  meta = createServer((req, res) => {
    if (req.method !== 'POST' || !req.url.endsWith('/messages')) { res.writeHead(404); res.end(); return; }
    let cuerpo = ''; req.on('data', b => { cuerpo += b; });
    req.on('end', () => {
      const body = JSON.parse(cuerpo);
      if (body.status === 'read') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"success":true}'); return; }
      if (body.to !== telefono) { res.writeHead(400); res.end('{}'); return; }
      const enviarRespuesta = () => { const id = `wamid.FRAG-SALIDA-${marca}-${entregadas.length}`; entregadas.push({ ...body, id });
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ messages: [{ id }] })); };
      if (!retenida) { retenida = true; liberarPrimera = () => { liberarPrimera = null; enviarRespuesta(); }; } else enviarRespuesta();
    });
  });
  await new Promise(r => meta.listen(0, '127.0.0.1', r)); ia = await arrancarAnthropicMock();
  // Ninguna frase del incidente necesita llamadas al modelo. Si ocurre una,
  // el mock falla cerrado y el estado final/la traza deben detectarlo.
  const env = { META_GRAPH_BASE_URL: `http://127.0.0.1:${meta.address().port}`, ANTHROPIC_BASE_URL: ia.baseUrl,
    ANTHROPIC_API_KEY: 'test-only', META_APP_SECRET: secreto, MESERO_AGENTE_MODE: 'true' };
  s1 = await arrancarServidor({ ...env, PORT: '55986' }); s2 = await arrancarServidor({ ...env, PORT: '55987' });
  const pedido = entrada('Quiero unos chilaquiles');
  await Promise.all([publicar(s1.base, [pedido]), publicar(s2.base, [pedido])]);
  await esperar(() => !!liberarPrimera, 'respuesta retenida por transporte');
  assert.equal((await leer()).pendiente.tipo, 'elegir_producto');
  const verdes = entrada('Serían verdes'), pollo = entrada('Con pollo');
  await publicar(s2.base, [verdes, pollo]);
  await publicar(s1.base, [verdes, pollo]);
  liberarPrimera();
  await esperar(async () => (await leer())?.carrito.items[0]?.modificadores.some(g => g.grupo === 'Proteína'), 'preferencias mientras responde');
  await esperar(() => entregadas.length === 2, 'dos respuestas únicas');
  const primero = await leer(); assert.equal(primero.carrito.items.length, 1); const lid = primero.carrito.items[0].lid;
  console.log('OK webhook fragmentado: dos procesos, reentrega y preferencias recibidas durante la respuesta.');
  await parar(s1);
  await enviar('Frijolitos naturales y papas a la mexicana', { duplicado: true });
  await enviar('Me puedes agregar salsa roja?', { duplicado: true });
  const mixto = await leer(); assert.equal(mixto.carrito.items.length, 1); assert.equal(mixto.carrito.items[0].lid, lid);
  assert.match(mixto.carrito.items[0].nombre, /Mixtos/);
  await enviar('Recoger'); await enviar('Efectivo');
  await esperar(async () => (await leer()).dialogo.enviado === true, 'acuse resumen');
  const confirmacion = await enviar('Sí, confirmo', { duplicado: true });
  await publicar(s2.base, [confirmacion]);
  const final = await leer(); assert(final.folio); assert.equal(final.carrito.items.length, 1);
  const ordenes = (await db.query('SELECT datos FROM pedidos_activos WHERE negocio_id=$1', [negocioId])).rows;
  assert.equal(ordenes.length, 1); assert.equal(Number(ordenes[0].datos.total), 205);
  const ultima = entregadas.at(-1);
  await publicar(s2.base, [{ id: ultima.id, to: telefono, type: 'text', text: ultima.text }], true);
  const mensajes = (await db.query("SELECT * FROM mensajes WHERE negocio_id=$1 AND telefono=$2 AND direccion='saliente'", [negocioId, telefono])).rows;
  assert.equal(mensajes.length, entregadas.length);
  const control = (await db.query('SELECT requiere_revision FROM whatsapp_conversaciones WHERE negocio_id=$1 AND telefono=$2', [negocioId, telefono])).rows[0];
  assert.equal(control.requiere_revision, false);
  const trazas = (await db.query('SELECT errores_proveedor,acciones FROM agente_turnos WHERE negocio_id=$1', [negocioId])).rows;
  assert(trazas.every(t => !t.errores_proveedor?.length && !t.acciones.some(a => a.origen === 'modelo')),
    'el E2E explícito no debe ocultar recuperaciones del proveedor ni depender de propuestas del modelo');
  assert.equal(final.hechos.escalado, false);
  console.log(`OK E2E: ${entregadas.length} salidas únicas, reentregas entrantes, recarga en otro proceso, eco deduplicado, un pedido local de $205; cero efectos externos.`);
} finally {
  liberarPrimera?.();
  await parar(s1); await parar(s2); ia?.detener(); meta?.closeAllConnections(); meta?.close(); await pool.end();
  // Se conserva evidencia en la base DESECHABLE; no se borra ninguna base ajena.
}
