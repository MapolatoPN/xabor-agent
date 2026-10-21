// El ticket del cliente de un pedido: uno solo, por Xabor Edge.
//
// Decisión de Mario (21-oct-2026): el ticket automático (al cobrar, ✏️ Pago)
// y el manual (🧾) tienen que ser el mismo, con el «Diseño de ticket y
// comanda». Fija:
//   A. sin base: el ticket lleva lo mismo que el del navegador (orden, canal,
//      cliente, forma de pago, artículos, Gran Total y monto en letra, pago,
//      entrega, QR), respeta las opciones y cabe en el papel; el Edge 1.2 lo
//      imprime y uno viejo también entiende el trabajo; el panel lo pide al
//      servidor y solo usa el navegador cuando no hay Edge para tickets;
//   B. con Postgres: cuándo va por el Edge (Caja conectada con 1.2 o más) y
//      cuándo no, sin crear trabajos de más; un toque, un ticket;
//   C. con el servidor real y un Edge de prueba: le llega el trabajo;
//   D. en Chrome, el botón 🧾 de una comanda del tablero.
import assert from 'assert';
import vm from 'vm';
import { randomUUID, createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import WebSocket from 'ws';
import { montoEnLetra, datosDeTicketDePedido, payloadDeTicketDePedido } from '../src/printing/ticketDePedido.js';
import { renglonesDeTicketDePedido } from '../src/printing/formato/ticketPedido.js';
import { formatoDeDocumento } from '../src/printing/formato/index.js';
import { puntosDeRenglon } from '../src/printing/formato/maquetador.js';
import { normalizarFormato } from '../src/printing/formato/opciones.js';
import { interpretarFormato, esFormatoValido } from '../edge/renderers/formato.js';
import { renderCuenta } from '../edge/renderers/index.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}`); }
}

const PANEL = readFileSync(join(__dirname, '../panel/index.html'), 'utf8');
const MODULO = readFileSync(join(__dirname, '../panel/ticketPedido.js'), 'utf8');
const textos = (R) => R.filter(r => typeof r.texto === 'string').map(r => r.texto.trim());
const todo = (R) => textos(R).join('\n');

// El pedido 2093 de Acuña, como lo dejó el cobro.
const PEDIDO_2093 = {
  id: 'XAB-2093', canal: 'presencial', modalidad: 'recoger en tienda', timestamp: '2026-10-21T14:36:00.000Z',
  cliente: { nombre: 'Laura', telefono: '—' }, forma_pago: 'terminal', pago_confirmado: true,
  descuento: 195, motivo_descuento: 'Cortesía', total: 225,
  items: [
    { nombre: 'Chilaquiles Sencillos', cantidad: 1, precio: 195,
      modificadores: [{ grupo: 'Salsa', opcion: 'Verde' }, { grupo: 'Proteína', opcion: 'Pechuga de pollo' }],
      notas: 'Salsa: Verde · Proteína: Pechuga de pollo' },
    { nombre: 'Chilaquiles Sencillos', cantidad: 1, precio: 225,
      modificadores: [{ grupo: 'Salsa', opcion: 'Verde' }, { grupo: 'Proteína', opcion: 'Huevos Revueltos' }],
      notas: 'Salsa: Verde · Proteína: Huevos Revueltos · Sin cebolla' },
  ],
};
const NEGOCIO = { nombre: 'Mapolato Acuña', nombreCorto: 'Mapolato Acuña', direccion: 'Aquiles Serdán 735', ciudad: 'Acuña',
  rfc: 'XAXX010101000', telefono: '8771234567', whatsapp: '8777654321' };

// ═══════════ A. Sin base ═══════════
console.log('\nA. El ticket');

await t('A', '1. el monto en letra, con centavos de verdad', () => {
  assert.strictEqual(montoEnLetra(225), 'DOSCIENTOS VEINTICINCO PESOS 00/100 M.N.');
  assert.strictEqual(montoEnLetra(1100.5), 'MIL CIEN PESOS 50/100 M.N.');
  assert.strictEqual(montoEnLetra(21), 'VEINTIÚN PESOS 00/100 M.N.');
  assert.strictEqual(montoEnLetra(101), 'CIENTO UN PESOS 00/100 M.N.');
  assert.strictEqual(montoEnLetra(2016.07), 'DOS MIL DIECISÉIS PESOS 07/100 M.N.');
  assert.strictEqual(montoEnLetra(0.99), 'CERO PESOS 99/100 M.N.');
  assert.strictEqual(montoEnLetra(1000), 'MIL PESOS 00/100 M.N.');
  assert.strictEqual(montoEnLetra(45.995), 'CUARENTA Y SEIS PESOS 00/100 M.N.');
});

await t('A', '2. los datos son los mismos que calculaba el navegador', () => {
  const d = datosDeTicketDePedido(PEDIDO_2093);
  assert.strictEqual(d.orden, '#2093');
  assert.strictEqual(d.canal, 'Presencial');
  assert.strictEqual(d.modalidad, 'EN TIENDA · PRESENCIAL');
  assert.strictEqual(d.formaPago, 'Terminal');
  assert.strictEqual(d.cliente.nombre, 'Laura');
  assert.strictEqual(d.cliente.telefono, null, '«—» no es un teléfono');
  assert.strictEqual(d.articulos, 2);
  assert.deepStrictEqual(d.items.map(i => i.importe), [195, 225]);
  assert.strictEqual(d.totalEnLetra, 'DOSCIENTOS VEINTICINCO PESOS 00/100 M.N.');
  assert.strictEqual(datosDeTicketDePedido({ ...PEDIDO_2093, forma_pago: 'por_cobrar', pago_confirmado: false }).formaPago, '');
  const dom = datosDeTicketDePedido({ ...PEDIDO_2093, canal: 'whatsapp', modalidad: 'entrega a domicilio',
    cliente: { nombre: 'Ana', telefono: '5218771112233', calle: 'Hidalgo', numero_exterior: '12', colonia: 'Centro' } });
  assert.strictEqual(dom.modalidad, 'ENTREGA A DOMICILIO');
  assert.strictEqual(dom.canal, 'WhatsApp');
  assert.deepStrictEqual(dom.cliente.direccion, ['Hidalgo', '#12', 'Col. Centro']);
  assert.strictEqual(datosDeTicketDePedido({ ...PEDIDO_2093, cliente: { telefono: 'rappi-123' } }).cliente.telefono, null);
});

await t('A', '3. el papel trae lo mismo que el ticket del navegador', () => {
  const R = renglonesDeTicketDePedido(datosDeTicketDePedido(PEDIDO_2093), { ancho: 48, formato: normalizarFormato(null), negocio: NEGOCIO });
  const x = todo(R);
  for (const esperado of ['MAPOLATO ACUÑA', 'TICKET DE CLIENTE · Presencial', 'Aquiles Serdán 735, Acuña', 'RFC: XAXX010101000', 'Tel: 8771234567',
    'ORDEN #2093', 'EN TIENDA · PRESENCIAL', 'Laura', 'Terminal', 'Descuento (Cortesía)', 'Artículos: 2',
    'DOSCIENTOS VEINTICINCO PESOS 00/100 M.N.', 'Gracias por su visita', 'WhatsApp: 8777654321']) {
    assert.ok(x.includes(esperado), `falta «${esperado}»:\n${x}`);
  }
  assert.ok(R.some(r => r.texto?.startsWith('ORDEN #2093') && r.tam === 'doble'), 'el número de orden no va grande');
  assert.ok(R.some(r => r.texto?.trim() === 'EN TIENDA · PRESENCIAL' && r.invertido), 'la modalidad no va resaltada');
  const total = R.find(r => r.texto?.startsWith('GRAN TOTAL'));
  assert.ok(total && total.texto.endsWith('$225.00') && total.tam === 'doble', JSON.stringify(total));
  // Opciones en lista; la nota sin repetirlas; lo propio de la nota sí sale.
  assert.ok(x.includes('Proteína: Pechuga de pollo') && x.includes('Sin cebolla'));
  assert.ok(!x.includes('Salsa: Verde · Proteína'), 'la nota repite las opciones');
  assert.ok(!x.includes('Teléfono'), 'sin teléfono no sale la etiqueta');
});

await t('A', '4. cabe en 58 mm, 80 mm y 80 mm a todo lo ancho, sin perder palabras', () => {
  const largo = { ...PEDIDO_2093, items: [{ nombre: 'Huevos revueltos con jamón, tocino y chorizo de la casa con frijoles', cantidad: 12, precio: 1234.5 }] };
  for (const ancho of [32, 42, 48]) {
    const R = renglonesDeTicketDePedido(datosDeTicketDePedido(largo), { ancho, formato: normalizarFormato(null), negocio: NEGOCIO });
    for (const r of R) if (typeof r.texto === 'string') assert.ok(puntosDeRenglon(r) <= ancho * 12, `${ancho}: «${r.texto}» no cabe`);
    const x = todo(R).replace(/\s+/g, ' ');
    assert.ok(x.includes('chorizo de la casa con frijoles'), `${ancho}: se perdió parte del nombre`);
    const primero = R.find(r => r.texto?.includes('12 Huevos'));
    assert.ok(primero.texto.endsWith('$14814.00'), `${ancho}: el importe no va en el primer renglón: «${primero.texto}»`);
  }
});

await t('A', '5. respeta las opciones del «Diseño de ticket y comanda»', () => {
  const f = normalizarFormato({ ticket: { negocio: false, direccion: false, rfc: false, telefono: false, whatsapp: false,
    modificadores: false, totalGrande: false, pie: 'Vuelva pronto' } });
  const R = renglonesDeTicketDePedido(datosDeTicketDePedido(PEDIDO_2093), { ancho: 48, formato: f, negocio: NEGOCIO });
  const x = todo(R);
  for (const fuera of ['MAPOLATO', 'RFC', 'Tel:', 'WhatsApp', 'Aquiles', 'Gracias por su visita']) assert.ok(!x.includes(fuera), `salió «${fuera}»`);
  assert.ok(x.includes('Vuelva pronto'));
  assert.ok(!R.some(r => r.texto?.trim() === 'Proteína: Pechuga de pollo'), 'sin desglose no deben salir las opciones en lista');
  assert.strictEqual(R.find(r => r.texto?.startsWith('GRAN TOTAL')).tam, 'alto');
});

await t('A', '6. entrega, billete, pago mixto y QR de autofactura', () => {
  const qr = { size: 21, data: 'x'.repeat(21 * 21) };
  const dom = datosDeTicketDePedido({ ...PEDIDO_2093, canal: 'whatsapp', modalidad: 'entrega a domicilio', costo_envio: 30,
    cliente: { nombre: 'Ana', telefono: '8771112233', direccion: 'Hidalgo 12, Centro', referencias: 'Portón verde' },
    forma_pago: 'efectivo', billete: 500, cambio: 245 }, { autofactura: { url: 'https://xabor.mx/f/abc', qr } });
  const R = renglonesDeTicketDePedido(dom, { ancho: 42, formato: normalizarFormato(null), negocio: NEGOCIO });
  const x = todo(R);
  for (const esperado of ['ENTREGA A DOMICILIO', 'DATOS DEL CLIENTE', 'Nombre: Ana', 'Hidalgo 12, Centro', 'Referencias: Portón verde',
    'Teléfono: 8771112233', 'Costo de envío', 'Billete', 'Cambio', 'ESCANEA PARA FACTURAR']) {
    assert.ok(x.includes(esperado), `falta «${esperado}»`);
  }
  assert.ok(R.some(r => r.qr === qr), 'falta el QR');
  const mixto = renglonesDeTicketDePedido(datosDeTicketDePedido({ ...PEDIDO_2093, forma_pago: 'mixto', mixto_efectivo: 100, mixto_terminal: 125 }),
    { ancho: 42, formato: normalizarFormato(null), negocio: NEGOCIO });
  assert.ok(todo(mixto).includes('TOTAL POR FORMA DE PAGO'));
});

await t('A', '7. el trabajo de cuenta usa este armado solo si es de un pedido; las cuentas de Mesas no cambian', () => {
  const d = datosDeTicketDePedido(PEDIDO_2093);
  const payload = payloadDeTicketDePedido(d, { folio: 'XAB-2093', negocio: 'Mapolato Acuña' });
  const f = formatoDeDocumento('cuenta', payload, { ancho: 48, negocio: NEGOCIO });
  assert.ok(esFormatoValido(f));
  assert.ok(todo(f.renglones).includes('TICKET DE CLIENTE'));
  const mesa = formatoDeDocumento('cuenta', { negocio: 'Mapolato', mesa: 7, mesero: 'Angel', items: [{ cantidad: 1, producto: 'Café', precioUnitario: 30 }], total: 30 }, { ancho: 48 });
  assert.ok(!todo(mesa.renglones).includes('TICKET DE CLIENTE') && todo(mesa.renglones).includes('Mesa 7'), 'cambió el ticket de Mesas');
});

await t('A', '8. el Edge 1.2 lo imprime, y uno viejo también entiende el trabajo', () => {
  const d = datosDeTicketDePedido(PEDIDO_2093);
  const payload = payloadDeTicketDePedido(d, { folio: 'XAB-2093', negocio: 'Mapolato Acuña' });
  const bytes = interpretarFormato(formatoDeDocumento('cuenta', payload, { ancho: 48, negocio: NEGOCIO }), { ancho: 48 }).toString('latin1');
  assert.ok(bytes.includes('ORDEN #2093') && bytes.includes('$225.00'));
  const viejo = renderCuenta(payload, { ancho: 42 }).toString('latin1');
  assert.ok(viejo.includes('MAPOLATO') && viejo.includes('$225.00') && viejo.includes('Chilaquiles'), 'un Edge viejo no imprime un ticket legible');
});

console.log('\nA. Panel');
await t('A', '9. index.html carga el módulo con su huella y el ticket pasa por él, con el navegador de respaldo', () => {
  const huella = createHash('sha256').update(MODULO).digest('hex').slice(0, 8);
  const m = /<script src="\/ticketPedido\.js\?v=([0-9a-f]{8})"><\/script>/.exec(PANEL);
  assert.ok(m, 'falta la etiqueta de ticketPedido.js');
  assert.strictEqual(m[1], huella, `el ?v= dice "${m[1]}" y el archivo tiene huella "${huella}": pon "${huella}" en index.html`);
  const fn = PANEL.slice(PANEL.indexOf('function imprimirTicketCliente(id)'), PANEL.indexOf('function imprimirTicketDePago('));
  assert.ok(/if \(window\.XaborTicket && window\.XaborTicket\.porEdge\) \{\s*window\.XaborTicket\.imprimir\(id, \(\) => abrirPopupImpresion\(ticketHTML\(p\)\)\);\s*return true;\s*\}\s*return abrirPopupImpresion\(ticketHTML\(p\)\);/.test(fn),
    'el ticket no va por XaborTicket solo cuando el negocio imprime por el Edge, con el navegador en el mismo clic si no');
  for (const llamada of ["imprimirTicketCliente('${p.id}')", 'if (imprimirTicketCliente(folio)) return true;']) assert.ok(PANEL.includes(llamada), `cambió ${llamada}`);
});

function cargarModulo(respuesta, consulta = { status: 200, body: { porEdge: true } }) {
  const llamadas = [];
  const avisos = [];
  const window = {
    apiFetch: async (url, opts = {}) => {
      if (url === '/api/impresion/ticket-por-edge') {
        if (consulta === 'red') throw new Error('sin red');
        return { ok: consulta.status < 400, status: consulta.status, json: async () => consulta.body };
      }
      llamadas.push({ url, cuerpo: JSON.parse(opts.body) });
      if (respuesta === 'red') throw new Error('sin red');
      return { ok: respuesta.status < 400, status: respuesta.status, json: async () => respuesta.body };
    },
    avisoPanel: (texto, o) => avisos.push({ texto, error: !!o?.error }),
    folioCorto: (f) => '#' + f.replace('XAB-', ''),
    crypto: { randomUUID },
  };
  vm.runInNewContext(MODULO, { window, JSON, Date, Math, encodeURIComponent, setTimeout: () => 0, setInterval: () => 0 });
  return { XT: window.XaborTicket, llamadas, avisos, cambiarConsulta: (c) => { consulta = c; } };
}

await t('A', '10. el panel sabe si el negocio imprime el ticket por el Edge (y sin red no cambia de opinión)', async () => {
  const si = cargarModulo(null, { status: 200, body: { porEdge: true } });
  assert.strictEqual(si.XT.porEdge, false, 'antes de preguntar, el navegador');
  assert.strictEqual(await si.XT.refrescar(), true);
  assert.strictEqual(si.XT.porEdge, true);
  const no = cargarModulo(null, { status: 200, body: { porEdge: false, motivo: 'edge_anterior' } });
  assert.strictEqual(await no.XT.refrescar(), false);
  const caido = cargarModulo(null, { status: 500, body: {} });
  assert.strictEqual(await caido.XT.refrescar(), false);
  const sinRed = cargarModulo(null, 'red');
  assert.strictEqual(await sinRed.XT.refrescar(), false);
  // Ya sabía que hay Edge: un corte de red de un momento no lo cambia.
  si.cambiarConsulta('red');
  assert.strictEqual(await si.XT.refrescar(), true, 'un corte de red cambió de opinión');
});

await t('A', '11. el panel: por el Edge no abre el navegador; si en ese momento ya no se puede, el navegador', async () => {
  let navegador = 0;
  const respaldo = () => { navegador++; return true; };
  const edge = cargarModulo({ status: 200, body: { ok: true, porEdge: true, impresoras: ['CAJA'] } });
  assert.strictEqual(await edge.XT.imprimir('XAB-2093', respaldo), true);
  assert.strictEqual(navegador, 0, 'abrió el navegador con el ticket ya enviado al Edge');
  assert.ok(edge.avisos.some(a => a.texto.includes('ticket enviado a CAJA') && !a.error));
  assert.strictEqual(edge.llamadas[0].url, '/api/pedidos/XAB-2093/ticket');
  await edge.XT.imprimir('XAB-2093', respaldo);
  assert.notStrictEqual(edge.llamadas[0].cuerpo.intento, edge.llamadas[1].cuerpo.intento, 'dos toques mandaron el mismo intento');
  for (const r of [{ status: 200, body: { ok: true, porEdge: false, motivo: 'sin_caja' } }, { status: 500, body: {} }, 'red']) {
    navegador = 0;
    const m = cargarModulo(r);
    assert.strictEqual(await m.XT.imprimir('XAB-2093', respaldo), true);
    assert.strictEqual(navegador, 1, `${JSON.stringify(r)}: no usó el navegador`);
  }
  const bloqueado = cargarModulo({ status: 200, body: { ok: true, porEdge: false } });
  assert.strictEqual(await bloqueado.XT.imprimir('XAB-2093', () => false), false);
  assert.ok(bloqueado.avisos.some(a => a.error && a.texto.includes('bloqueó')), 'con la ventana bloqueada no avisa');
  const espera = cargarModulo({ status: 200, body: { ok: true, porEdge: true, impresoras: [], enEspera: ['CAJA'] } });
  navegador = 0;
  await espera.XT.imprimir('XAB-2093', respaldo);
  assert.strictEqual(navegador, 0, 'un ticket en espera no debe salir también por el navegador');
  assert.ok(espera.avisos.some(a => a.error && a.texto.includes('no está conectada')));
});

// ═══════════ B, C, D: con Postgres ═══════════
const SEED_PATH = join(__dirname, '.datos-prueba.json');
const url = process.env.DATABASE_URL || '';
if (!url || /railway|rlwy/.test(url) || !existsSync(SEED_PATH)) {
  console.log('\n(Partes B, C y D omitidas: hace falta DATABASE_URL local y test/.datos-prueba.json)');
} else {
  console.log('\nB. Servicio');
  const SEED = JSON.parse(readFileSync(SEED_PATH, 'utf8'));
  const { pool } = await import('../src/services/database.js');
  const S = await import('../src/services/impresionService.js');
  const T = await import('../src/printing/ticketDePedido.js');
  const ED = await import('../src/services/edgeService.js');
  const nid = SEED.negocioA;
  const sufijo = randomUUID().slice(0, 8);
  let sid = await S.resolverSucursal(nid, null);
  if (!sid) sid = (await pool.query(`INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, $2) RETURNING id`, [nid, `Ticket ${sufijo}`])).rows[0].id;
  const folios = [];
  const pedido = async (cambios = {}, estado = 'listo') => {
    const folio = `TST-${randomUUID().slice(0, 8)}`;
    folios.push(folio);
    const datos = { ...PEDIDO_2093, id: folio, negocioId: nid, timestamp: new Date().toISOString(), ...cambios };
    await pool.query(`INSERT INTO pedidos_activos (folio, estado, datos, negocio_id) VALUES ($1, $2, $3, $4)`, [folio, estado, JSON.stringify(datos), nid]);
    return folio;
  };
  const trabajosDe = async (folio) => (await pool.query(
    `SELECT id, impresora_nombre, payload FROM impresion_trabajos WHERE negocio_id = $1 AND origen_tipo = 'pedido_ticket' AND origen_id LIKE $2`,
    [nid, `${folio}#%`])).rows;

  const caja = await ED.crearEdge(nid, { nombre: `CAJA-TICKET-${sufijo}`, sucursalId: sid });
  const impCaja = await S.crearImpresora(nid, { terminalId: caja.id, nombre: `CAJA-T-${sufijo}`, transporte: 'mock', anchoColumnas: 48 });
  let estadoCaja = { conectado: true, version: '1.2.0' };
  const estadoTerminal = (id) => (id === caja.id ? estadoCaja : { conectado: false });
  let srv = null;
  let rutaCaja = null;
  try {
    await t('B', '12. sin impresora de Caja en el Edge, el navegador', async () => {
      // Otras rutas de cuenta de la base no deben estorbar: se apagan las ajenas a esta prueba.
      await pool.query(`UPDATE impresion_rutas SET activa = false WHERE negocio_id = $1 AND sucursal_id = $2 AND ambito = 'documento' AND clave = 'cuenta'`, [nid, sid]);
      assert.strictEqual(await T.motivoParaNoUsarEdge(nid, estadoTerminal), 'sin_caja');
      rutaCaja = await S.crearRuta(nid, { impresoraId: impCaja.id, ambito: 'documento', clave: 'cuenta' });
      assert.strictEqual(await T.motivoParaNoUsarEdge(nid, estadoTerminal), null);
    });

    await t('B', '13. solo con la Caja conectada y Edge 1.2 o más', async () => {
      for (const [estado, esperado] of [[{ conectado: false, version: '1.2.0' }, 'caja_desconectada'], [{ conectado: true, version: null }, 'edge_anterior'],
        [{ conectado: true, version: '1.1.0' }, 'edge_anterior'], [{ conectado: true, version: '1.2.0' }, null], [{ conectado: true, version: '1.10.0' }, null]]) {
        estadoCaja = estado;
        assert.strictEqual(await T.motivoParaNoUsarEdge(nid, estadoTerminal), esperado, JSON.stringify(estado));
      }
      estadoCaja = { conectado: true, version: '1.2.0' };
      await S.actualizarImpresora(nid, impCaja.id, { activa: false });
      assert.strictEqual(await T.motivoParaNoUsarEdge(nid, estadoTerminal), 'sin_caja', 'una impresora apagada cuenta como Caja');
      await S.actualizarImpresora(nid, impCaja.id, { activa: true });
    });

    await t('B', '14. por el Edge: un trabajo de cuenta con el ticket del pedido; un toque, un ticket', async () => {
      const folio = await pedido();
      const intento = randomUUID();
      const r = await T.imprimirTicketDePedido({ negocioId: nid, folio, intento, estadoTerminal });
      assert.strictEqual(r.porEdge, true);
      assert.deepStrictEqual(r.impresoras, [impCaja.nombre]);
      const [j] = await trabajosDe(folio);
      assert.strictEqual(j.payload.documento, 'cuenta');
      assert.strictEqual(j.payload.ticketDePedido.formaPago, 'Terminal');
      assert.strictEqual(j.payload.formato.ancho, 48, 'el ticket no se armó al ancho de la impresora');
      assert.ok(j.payload.formato.renglones.some(x => x.texto?.includes('TICKET DE CLIENTE')));
      const otra = await T.imprimirTicketDePedido({ negocioId: nid, folio, intento, estadoTerminal });
      assert.strictEqual(otra.repetido, true);
      assert.strictEqual((await trabajosDe(folio)).length, 1, 'el mismo toque sacó dos tickets');
      await T.imprimirTicketDePedido({ negocioId: nid, folio, intento: randomUUID(), estadoTerminal });
      assert.strictEqual((await trabajosDe(folio)).length, 2, 'un segundo toque no sacó otro ticket');
    });

    await t('B', '15. si no va por el Edge no crea ningún trabajo', async () => {
      const folio = await pedido();
      estadoCaja = { conectado: true, version: '1.1.0' };
      const r = await T.imprimirTicketDePedido({ negocioId: nid, folio, intento: randomUUID(), estadoTerminal });
      estadoCaja = { conectado: true, version: '1.2.0' };
      assert.deepStrictEqual([r.porEdge, r.motivo], [false, 'edge_anterior']);
      assert.strictEqual((await trabajosDe(folio)).length, 0);
    });

    await t('B', '16. el QR de autofactura solo en pedidos cobrados', async () => {
      let llamadas = 0;
      const autofactura = async () => { llamadas++; return { url: 'https://xabor.mx/f/prueba', qr: { size: 21, data: '1'.repeat(441) } }; };
      const pagado = await pedido();
      await T.imprimirTicketDePedido({ negocioId: nid, folio: pagado, intento: randomUUID(), estadoTerminal, autofactura });
      assert.strictEqual(llamadas, 1);
      assert.ok((await trabajosDe(pagado))[0].payload.formato.renglones.some(x => x.qr), 'falta el QR');
      const abierto = await pedido({ forma_pago: 'por_cobrar', pago_confirmado: false });
      await T.imprimirTicketDePedido({ negocioId: nid, folio: abierto, intento: randomUUID(), estadoTerminal, autofactura });
      assert.strictEqual(llamadas, 1, 'pidió autofactura de un pedido sin cobrar');
    });

    await t('B', '17. ni cancelados ni de otro negocio', async () => {
      const cancelado = await pedido({}, 'cancelado');
      await assert.rejects(() => T.imprimirTicketDePedido({ negocioId: nid, folio: cancelado, estadoTerminal }), (e) => e.code === 'PEDIDO_CANCELADO');
      const propio = await pedido();
      await assert.rejects(() => T.imprimirTicketDePedido({ negocioId: SEED.negocioB, folio: propio, estadoTerminal }), (e) => e.code === 'PEDIDO_NO_ENCONTRADO');
    });

    // ═══════════ C y D. Servidor real ═══════════
    console.log('\nC. Servidor');
    const visible = await pedido({ cliente: { nombre: 'Laura Chrome', telefono: '—' } }, 'nuevo');
    const { arrancarServidor } = await import('./lib-servidor.mjs');
    const { crearTokenSesion } = await import('../src/services/session.js');
    const PUERTO = process.env.TEST_PORT || '4987';
    const base = `http://localhost:${PUERTO}`;
    const STAFF = encodeURIComponent(crearTokenSesion({ usuarioId: SEED.staffNegocioAUsuarioId, negocioId: nid, rol: 'staff' }));
    const ADMIN = encodeURIComponent(crearTokenSesion({ usuarioId: SEED.adminNegocioAUsuarioId, negocioId: nid, rol: 'admin' }));
    srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 90000 });
    const { codigo } = await ED.generarEmparejamiento(nid, caja.id);
    const cred = await ED.canjearEmparejamiento(codigo);
    const conectarEdge = (version) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${PUERTO}/ws/print-agent`);
      const recibidos = [];
      ws.on('open', () => ws.send(JSON.stringify({ tipo: 'autenticar_terminal', terminalId: cred.terminalId, token: cred.token,
        instalacionId: `inst-${sufijo}`, ...(version ? { version } : {}) })));
      ws.on('message', (c) => {
        const m = JSON.parse(c.toString());
        recibidos.push(m);
        if (m.tipo === 'terminal_autenticada') resolve({ ws, recibidos });
      });
      ws.on('error', reject);
      setTimeout(() => reject(new Error('el Edge de prueba no se autenticó')), 8000);
    });
    const pedirTicket = async (folio, cookie = STAFF) => {
      const r = await fetch(`${base}/api/pedidos/${encodeURIComponent(folio)}/ticket`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `xabor_sesion=${cookie}` } : {}) },
        body: JSON.stringify({ intento: randomUUID() }) });
      return { status: r.status, body: await r.json().catch(() => null) };
    };
    const esperar = (ms) => new Promise(r => setTimeout(r, ms));

    let edge = await conectarEdge(null);
    await t('C', '18. con un Edge que no dice versión (1.1.0), el panel lo imprime con el navegador', async () => {
      const r = await pedirTicket(visible);
      assert.strictEqual(r.status, 200, JSON.stringify(r.body));
      assert.deepStrictEqual([r.body.porEdge, r.body.motivo], [false, 'edge_anterior']);
      assert.ok([401, 403].includes((await pedirTicket(visible, null)).status), 'sin sesión no debe imprimir');
      const consulta = await (await fetch(`${base}/api/impresion/ticket-por-edge`, { headers: { Cookie: `xabor_sesion=${STAFF}` } })).json();
      assert.deepStrictEqual(consulta, { porEdge: false, motivo: 'edge_anterior' });
    });

    edge.ws.close();
    await esperar(300);
    edge = await conectarEdge('1.2.0');
    await t('C', '19. con Edge 1.2.0 el ticket le llega por el WebSocket, con el diseño del negocio', async () => {
      const antes = edge.recibidos.length;
      const consulta = await (await fetch(`${base}/api/impresion/ticket-por-edge`, { headers: { Cookie: `xabor_sesion=${STAFF}` } })).json();
      assert.strictEqual(consulta.porEdge, true, JSON.stringify(consulta));
      const r = await pedirTicket(visible);
      assert.strictEqual(r.body.porEdge, true, JSON.stringify(r.body));
      // Al conectarse, el Edge recibe también lo que tenía pendiente (los
      // tickets de B): se busca el de ESTE pedido.
      const deEste = () => edge.recibidos.find(m => m.tipo === 'trabajo_impresion'
        && m.trabajo?.payload?.formato?.renglones?.some(x => x.texto?.includes('Laura Chrome')))?.trabajo;
      const fin = Date.now() + 5000;
      while (!deEste() && Date.now() < fin) await esperar(50);
      const trabajo = deEste();
      assert.ok(trabajo, `no llegó el ticket de este pedido al Edge (recibió ${edge.recibidos.length - antes} mensajes)`);
      assert.strictEqual(trabajo.documento, 'cuenta');
    });

    await t('C', '20. la vista previa de «Ticket del cliente» es este mismo ticket', async () => {
      const r = await fetch(`${base}/api/impresion/formato/vista-previa`, { method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: `xabor_sesion=${ADMIN}` }, body: JSON.stringify({ documento: 'cuenta', ancho: 48 }) });
      const b = await r.json();
      const x = textos(b.renglones).join('\n');
      assert.ok(x.includes('TICKET DE CLIENTE') && x.includes('ORDEN #125') && x.includes('GRAN TOTAL'), x);
      assert.ok(!x.includes('Le atendió'), 'la vista previa sigue mostrando una cuenta de Mesas');
    });

    // ═══════════ D. Chrome ═══════════
    console.log('\nD. Navegador');
    await t('D', '21. el 🧾 de la comanda: por el Edge sin abrir el navegador; sin Edge, el navegador', async () => {
      const puppeteer = (await import('puppeteer')).default;
      const nav = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-dev-shm-usage'] });
      const errores = [];
      try {
        const pag = await nav.newPage();
        pag.on('pageerror', e => errores.push(e.message));
        await pag.setViewport({ width: 1280, height: 900 });
        await pag.setCookie({ name: 'xabor_sesion', value: ADMIN, domain: 'localhost', path: '/' });
        await pag.goto(`${base}/app`, { waitUntil: 'networkidle0', timeout: 60000 });
        await pag.waitForSelector(`#comanda-${visible}`, { timeout: 20000 });
        await pag.evaluate(() => { window.__ventanas = 0; window.open = () => { window.__ventanas++; return null; }; });
        assert.strictEqual(await pag.evaluate(() => window.XaborTicket.refrescar()), true, 'el panel no ve el Edge de la Caja');
        const tocar = () => pag.evaluate((f) => {
          const b = [...document.querySelectorAll(`#comanda-${f} button`)].find(x => x.textContent.includes('Imprimir ticket'));
          b.click();
        }, visible);
        const antes = edge.recibidos.length;
        await tocar();
        await pag.waitForFunction(() => document.getElementById('avisos-panel')?.textContent.includes('ticket enviado'), { timeout: 10000 });
        assert.strictEqual(await pag.evaluate(() => window.__ventanas), 0, 'abrió la ventana del navegador con el Edge disponible');
        const fin = Date.now() + 5000;
        while (!edge.recibidos.slice(antes).some(m => m.tipo === 'trabajo_impresion') && Date.now() < fin) await esperar(50);
        assert.ok(edge.recibidos.slice(antes).some(m => m.tipo === 'trabajo_impresion'), 'el ticket no llegó al Edge');
        // Sin Edge: el navegador, como siempre.
        edge.ws.close();
        await esperar(500);
        assert.strictEqual(await pag.evaluate(() => window.XaborTicket.refrescar()), false);
        // Sin Edge, la ventana se abre en el mismo clic (sin esperar a la red).
        const ventanas = await pag.evaluate((f) => {
          const b = [...document.querySelectorAll(`#comanda-${f} button`)].find(x => x.textContent.includes('Imprimir ticket'));
          b.click();
          return window.__ventanas;
        }, visible);
        assert.strictEqual(ventanas, 1, 'sin Edge, el navegador no abrió la ventana en el mismo clic');
        assert.deepStrictEqual(errores, [], `errores de JavaScript: ${errores.join(' | ')}`);
      } finally { await nav.close(); }
    });
  } finally {
    srv?.detener();
    await pool.query(`DELETE FROM pedidos_activos WHERE folio = ANY($1::text[])`, [folios]).catch(() => {});
    await pool.query(`UPDATE impresion_trabajos SET estado = 'cancelado' WHERE negocio_id = $1 AND origen_tipo = 'pedido_ticket' AND estado IN ('pendiente','entregado','fallido')`, [nid]).catch(() => {});
    if (rutaCaja) await pool.query(`DELETE FROM impresion_rutas WHERE id = $1`, [rutaCaja.id]).catch(() => {});
    await pool.query(`UPDATE terminales SET activo = false, token_hash = NULL WHERE id = $1`, [caja.id]).catch(() => {});
    await pool.query(`UPDATE impresoras SET activa = false WHERE id = $1`, [impCaja.id]).catch(() => {});
    await pool.end();
  }
}

console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) console.log(fallos.join('\n'));
process.exitCode = fallidas > 0 ? 1 : 0;
