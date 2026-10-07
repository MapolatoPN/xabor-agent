import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, crearUsuarioConPassword, actualizarConfiguracion, obtenerConfiguracion } from '../src/services/database.js';
import { crearTokenSesion } from '../src/services/session.js';
import { prepararNegocioBotones, exigirBaseBotonesLocal } from './lib-botones-local.mjs';
import { arrancarServidor } from './lib-servidor.mjs';

exigirBaseBotonesLocal();
let srv, pasadas = 0;
async function caso(nombre, fn) { await fn(); console.log(`OK Asistente HTTP ${++pasadas}: ${nombre}`); }
try {
  const f = await prepararNegocioBotones();
  const usuario = await crearUsuarioConPassword({ negocioId: f.negocioId, nombre: 'QA Asistente',
    email: `asistente-${randomUUID()}@example.invalid`, password: 'Local-asistente-123!', rol: 'admin' });
  const cookie = `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId: usuario.id, negocioId: f.negocioId, rol: 'admin' }))}`;
  const api = async (ruta, metodo = 'GET', body) => {
    const r = await fetch(srv.base + ruta, { method: metodo, headers: { Cookie: cookie, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, datos: await r.json() };
  };
  const estadoReal = async () => (await pool.query('SELECT bot_whatsapp_activo FROM negocios WHERE id=$1', [f.negocioId])).rows[0].bot_whatsapp_activo;
  const arrancar = async modo => arrancarServidor({ PORT: '55973', MESERO_AGENTE_MODE: modo,
    OPENAI_API_KEY: '', ANTHROPIC_API_KEY: '', META_GRAPH_BASE_URL: 'http://127.0.0.1:1' }, { timeoutMs: 30000 });
  srv = await arrancar('true');
  await caso('pausar siempre funciona y estado identifica agente y piloto', async () => {
    const r = await api('/api/admin/bot-whatsapp', 'PATCH', { activo: false }); assert.equal(r.status, 200);
    assert.equal(await estadoReal(), false);
    const e = await api('/api/admin/bot-whatsapp'); assert.equal(e.datos.motor, 'agente_herramientas');
    assert.equal(e.datos.puedeActivar, true); assert.equal(e.datos.alcance, 'piloto');
    assert(!JSON.stringify(e.datos).includes(f.telefono));
  });
  await caso('sin bandera nueva API rechaza activar y no cambia interruptor', async () => {
    await actualizarConfiguracion({ mesero_agente_v1: 'false' }, f.negocioId);
    const r = await api('/api/admin/bot-whatsapp', 'PATCH', { activo: true });
    assert.equal(r.status, 409); assert.equal(r.datos.codigo, 'ASISTENTE_NO_DISPONIBLE'); assert.equal(await estadoReal(), false);
  });
  await caso('sin alcance API rechaza activar; no habilita legacy ni inventa 100%', async () => {
    await actualizarConfiguracion({ mesero_agente_v1: 'true', mesero_agente_telefonos: '', mesero_agente_porcentaje: '' }, f.negocioId);
    assert.equal((await api('/api/admin/bot-whatsapp', 'PATCH', { activo: true })).status, 409);
    assert.equal(await estadoReal(), false);
  });
  await caso('guardar reglas del agente conserva operación, alcance y estado apagado', async () => {
    const antes = await obtenerConfiguracion(f.negocioId);
    const reglas = JSON.parse(antes.reglas_atencion);
    reglas.bot = { saludo: 'Hola desde QA', tono: 'breve', personalidad: 'amable', informacion_importante: 'Solo pruebas',
      faqs: [], respuestas_prohibidas: ['Promesa sin verificar'], transferir_a_humano: 'Si pide una persona', palabras_criticas: [] };
    assert.equal((await api('/api/config', 'PUT', { reglas_atencion: reglas })).status, 200);
    const despues = await obtenerConfiguracion(f.negocioId);
    assert.equal(JSON.parse(despues.reglas_atencion).bot.saludo, reglas.bot.saludo);
    assert.deepEqual(JSON.parse(despues.reglas_atencion).pedidos, reglas.pedidos);
    assert.equal(despues.mesero_agente_telefonos, antes.mesero_agente_telefonos);
    assert.equal(despues.mesero_agente_porcentaje, antes.mesero_agente_porcentaje);
    assert.equal(await estadoReal(), false);
  });
  await caso('activar agente listo conserva lista; pausa continúa disponible', async () => {
    await actualizarConfiguracion({ mesero_agente_telefonos: f.telefono }, f.negocioId);
    assert.equal((await api('/api/admin/bot-whatsapp', 'PATCH', { activo: true })).status, 200);
    assert.equal(await estadoReal(), true);
    assert.equal((await obtenerConfiguracion(f.negocioId)).mesero_agente_telefonos, f.telefono);
    assert.equal((await api('/api/admin/bot-whatsapp', 'PATCH', { activo: false })).status, 200);
  });
  srv.detener(); await new Promise(resolve => srv.proc.once('exit', resolve)); srv = await arrancar('false');
  await caso('maestro del proceso apagado bloquea activación aunque negocio esté listo', async () => {
    const r = await api('/api/admin/bot-whatsapp', 'PATCH', { activo: true });
    assert.equal(r.status, 409); assert.equal(r.datos.motivo, 'AGENTE_PROCESO_APAGADO'); assert.equal(await estadoReal(), false);
    const estado = await api('/api/admin/bot-whatsapp'); assert.equal(estado.datos.puedeActivar, false);
  });
  console.log(`Asistente HTTP: ${pasadas} grupos pasados en base y servidor locales, sin proveedores.`);
} finally { srv?.detener(); await pool.end(); }
