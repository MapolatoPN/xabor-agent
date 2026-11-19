// La colonia del formulario de WhatsApp llega al pedido (y al reporte).
//
// Origen (19-nov-2026): Reportes → Colonias dejaba en «Sin colonia
// identificada» casi todos los envíos de WhatsApp. El formulario de dirección
// (contrato direccion_v1) SÍ separa calle, colonia y zona
// (`cliente.direccion_partes` del carrito), pero `ordenDesdeElCarrito` solo
// copiaba el texto compuesto (`cliente.direccion`) al pedido.
//
// Lo que se garantiza:
//   · la orden lleva `cliente.direccion_partes` = {calle, colonia, zona},
//     solo esas tres claves, solo texto y solo si siguen componiendo
//     EXACTAMENTE la dirección del pedido (si la cambió por chat, no viaja);
//   · NO se escribe `cliente.colonia`: el panel, la comanda y el aviso al
//     repartidor juntan `direccion` + `colonia`, y la colonia ya va dentro de
//     `direccion` («Hidalgo 405, Centro, Centro»). Lo que se ve no cambia;
//   · sin partes, la orden es exactamente la de antes;
//   · el reporte la lee como campo (no «leída de la dirección»), el campo
//     `colonia` del POS/tienda sigue ganando y una colonia vacía no se inventa
//     de la zona.
//
// Direcciones e importes inventados: el repo es público.
// Base local test_botones_*, red solo local, sin modelo, sin Meta:
//   NODE_OPTIONS=--import=./test/red-solo-local.mjs node test/fase-colonia-pedido-whatsapp.mjs
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, actualizarConfiguracion } from '../src/services/database.js';
import { prepararNegocioBotones } from './lib-botones-local.mjs';
import { atenderConAgente, ordenDesdeElCarrito } from '../src/mesero-agente/canalDelAgente.js';
import { partesVigentes } from '../src/mesero-agente/direccionFormulario.js';
import { leerEstadoVersionado } from '../src/mesero-agente/persistenciaDelTurno.js';
import { entregarRespuesta } from '../src/mesero-agente/entregaDeRespuestas.js';
import { atenderFlowRepetible } from '../src/mesero-agente/flowRepetibleSql.js';
import { registrarPedido } from '../src/orders/orderManager.js';
import { construirReporteVentas, obtenerReporteVentas } from '../src/services/reporteVentas.js';
Object.assign(process.env, { MESERO_AGENTE_MODE: 'true', WHATSAPP_INTERACTIVOS: 'true', WHATSAPP_FLOW_ENDPOINT: 'true',
  WHATSAPP_FLOW_PRIVATE_KEY: 'solo-local', META_APP_SECRET: 'solo-local' });

let pasadas = 0, fallidas = 0;
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 240)} · esperado=${JSON.stringify(e.expected)?.slice(0, 160)}` : '';
    console.log(`FALLO [${cat}] ${nombre}: ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}

// ─── A. La orden, sin base ──────────────────────────────────────────────────
const DOM = 'entrega a domicilio';
const carrito = (cliente) => ({
  items: [{ nombre: 'Café americano', cantidad: 1, modificadores: [] }],
  datos: { modalidad: DOM, forma_pago: 'efectivo', costo_envio: 60,
    cliente: { nombre: 'Ana', telefono: '528780000001', ...cliente } },
});
const orden = (cliente) => ordenDesdeElCarrito({ negocioId: 'n-1', carrito: carrito(cliente), telefono: '528780000001', nombre: 'Ana' });
const CENTRO = { calle: 'Hidalgo 405', colonia: 'Centro', zona: '' };

await t('ORDEN', '1. con las partes del formulario: van en direccion_partes y NO como colonia; la dirección no cambia', async () => {
  const o = orden({ direccion: 'Hidalgo 405, Centro', referencias: 'Portón negro', direccion_partes: CENTRO });
  assert.deepEqual(o.cliente, { nombre: 'Ana', telefono: '528780000001', direccion: 'Hidalgo 405, Centro',
    referencias: 'Portón negro', direccion_partes: { calle: 'Hidalgo 405', colonia: 'Centro', zona: '' } });
  assert.equal('colonia' in o.cliente, false, 'cliente.colonia duplicaría la colonia en panel, comanda y repartidor');
  assert.equal('calle' in o.cliente, false);
  // Con zona elegida de la lista y sin colonia: también viaja (colonia vacía).
  const z = orden({ direccion: 'Edificio 3, UTNC', direccion_partes: { calle: 'Edificio 3', colonia: '', zona: 'UTNC' } });
  assert.deepEqual(z.cliente.direccion_partes, { calle: 'Edificio 3', colonia: '', zona: 'UTNC' });
});

await t('ORDEN', '2. la dirección cambió por chat después del formulario: las partes viejas NO viajan', async () => {
  const o = orden({ direccion: 'Morelos 12, Roma', direccion_partes: CENTRO });
  assert.equal(o.cliente.direccion, 'Morelos 12, Roma');
  assert.equal('direccion_partes' in o.cliente, false, 'la colonia guardada ya no es la del pedido');
});

await t('ORDEN', '3. sin partes (chat, negocio sin el formulario de dirección, recoger): la orden es la de antes', async () => {
  assert.deepEqual(orden({ direccion: 'Hidalgo 405, Centro', referencias: 'Portón negro' }).cliente,
    { nombre: 'Ana', telefono: '528780000001', direccion: 'Hidalgo 405, Centro', referencias: 'Portón negro' });
  assert.deepEqual(orden({}).cliente, { nombre: 'Ana', telefono: '528780000001' });
  // Recoger con partes pero sin dirección (se quitó): nada.
  assert.equal('direccion_partes' in orden({ direccion_partes: CENTRO }).cliente, false);
});

await t('ORDEN', '4. solo calle, colonia y zona: nada más del objeto viaja a la orden', async () => {
  const o = orden({ direccion: 'Hidalgo 405, Centro',
    direccion_partes: { ...CENTRO, confirmada: 'f1a2', referencias: 'otra', zonaNombre: 'x', html: '<b>' } });
  assert.deepEqual(Object.keys(o.cliente.direccion_partes).sort(), ['calle', 'colonia', 'zona']);
});

await t('ORDEN', '5. una parte que no es texto no viaja, aunque «componga» la dirección', async () => {
  // [calle, 5].join(', ') === 'Hidalgo 405, 5': sin exigir texto, pasaría.
  assert.equal(partesVigentes({ direccion: 'Hidalgo 405, 5', direccion_partes: { calle: 'Hidalgo 405', colonia: 5, zona: '' } }), null);
  assert.equal('direccion_partes' in orden({ direccion: 'Hidalgo 405, 5',
    direccion_partes: { calle: 'Hidalgo 405', colonia: 5, zona: '' } }).cliente, false);
});

await t('ORDEN', '6. dirección vacía o cliente ausente: null, sin lanzar', async () => {
  assert.equal(partesVigentes({ direccion: '', direccion_partes: { calle: '', colonia: '', zona: '' } }), null);
  assert.equal(partesVigentes(undefined), null);
  assert.equal(partesVigentes({ direccion: 'Hidalgo 405, Centro', direccion_partes: 'Centro' }), null);
  assert.equal(partesVigentes({ direccion: 'Hidalgo 405, Centro', direccion_partes: null }), null);
});

// ─── B. El reporte, sin base ────────────────────────────────────────────────
const fila = (folio, cliente, datos = {}) => ({ folio, estado: 'entregado', creado_at: new Date('2026-11-19T17:00:00Z'),
  datos: { canal: 'whatsapp', modalidad: DOM, forma_pago: 'efectivo', total: 105, cliente, ...datos } });

await t('REPORTE', '7. la colonia del formulario cuenta como campo, no como «leída de la dirección»', async () => {
  const r = construirReporteVentas([fila('CW-1', { direccion: 'Hidalgo 405, Centro', direccion_partes: { colonia: 'Centro' } })]);
  assert.deepEqual(r.por_colonia.colonias.map(c => [c.colonia, c.pedidos]), [['Centro', 1]]);
  assert.equal(r.por_colonia.identificados, 1);
  assert.equal(r.por_colonia.del_texto, 0, 'vino de un campo, no del texto');
  assert.equal(r.por_colonia.sin_colonia.pedidos, 0);
  assert.equal(r.ventas[0].colonia, 'Centro');
});

await t('REPORTE', '8. el campo colonia (POS, tienda) sigue ganando sobre las partes', async () => {
  const r = construirReporteVentas([fila('CW-2', { colonia: 'Roma', direccion: 'Hidalgo 405, Centro', direccion_partes: { colonia: 'Centro' } })]);
  assert.deepEqual(r.por_colonia.colonias.map(c => c.colonia), ['Roma']);
});

await t('REPORTE', '9. partes vacías o raras no tapan la dirección escrita; una cadena suelta no es partes', async () => {
  const raras = ['', 5, { x: 1 }, null, '   '];
  const r = construirReporteVentas(raras.map((colonia, i) => fila(`CW-3${i}`, { direccion: 'Calle 1, col. Juárez', direccion_partes: { colonia } })));
  assert.deepEqual(r.por_colonia.colonias.map(c => [c.colonia, c.pedidos]), [['Juárez', raras.length]]);
  assert.equal(r.por_colonia.del_texto, raras.length);
  const s = construirReporteVentas([fila('CW-4', { direccion: 'Morelos 12', direccion_partes: 'Centro' })]);
  assert.equal(s.por_colonia.sin_colonia.pedidos, 1);
});

await t('REPORTE', '10. una colonia del formulario también ayuda a reconocer pedidos viejos que la traen en el texto', async () => {
  const r = construirReporteVentas([
    fila('CW-5', { direccion: 'Hidalgo 405, Centro', direccion_partes: { colonia: 'Centro' } }),
    fila('CW-6', { direccion: 'Morelos 12, Centro' }), // anterior al cambio: solo texto
  ]);
  assert.deepEqual(r.por_colonia.colonias.map(c => [c.colonia, c.pedidos]), [['Centro', 2]]);
  assert.equal(r.por_colonia.del_texto, 1);
});

// ─── C. De punta a punta, con base ──────────────────────────────────────────
const sinEfectos = async () => { throw Error('NO_PEDIDOS_PAGOS_TICKETS'); };
const IDS = { categorias: '66666666666', carrito: '77777777777', categoriasDir: '88888888888', carritoDir: '99999999999' };
const TZ = 'America/Matamoros';

// Mismo arnés que fase-flows-direccion-db: un café en el carrito, Flows con el
// contrato de dirección, zonas de envío. Sin modelo.
async function fixture() {
  const f = await prepararNegocioBotones();
  const reglas = { restaurante: 'Prueba aislada', timezone: TZ,
    horarios: Object.fromEntries(['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo']
      .map(d => [d, { abierto: true, apertura: '00:00', cierre: '24:00' }])),
    pedidos: { modalidades: ['recoger en tienda', DOM], tiempo_preparacion_minutos: 20,
      pedido_minimo_entrega: 0, costo_envio: 60, pago_aceptado: ['efectivo'], zonas_entrega: [
        { nombre: 'UTNC', costo: 150 }, { nombre: 'Cervecera', costo: 150 }] },
    cierres_especiales: [], promociones: [], politicas: [] };
  await actualizarConfiguracion({ nombre: 'Prueba colonias', reglas_atencion: JSON.stringify(reglas),
    whatsapp_inicio_mapo_v1: 'true', whatsapp_atencion_general_v1: 'true', bot_whatsapp_solo_prueba: 'false',
    mesero_agente_porcentaje: '100', mesero_agente_telefonos: '', whatsapp_flows_v1: 'true', whatsapp_flows_telefonos: '',
    whatsapp_beta_hibrido_v1: 'true', whatsapp_beta_telefonos: '', whatsapp_carrito_unificado_v1: 'true',
    whatsapp_interactivos_elecciones_v1: 'true', whatsapp_flow_categorias_id: IDS.categorias, whatsapp_flow_carrito_id: IDS.carrito,
    whatsapp_flow_configurar_id: '44444444444', whatsapp_trazabilidad_formularios_v1: 'true',
    whatsapp_flow_categorias_dir_id: IDS.categoriasDir, whatsapp_flow_carrito_dir_id: IDS.carritoDir }, f.negocioId);
  const leer = () => leerEstadoVersionado(f.negocioId, f.telefono);
  const ident = () => ({ id: 'wamid.colonia.' + randomUUID(), from: f.telefono, timestamp: String(Math.floor(Date.now() / 1000)) });
  const texto = body => ({ ...ident(), type: 'text', text: { body } });
  const recibo = (q, revision) => ({ ...ident(), type: 'interactive', context: { id: q.wamid }, interactive: { type: 'nfm_reply', nfm_reply: {
    name: 'flow', body: 'Sent', response_json: JSON.stringify({ flow_token: q.interactivo.action.parameters.flow_token, revision }) } } });
  const procesar = async (m, { efectos = {} } = {}) => {
    await pool.query(`INSERT INTO whatsapp_entradas(negocio_id,telefono,wamid,payload,estado) VALUES($1,$2,$3,$4,'completado')
      ON CONFLICT (negocio_id,wamid) DO UPDATE SET estado='completado'`, [f.negocioId, f.telefono, m.id, JSON.stringify({ message: m })]);
    const interaccion = m.type === 'interactive' ? { interaccion: { mensajes: [m], mixto: false } } : {};
    const r = await atenderConAgente({ ...f, mensaje: m.text?.body || '', wamids: [m.id], ...interaccion,
      llamarModelo: async () => { throw Error('NO_DEBE_LLAMAR_MODELO'); },
      registrar: sinEfectos, emitir: sinEfectos, guardar: sinEfectos, crearPago: sinEfectos, ...efectos });
    assert.equal(r.ok, true, JSON.stringify(r));
    if (!r.outbox) return { r };
    const { rows: [fila] } = await pool.query('SELECT * FROM agente_outbox WHERE evento_clave=$1', [r.outbox.clave]);
    // El recibo y los botones contestan A ESTE mensaje (context.id = wamid).
    const wamid = 'wamid.salida.' + randomUUID();
    if (!r.yaEntregado) assert.equal((await entregarRespuesta({ outboxClave: fila.evento_clave,
      enviar: async () => ({ messages: [{ id: wamid }] }), alHumano: sinEfectos })).estado, 'entregado');
    return { ...fila.carga, r, wamid };
  };
  const flow = (q) => {
    const flow_token = q.interactivo.action.parameters.flow_token;
    return {
      init: () => atenderFlowRepetible(pool, { action: 'INIT', flow_token }),
      paso: (screen, revision, data) => atenderFlowRepetible(pool, { action: 'data_exchange', flow_token, screen, data: { revision, ...data } }),
    };
  };
  const boton = (q, title) => {
    const b = q.interactivo?.action?.buttons?.find(x => x.reply.title === title); assert(b, `No existe el botón ${title}`);
    return { ...ident(), type: 'interactive', context: { id: q.wamid }, interactive: { type: 'button_reply', button_reply: { id: b.reply.id, title } } };
  };
  // Del formulario al pedido registrado de verdad en la base local.
  const pedirConDireccion = async (direccion) => {
    const q = await procesar(texto('seguir pedido'));
    assert.equal(q.interactivo?.action?.parameters?.flow_id, IDS.carritoDir, 'sale el formulario con dirección');
    const fl = flow(q);
    let v = await fl.init();
    v = await fl.paso('CARRITO', v.data.revision, { operacion: 'guardar' });
    v = await fl.paso('ENTREGA', v.data.revision, { operacion: 'revisar', modalidad: 'm1', pago: 'p0' });
    assert.equal(v.screen, 'DIRECCION');
    v = await fl.paso('DIRECCION', v.data.revision, { operacion: 'direccion', ...direccion });
    assert.equal(v.screen, 'SUCCESS', JSON.stringify(v.data?.error));
    const resumen = await procesar(recibo(q, v.data.extension_message_response.params.revision));
    assert.equal((await leer()).pendiente?.tipo, 'confirmar_resumen');
    const registrados = [];
    await procesar(boton(resumen, 'Confirmar'), { efectos: {
      registrar: async (o, canal) => { const p = await registrarPedido(o, canal); registrados.push(p); return p; },
      emitir: async () => {}, guardar: async () => {} } });
    assert.equal(registrados.length, 1, 'se registró un pedido');
    const { rows: [pa] } = await pool.query('SELECT folio,datos FROM pedidos_activos WHERE negocio_id=$1 AND folio=$2',
      [f.negocioId, registrados[0].id]);
    return { resumen, pa };
  };
  const reporte = () => {
    const hoy = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date());
    const antier = new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(Date.now() - 2 * 864e5));
    return obtenerReporteVentas({ negocioId: f.negocioId, desde: antier, hasta: hoy, tz: TZ, hoy });
  };
  return { ...f, pedirConDireccion, reporte };
}

try {
  await t('PUNTA', '11. formulario con colonia → pedido registrado: direccion_partes en pedidos_activos, sin colonia suelta; el reporte la cuenta', async () => {
    const f = await fixture();
    const { resumen, pa } = await f.pedirConDireccion({ zona: 'zn', calle: 'Hidalgo 405', colonia: 'Centro', referencias: 'Portón negro' });
    assert.match(resumen.texto, /Dirección: Hidalgo 405, Centro/, 'el resumen dice lo de siempre');
    const c = pa.datos.cliente;
    assert.equal(c.direccion, 'Hidalgo 405, Centro');
    assert.equal(c.referencias, 'Portón negro');
    assert.deepEqual(c.direccion_partes, { calle: 'Hidalgo 405', colonia: 'Centro', zona: '' }, 'la colonia pasó la puerta de registro');
    assert.equal('colonia' in c, false, 'sin cliente.colonia: panel, comanda y repartidor ven lo mismo que antes');
    assert.equal('calle' in c, false);
    assert.equal(Number(pa.datos.total), 105, 'el total no cambia (café $45 + envío $60)');
    const r = await f.reporte();
    assert.deepEqual(r.por_colonia.colonias.map(x => [x.colonia, x.pedidos]), [['Centro', 1]], JSON.stringify(r.por_colonia));
    assert.equal(r.por_colonia.del_texto, 0);
    assert.equal(r.por_colonia.sin_colonia.pedidos, 0);
  });

  await t('PUNTA', '12. zona de la lista sin colonia: la parte viaja vacía y el reporte NO inventa la colonia con la zona', async () => {
    const f = await fixture();
    const { pa } = await f.pedirConDireccion({ zona: 'z0', calle: 'Edificio 3', colonia: '', referencias: '' });
    assert.equal(pa.datos.cliente.direccion, 'Edificio 3, UTNC');
    assert.deepEqual(pa.datos.cliente.direccion_partes, { calle: 'Edificio 3', colonia: '', zona: 'UTNC' });
    const r = await f.reporte();
    assert.equal(r.por_colonia.colonias.length, 0, JSON.stringify(r.por_colonia.colonias));
    assert.equal(r.por_colonia.sin_colonia.pedidos, 1);
  });
} finally {
  await pool.end();
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallidas) process.exitCode = 1;
