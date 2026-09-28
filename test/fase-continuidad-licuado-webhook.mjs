// Postgres desechable y dos servidores HTTP reales. Meta y Anthropic locales.
import assert from 'node:assert/strict';
import { randomUUID, createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { arrancarServidor } from './lib-servidor.mjs';
import { arrancarAnthropicMock } from './lib-anthropic-mock.mjs';
import { cartaLicuado } from '../scripts/check-continuidad-licuado.mjs';

const url = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1', 'localhost'].includes(url.hostname));
assert.match(url.pathname, /^\/test_licuado_/);
assert.match(process.env.NODE_OPTIONS || '', /red-solo-local/);
const marca = randomUUID(), telefono = `52879${Math.floor(Math.random() * 1e7).toString().padStart(7, '0')}`;
const secreto = 'solo-local-licuado', ids = new Map(), entregadas = [];
let s1, s2, ia, meta, negocioId, secuencia = 0, llamadas = 0;
const esperar = async (fn, etiqueta) => {
  const fin = Date.now() + 40000;
  while (Date.now() < fin) { if (await fn()) return; await new Promise(r => setTimeout(r, 100)); }
  throw Error(`Timeout ${etiqueta}\n${s1?.obtenerSalida().slice(-2000)}\n${s2?.obtenerSalida().slice(-2000)}`);
};
const parar = async s => {
  if (!s || s.proc.exitCode !== null || s.proc.signalCode !== null) return;
  const fin = new Promise(r => s.proc.once('exit', r)); s.detener(); await fin;
};
const leer = async () => (await pool.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2',
  [negocioId, `agente:${telefono}`])).rows[0]?.estado;
const publicar = async (base, mensaje) => {
  const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages',
    value: { metadata: { phone_number_id: marca }, contacts: [{ wa_id: telefono, profile: { name: 'Prueba licuado' } }], messages: [mensaje] },
  }] }] });
  const r = await fetch(`${base}/webhook/whatsapp`, { method: 'POST', body,
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', secreto).update(body).digest('hex')}` } });
  assert.equal(r.status, 200);
};
const herramienta = (name, input) => ({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: `${name}-${++secuencia}`, name, input }] });
async function enviar(texto, pasos = [], duplicado = false) {
  for (const paso of pasos) ia.encolarRespuesta(() => { llamadas++; return paso; });
  const m = { id: `wamid.lic-${marca}-${++secuencia}`, from: telefono, type: 'text', text: { body: texto } };
  const antes = entregadas.length;
  await publicar(s2.base, m);
  if (duplicado) await publicar(s1?.proc.exitCode === null && s1.proc.signalCode === null ? s1.base : s2.base, m);
  await esperar(async () => entregadas.length === antes + 1 && (await pool.query(
    'SELECT estado FROM whatsapp_entradas WHERE negocio_id=$1 AND wamid=$2', [negocioId, m.id])).rows[0]?.estado === 'completado', texto);
  await esperar(async () => (await leer())?.dialogo?.enviado, 'acuse de respuesta');
  assert.equal(ia.pendientes(), 0, 'El guion esperado se consumió completo');
  console.log(`OK webhook licuado: ${texto}`);
  return m;
}
try {
  const { rows: [negocio] } = await pool.query('INSERT INTO negocios(nombre,slug,bot_whatsapp_activo) VALUES($1,$2,true) RETURNING id',
    ['Licuado aislado', `licuado-${marca}`]); negocioId = negocio.id;
  await pool.query("INSERT INTO negocio_modulos(negocio_id,modulo,estado) VALUES($1,'whatsapp','activo')", [negocioId]);
  await pool.query("INSERT INTO metodos_pago(negocio_id,tipo,habilitado,disponible_para_bot,disponible_para_operador,orden) VALUES($1,'efectivo',true,true,true,0)", [negocioId]);
  const { rows: [categoria] } = await pool.query('INSERT INTO menu_categorias(negocio_id,nombre,activa) VALUES($1,$2,true) RETURNING id', [negocioId, 'Pruebas']);
  for (const p of cartaLicuado[0].productos) {
    const { rows: [producto] } = await pool.query('INSERT INTO menu_productos(negocio_id,categoria_id,nombre,precio,disponible) VALUES($1,$2,$3,$4,true) RETURNING id',
      [negocioId, categoria.id, p.nombre, p.precio]); ids.set(p.id, String(producto.id));
    await pool.query('INSERT INTO whatsapp_productos(negocio_id,producto_id,publicado) VALUES($1,$2,true)', [negocioId, producto.id]);
    for (const [orden, g] of (p.modificadores || []).entries()) {
      const { rows: [grupo] } = await pool.query('INSERT INTO menu_modificadores_grupos(negocio_id,producto_id,nombre,requerido,minimo,maximo,orden) VALUES($1,$2,$3,true,1,$4,$5) RETURNING id',
        [negocioId, producto.id, g.nombre, g.maximo, orden]);
      for (const o of g.opciones) await pool.query('INSERT INTO menu_modificadores_opciones(negocio_id,grupo_id,nombre,precio_extra,disponible) VALUES($1,$2,$3,$4,true)',
        [negocioId, grupo.id, o.nombre, o.precio_extra || 0]);
    }
  }
  await pool.query("INSERT INTO integraciones_canal(negocio_id,canal,identificador,activo) VALUES($1,'whatsapp',$2,true)", [negocioId, marca]);
  const reglas = { restaurante: 'Prueba licuado', timezone: 'America/Matamoros',
    horarios: Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo'].map(d => [d, { abierto: true, apertura: '00:00', cierre: '24:00' }])),
    pedidos: { modalidades: ['recoger en tienda'], tiempo_preparacion_minutos: 20, pedido_minimo_entrega: 0, costo_envio: 0, pago_aceptado: ['efectivo'] },
    cierres_especiales: [], promociones: [], politicas: [] };
  await actualizarConfiguracion({ int_wa_phone_id: marca, int_wa_token: 'solo-local', mesero_agente_v1: 'true',
    mesero_agente_telefonos: telefono, reglas_atencion: JSON.stringify(reglas), pedido_requiere_pago: 'true' }, negocioId);
  meta = createServer((req, res) => {
    let cuerpo = ''; req.on('data', b => { cuerpo += b; }); req.on('end', () => {
      const body = JSON.parse(cuerpo || '{}');
      if (req.method !== 'POST' || !req.url.endsWith('/messages')) { res.writeHead(404); res.end('{}'); return; }
      if (body.status === 'read') { res.writeHead(200); res.end('{"success":true}'); return; }
      if (body.to !== telefono) { res.writeHead(400); res.end('{}'); return; }
      const id = `wamid.LIC-SALIDA-${marca}-${entregadas.length}`; entregadas.push({ ...body, id });
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ messages: [{ id }] }));
    });
  });
  await new Promise(r => meta.listen(0, '127.0.0.1', r)); ia = await arrancarAnthropicMock();
  const env = { META_GRAPH_BASE_URL: `http://127.0.0.1:${meta.address().port}`, ANTHROPIC_BASE_URL: ia.baseUrl,
    ANTHROPIC_API_KEY: 'solo-local', META_APP_SECRET: secreto, MESERO_AGENTE_MODE: 'true' };
  s1 = await arrancarServidor({ ...env, PORT: '55982' }); s2 = await arrancarServidor({ ...env, PORT: '55983' });
  await enviar('Quiero unos chilaquiles suizos con pollo', [herramienta('agregar_producto', { producto_id: ids.get(85), cantidad: 1,
    opciones: [{ grupo: 'Salsa', opcion: 'Suiza' }, { grupo: 'Proteína', opcion: 'Pechuga de pollo' }] }), '¿Qué guarniciones prefieres?'], true);
  await enviar('Frijoles naturales y papas con chorizo'); await enviar('Recoger');
  const agregarLicuado = () => [herramienta('buscar_producto', { texto: 'licuado' }),
    herramienta('agregar_producto', { producto_id: ids.get(112), cantidad: 1 }), '¿De qué medida lo quieres: Chico o Grande de 1 litro?'];
  await enviar('Me agregas un licuado por favor', agregarLicuado());
  await enviar('Me agregas un licuado por favor', agregarLicuado(), true);
  const medida = await leer(); assert.equal(medida.pendiente.grupo, 'Medida');
  assert.equal(medida.carrito.items.length, 2);
  await parar(s1); await parar(s2); // Continuar solo con lo persistido, sin memoria de servidores.
  s2 = await arrancarServidor({ ...env, PORT: '55983' });
  await enviar('Grande');
  const antes = JSON.stringify((await leer()).carrito);
  await enviar('Plátano y fresa', [], true);
  assert.equal(JSON.stringify((await leer()).carrito), antes);
  assert.match(entregadas.at(-1).text.body, /Fruta Extra/);
  assert.match(entregadas.at(-1).text.body, /coinciden/);
  await enviar('Plátano'); await enviar('Fresa'); await enviar('Chocolate y vainilla');
  await enviar('Entera y splenda'); await enviar('Efectivo');
  const confirmacion = await enviar('Sí, confirmo', [], true);
  await publicar(s2.base, confirmacion);
  const final = await leer(); assert(final.folio); assert.equal(final.hechos.escalado, false);
  assert.equal(final.carrito.items.length, 2);
  const licuado = final.carrito.items.find(i => String(i.id) === ids.get(112)); assert.equal(licuado.cantidad, 1);
  assert.deepEqual(licuado.modificadores.find(g => g.grupo === 'Sabor').opciones, ['Platáno']);
  assert.deepEqual(licuado.modificadores.find(g => g.grupo === '¿Fruta Extra?').opciones, ['Fresa']);
  const pedidos = (await pool.query('SELECT datos FROM pedidos_activos WHERE negocio_id=$1', [negocioId])).rows;
  assert.equal(pedidos.length, 1); assert.equal(Number(pedidos[0].datos.total), 265);
  const turnos = (await pool.query('SELECT errores_proveedor FROM agente_turnos WHERE negocio_id=$1', [negocioId])).rows;
  assert(turnos.every(t => !t.errores_proveedor?.length));
  assert.equal(llamadas, 8); assert.equal(entregadas.length, 13);
  const salidas = (await pool.query("SELECT evento_clave,estado FROM agente_outbox WHERE negocio_id=$1 AND tipo='respuesta_cliente'", [negocioId])).rows;
  assert.equal(salidas.length, 13); assert(salidas.every(s => s.estado === 'entregado'));
  console.log('OK E2E licuado: 13 respuestas, dos procesos, reinicio, reentregas y un pedido local de $265. Meta/modelo simulados; sin efectos externos.');
} finally {
  await parar(s1); await parar(s2); ia?.detener(); meta?.closeAllConnections(); meta?.close(); await pool.end();
}
