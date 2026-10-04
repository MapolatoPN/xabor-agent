// Plomería del formulario «tienda» (contrato tienda_v1, Fase 2B): dónde se
// ofrece, qué foto lleva, qué flowId espera el endpoint, qué formulario abierto
// se corta, el recibo, la telemetría, la activación y la publicación. Puro: sin
// base de datos, Meta ni red. Corre en el predeploy (predeploy-check-incidentes).
//
// Lo que más importa es lo que NO cambia: con la bandera apagada (o con
// cualquier condición de la tienda sin cumplir) cada foto, cada formulario
// armado y cada lista blanca son, byte a byte, los de sin la tienda.
// test/fase-tienda-bandera-apagada.mjs además los compara contra el código de
// la base de la rama (be1e4d0).
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { fotoFormulario, construirFormulario, formularioVigente, comandosFormulario, aplicarFormulario, TEXTOS_TIENDA }
  from '../src/mesero-agente/formularioAgrupado.js';
import { tiendaConfigurada, tiendaParaTelefono, flowIdTienda, flowIdEsperadoFormulario, flowIdsConEndpointFormularios,
  sinTiendaVieja, CLAVES_FLOW_PEDIDO } from '../src/mesero-agente/disponibilidadTienda.js';
import { flowIdEsperadoConNota, flowIdsConEndpointConNota } from '../src/mesero-agente/notaDelPedido.js';
import { borradorTienda, cambiarTienda } from '../src/mesero-agente/flowTienda.js';
import { resolverFinalFlow } from '../src/mesero-agente/flowRepetibleSql.js';
import { eventoActividadFormulario } from '../src/mesero-agente/actividadFormulario.js';
import { seguimientoFormulario, vistaRespuestaFormulario } from '../src/services/seguimientoFormulario.js';
import { borradorCompatible } from '../src/mesero-agente/recuperarBorradorFlow.js';
import { payloadInteractivoValido } from '../src/mesero-agente/transporteInteractivo.js';
import { CLAVE_RESPALDO_TIENDA, planActivacionTienda, planReversaTienda, telefonosDePrueba } from '../src/mesero-agente/activacionTienda.js';
import { POR_OMISION_TIENDA, VERSION_TIENDA } from '../src/mesero-agente/contratoTienda.js';
import { flowsDelAlcance, nombreDelFlow, TIPOS_CON_ENDPOINT, ALCANCES_FLOWS } from './alcances-flows-pedido.mjs';
import { definicionFlowTienda, nombreFlowTienda } from './definicion-flow-tienda.mjs';
import { definicionFlowCarrito } from './definicion-flow-carrito.mjs';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import * as F from './fixture-tienda-plomeria.mjs';

let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => { try { await fn(); pasadas++; } catch (e) { fallidas++; console.error(`FALLA ${nombre}: ${e.message}`); } };
const ctxDe = (cfg, estado, telefono = F.TELEFONO, carta = F.carta()) => ({ estado, catalogo: carta, modalidades: F.modalidades,
  metodosPago: F.metodosPago, reglas: F.reglas, cfg, telefono });
const sinClavesTienda = (cfg) => {
  const { whatsapp_flow_tienda_v1, whatsapp_flow_tienda_id, whatsapp_flow_tienda_telefonos, ...resto } = cfg; return resto;
};
const json = (v) => JSON.stringify(v);
// Las entradas del arreglo SCRIPTS del runner del predeploy, en orden y sin las comentadas.
const entradasDeScripts = (fuente) => {
  const m = /const SCRIPTS = \[([\s\S]*?)\n\];/.exec(fuente);
  assert(m, 'no encontré el arreglo SCRIPTS');
  return [...m[1].replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '').matchAll(/'([^']+)'/g)].map((x) => x[1]);
};
// La 114 está en SCRIPTS (sin comentar) y después de la 110, cuya tabla amplía.
// No exige que sea la última: la 113 de otra rama y las que vengan van donde toque.
const problemaDe114EnScripts = (fuente) => {
  const s = entradasDeScripts(fuente), i114 = s.indexOf('114-actividad-formulario-tienda'), i110 = s.indexOf('110-agente-actividad-formulario');
  if (i114 < 0) return 'la 114 no está en SCRIPTS: nunca llegaría a producción';
  if (i110 < 0 || i114 < i110) return 'la 114 va después de la 110';
  return null;
};
const armar = (cfg, estado, accion, telefono = F.TELEFONO) => {
  const e = estado; e.pendiente ??= null;
  return construirFormulario({ ...ctxDe(cfg, e, telefono), pedido: { huella: 'h', total: 100 }, texto: e.dialogo.texto });
};

// ── Bandera apagada: idéntico a sin la tienda ────────────────────────────
// Configuraciones de hoy (con y sin carrito unificado, dirección o nota) y,
// encima, cada forma de NO tener la tienda: la foto, el formulario armado y la
// vigencia son los mismos bytes que sin sus claves.
const BASES = [['Mapolato hoy', F.cfgHoy],
  ['sin carrito unificado', { ...F.cfgHoy, whatsapp_carrito_unificado_v1: 'false' }],
  ['sin nota', { ...F.cfgHoy, whatsapp_flow_nota_v1: 'false' }],
  ['sin dirección ni nota', { ...F.cfgHoy, whatsapp_flow_categorias_dir_id: '', whatsapp_flow_carrito_dir_id: '', whatsapp_flow_nota_v1: '' }]];
const APAGADAS = [['sin claves', {}], ['bandera false', { whatsapp_flow_tienda_v1: 'false', whatsapp_flow_tienda_id: F.IDS.tienda }],
  ['bandera TRUE', { whatsapp_flow_tienda_v1: 'TRUE', whatsapp_flow_tienda_id: F.IDS.tienda }],
  ['bandera « true»', { whatsapp_flow_tienda_v1: ' true', whatsapp_flow_tienda_id: F.IDS.tienda }],
  ['bandera vacía', { whatsapp_flow_tienda_v1: '', whatsapp_flow_tienda_id: F.IDS.tienda }],
  ['solo el flowId', { whatsapp_flow_tienda_id: F.IDS.tienda }],
  ['true sin flowId', { whatsapp_flow_tienda_v1: 'true' }],
  ['true con un flowId inválido', { whatsapp_flow_tienda_v1: 'true', whatsapp_flow_tienda_id: '12ab' }],
  ['true con el flowId de otro formulario', { whatsapp_flow_tienda_v1: 'true', whatsapp_flow_tienda_id: F.IDS.carritoNota }],
  ['prueba, sin lista', { whatsapp_flow_tienda_v1: 'prueba', whatsapp_flow_tienda_id: F.IDS.tienda }],
  ['prueba, otro teléfono', { whatsapp_flow_tienda_v1: 'prueba', whatsapp_flow_tienda_id: F.IDS.tienda, whatsapp_flow_tienda_telefonos: F.OTRO_TELEFONO }]];
const apagadas = () => BASES.flatMap(([b, base]) => APAGADAS.map(([a, extra]) => [`${b} · ${a}`, { ...base, ...extra }, base]))
  // La tienda «true» completa sobre una base sin dirección o sin nota tampoco existe.
  .concat(BASES.slice(2).map(([b, base]) => [`${b} · tienda true`, { ...base, whatsapp_flow_tienda_v1: 'true', whatsapp_flow_tienda_id: F.IDS.tienda }, base]));

for (const entorno of ['con endpoint', 'sin endpoint']) {
  const correr = entorno === 'con endpoint' ? F.conEntornoFlows : async (fn) => fn();
  await correr(() => t(`bandera apagada (${entorno}): cada foto y cada formulario armado son byte a byte los de sin la tienda`, () => {
    let n = 0;
    for (const [nombre, cfg] of apagadas()) {
      for (const [escenario, accion, mk] of F.ESCENARIOS) {
        const con = fotoFormulario(ctxDe(cfg, mk()), accion), sin = fotoFormulario(ctxDe(sinClavesTienda(cfg), mk()), accion);
        assert.equal(json(con), json(sin), `${nombre} · ${escenario}: foto`);
        assert(!json(con ?? null).includes('sin_tienda') && !json(con ?? null).includes(VERSION_TIENDA), `${nombre} · ${escenario}: rastro de la tienda`);
        // Sin el teléfono (como antes de la Fase 2B) también es la misma.
        const { telefono, ...sinTelefono } = ctxDe(cfg, mk());
        assert.equal(json(fotoFormulario(sinTelefono, accion)), json(sin), `${nombre} · ${escenario}: foto sin teléfono`);
        assert.equal(json(F.sinAzar(armar(cfg, mk(), accion))), json(F.sinAzar(armar(sinClavesTienda(cfg), mk(), accion))), `${nombre} · ${escenario}: formulario`);
        if (con) assert.equal(formularioVigente({ accion, datos: con }, ctxDe(cfg, mk())), true, `${nombre} · ${escenario}: vigencia`);
        n++;
      }
    }
    assert(n > 400, `se revisaron ${n} combinaciones`);
  }));
}
await t('bandera apagada: listas blancas, flowId esperado y barrera de la tienda son los de hoy (en prueba, para quien no está en la lista)', () => {
  const fotos = [{ version: 'carrito_v1' }, { version: 'carrito_v1', contrato: 'direccion_v1' },
    { version: 'carrito_v1', contrato: 'direccion_v1', contrato_nota: 'nota_v1' }, { version: 'repetible_v1' },
    { version: 'repetible_v1', presentacion: 'categorias_v1', contrato: 'direccion_v1', contrato_nota: 'nota_v1' },
    { version: 'edicion_v1' }, { version: 'continuo_v1' }, {}, null];
  for (const [nombre, cfg] of apagadas()) {
    // En modo prueba la tienda está configurada (su flowId sale en la lista del
    // transporte y la espera el endpoint) aunque no sea para estos clientes.
    const configurada = tiendaConfigurada(cfg);
    assert.equal(configurada, cfg.whatsapp_flow_tienda_v1 === 'prueba' && cfg.whatsapp_flow_nota_v1 === 'true' && !!cfg.whatsapp_flow_carrito_dir_id, nombre);
    for (const telefono of [F.TELEFONO, F.OTRO_TELEFONO, undefined]) {
      if (tiendaParaTelefono(cfg, telefono)) continue; // para ese cliente sí existe (se prueba abajo)
      assert.deepEqual(flowIdsConEndpointFormularios(cfg), [...flowIdsConEndpointConNota(cfg), ...(configurada ? [F.IDS.tienda] : [])], nombre);
      for (const d of fotos) {
        assert.equal(flowIdEsperadoFormulario(cfg, d), flowIdEsperadoConNota(cfg, d), `${nombre} ${json(d)}`);
        assert.equal(sinTiendaVieja(cfg, d, telefono), false, `${nombre} ${json(d)}`);
      }
      // Una tienda que quedara abierta de antes: sin la tienda se corta.
      assert.equal(flowIdEsperadoFormulario(cfg, { version: VERSION_TIENDA }), configurada ? F.IDS.tienda : null, nombre);
      assert.equal(sinTiendaVieja(cfg, { version: VERSION_TIENDA }, telefono), true, nombre);
    }
  }
});
await t('telemetría: los formularios de hoy registran los mismos pasos (su DIRECCION sigue sin paso); la tienda, TIENDA y DIRECCION', () => {
  const clave = 'a'.repeat(64), ev = (etapa, o) => eventoActividadFormulario({ action: 'data_exchange' }, { borrador: { revision: 3, etapa } }, clave, o)?.paso ?? null;
  for (const etapa of ['MENU', 'PLATILLO', 'TACOS', 'ENTREGA', 'CARRITO', 'EDITAR', 'FINAL']) assert.equal(ev(etapa), etapa);
  for (const etapa of ['DIRECCION', 'TIENDA', 'OTRA']) assert.equal(ev(etapa), null, etapa);
  for (const etapa of ['TIENDA', 'ENTREGA', 'DIRECCION', 'FINAL']) assert.equal(ev(etapa, { tienda: true }), etapa);
  for (const etapa of ['MENU', 'CARRITO', 'PLATILLO']) assert.equal(ev(etapa, { tienda: true }), null, etapa);
  assert.equal(seguimientoFormulario({ eventos: [{ tipo: 'paso', paso: 'TIENDA', observado_at: new Date().toISOString() }], estado: 'disponible' }).paso, 'Menú y pedido');
});

// ── Bandera encendida ────────────────────────────────────────────────────
const tiendaDe = (cfg, mk, accion, telefono = F.TELEFONO, carta) => F.conEntornoFlows(() => fotoFormulario(ctxDe(cfg, mk(), telefono, carta), accion));
const escenario = (nombre) => F.ESCENARIOS.find(([n]) => n === nombre);
await t('encendida: la tienda ocupa el lugar de «Arma tu pedido» y de «Tu carrito»; «Personaliza» y lo que hoy no abre, igual', async () => {
  const esperado = { 'arma tu pedido, vacío': [VERSION_TIENDA, 0, undefined], 'elegir producto, uno': [VERSION_TIENDA, 0, undefined],
    'elegir producto, tres': null, 'arma tu pedido con platillos': [VERSION_TIENDA, 2, undefined],
    'tu carrito (agregar otro)': [VERSION_TIENDA, 2, undefined], 'editar pedido': [VERSION_TIENDA, 2, 'CARRITO'],
    'dirección con pago': [VERSION_TIENDA, 2, 'DIRECCION'], 'dirección sin pago': [VERSION_TIENDA, 2, 'CARRITO'],
    'personaliza (legado)': [VERSION_TIENDA, 2, undefined], 'carrito de 21 renglones': ['carrito_v1', 21, undefined],
    'cantidad de 25': null, 'carrito vacío': [VERSION_TIENDA, 0, undefined] };
  for (const [nombre, accion, mk] of F.ESCENARIOS) {
    const f = await tiendaDe(F.cfgTienda(), mk, accion);
    if (esperado[nombre] === null) { assert.equal(f, null, nombre); continue; }
    const [version, lineas, abrir] = esperado[nombre];
    assert.equal(f?.version, version, nombre); assert.equal(f.lineas.length, lineas, nombre); assert.equal(f.abrir, abrir, nombre);
    if (version === VERSION_TIENDA) {
      assert.equal(f.flowId, F.IDS.tienda, nombre); assert.equal(f.tipo, accion, nombre);
      assert.equal(f.contrato, 'direccion_v1'); assert.equal(f.contrato_nota, 'nota_v1'); assert.equal(f.presentacion, undefined);
      assert.deepEqual(f.productos.map((p) => p.nombre), ['Chilaquiles', 'Hotcakes', 'Café americano', 'Jugo de naranja', 'Taco de Barbacoa', 'Taco de Pastor'],
        `${nombre}: el catálogo de «Arma tu pedido», en orden comercial y sin priorizar candidatos`);
      assert(f.productos.every((p) => p.categoria && p.categoriaId), nombre);
    }
  }
  // Sin carrito unificado, «Tu carrito» no existe hoy: «Personaliza» queda igual y sin marca.
  const sinUnificado = { ...F.cfgTienda(), whatsapp_carrito_unificado_v1: 'false' };
  for (const nombre of ['tu carrito (agregar otro)', 'personaliza (legado)']) {
    const [, accion, mk] = escenario(nombre);
    assert.equal(json(await tiendaDe(sinUnificado, mk, accion)), json(await tiendaDe(sinClavesTienda(sinUnificado), mk, accion)), nombre);
  }
});
await t('condiciones: si la tienda no admite la foto sale la de hoy (carrito o categorías marcadas sin_tienda con el motivo); sin endpoint, la de hoy sin marca', async () => {
  const quitar = (f) => { const { sin_tienda, ...r } = f; return r; };
  const [, accion21, mk21] = escenario('carrito de 21 renglones');
  const r21 = await tiendaDe(F.cfgTienda(), mk21, accion21), hoy21 = await tiendaDe(F.cfgHoy, mk21, accion21);
  assert.equal(r21.sin_tienda, 'renglones'); assert.equal(json(quitar(r21)), json(hoy21));
  // La marca no es el pedido: vigente con la tienda encendida y también si se revierte con él abierto.
  await F.conEntornoFlows(() => {
    assert.equal(formularioVigente({ accion: accion21, datos: r21 }, ctxDe(F.cfgTienda(), mk21())), true);
    assert.equal(formularioVigente({ accion: accion21, datos: r21 }, ctxDe(F.cfgHoy, mk21())), true, 'tras revertir la tienda');
  });
  const carta = F.carta({ categoriasExtra: 18 }), [, accionC, mkC] = escenario('arma tu pedido, vacío');
  const cat = await tiendaDe(F.cfgTienda(), mkC, accionC, F.TELEFONO, carta);
  assert.equal(cat.presentacion, 'categorias_v1'); assert.equal(cat.sin_tienda, 'categorias');
  assert.equal(json(quitar(cat)), json(await tiendaDe(F.cfgHoy, mkC, accionC, F.TELEFONO, carta)));
  // 17 extra = 20 categorías + el renglón de tacos dentro de Tacos: todavía cabe.
  assert.equal((await tiendaDe(F.cfgTienda(), mkC, accionC, F.TELEFONO, F.carta({ categoriasExtra: 17 }))).version, VERSION_TIENDA);
  // Un renglón cuyo platillo ya no está en la carta: hoy no hay «Tu carrito»; con la tienda tampoco.
  const fuera = () => F.estado({ items: [{ lid: 'X', id: 999, nombre: 'Viejo', cantidad: 1, modificadores: [] }] });
  assert.equal(await tiendaDe(F.cfgTienda(), fuera, 'flow_configurar'), null);
  // Sin carrito unificado ese pedido abre «Arma tu pedido» de hoy, marcado con el motivo.
  const armaFuera = await tiendaDe({ ...F.cfgTienda(), whatsapp_carrito_unificado_v1: 'false' }, fuera, 'flow_productos');
  assert.equal(armaFuera.presentacion, 'categorias_v1'); assert.equal(armaFuera.sin_tienda, 'producto_fuera');
  // Una carta vacía (o de más de 200 platillos) no tiene «Arma tu pedido»: tampoco tienda, y sin error.
  for (const carta of [[], [{ id: 'g', nombre: 'Grande', orden: 0, productos: Array.from({ length: 201 }, (_, i) => ({ id: 1000 + i, nombre: `P${i}`, precio: 10, disponible: true, modificadores: [] })) }]]) {
    for (const [nombre, accion, mk] of [escenario('arma tu pedido, vacío'), escenario('carrito vacío')]) {
      assert.equal(await tiendaDe(F.cfgTienda(), mk, accion, F.TELEFONO, carta), null, `${carta.length ? 'grande' : 'vacía'} · ${nombre}`);
    }
  }
  // Sin endpoint (WHATSAPP_FLOW_*) no hay ni categorías ni carrito: la foto de hoy, sin marca.
  for (const [nombre, accion, mk] of F.ESCENARIOS) {
    assert.equal(json(fotoFormulario(ctxDe(F.cfgTienda(), mk()), accion)), json(fotoFormulario(ctxDe(F.cfgHoy, mk()), accion)), `sin endpoint: ${nombre}`);
  }
});
await t('modo prueba: solo los teléfonos de la lista; los demás clientes reciben exactamente lo de hoy', async () => {
  const [, accion, mk] = escenario('tu carrito (agregar otro)');
  assert.equal((await tiendaDe(F.cfgTienda('prueba'), mk, accion, F.TELEFONO)).version, VERSION_TIENDA);
  assert.equal((await tiendaDe(F.cfgTienda('prueba', { whatsapp_flow_tienda_telefonos: '52 1 878 123 4567' }), mk, accion, F.TELEFONO)).version, VERSION_TIENDA,
    'la lista se lee como la de los Flows: espacios dentro del número');
  assert.equal(json(await tiendaDe(F.cfgTienda('prueba'), mk, accion, F.OTRO_TELEFONO)), json(await tiendaDe(F.cfgHoy, mk, accion, F.OTRO_TELEFONO)));
  assert.equal(tiendaParaTelefono(F.cfgTienda('prueba'), undefined), false);
  assert.equal(tiendaParaTelefono(F.cfgTienda('true'), undefined), true);
  assert.equal(tiendaConfigurada(F.cfgTienda('prueba')), true);
});
await t('ojo con el teléfono de prueba: la vigencia y el aplicar recalculan la foto CON el teléfono; sin él, la foto sería otra', async () => {
  const cfg = F.cfgTienda('prueba'), [, accion, mk] = escenario('tu carrito (agregar otro)');
  await F.conEntornoFlows(async () => {
    const foto = fotoFormulario(ctxDe(cfg, mk()), accion);
    assert.equal(foto.version, VERSION_TIENDA);
    assert.equal(formularioVigente({ accion, datos: foto }, ctxDe(cfg, mk())), true);
    const { telefono, ...sinTelefono } = ctxDe(cfg, mk());
    assert.equal(formularioVigente({ accion, datos: foto }, sinTelefono), false, 'sin teléfono la foto recalculada es «Tu carrito»');
    const b = borradorTienda(foto), recibo = { flow_token: 'tk', filas: b.filas, modalidad: 'm0', pago: 'p0' };
    assert.equal((await aplicarFormulario({ accion, datos: foto, respuestaFlow: recibo }, ctxDe(cfg, mk()))).ok, true);
    assert.equal((await aplicarFormulario({ accion, datos: foto, respuestaFlow: recibo }, sinTelefono)).ok, false);
  });
  // Los llamadores lo pasan (la prueba con base lo recorre de punta a punta).
  const fuente = (r) => readFileSync(new URL(r, import.meta.url), 'utf8');
  assert.match(fuente('../src/mesero-agente/interactivos.js'), /formularioVigente\(q,\{estado,telefono,\.\.\.contexto\}\)/);
  assert.match(fuente('../src/mesero-agente/canalDelAgente.js'), /aplicarFormulario\(reservaBotones,\{\.\.\.contextoElecciones,\.\.\.contextoVista,estado,telefono\}\)/);
  assert.match(fuente('../src/mesero-agente/canalDelAgente.js'), /fotoFormulario\(\{\.\.\.contextoElecciones,telefono,estado:\{\.\.\.estado,pendiente\}\},'flow_configurar'\)/);
  assert.match(fuente('../src/mesero-agente/formularioAgrupado.js'), /fotoFormulario\(\{estado,cfg,telefono,\.\.\.ctx\},accion\)/);
});
await t('construirFormulario: «Haz tu pedido» / «Ver menú», «Ver mi pedido» al editar, «Escribir dirección»; data_exchange al flowId de la tienda; carga válida', async () => {
  await F.conEntornoFlows(() => {
    const casos = [['arma tu pedido, vacío', TEXTOS_TIENDA.cuerpo, TEXTOS_TIENDA.cta], ['tu carrito (agregar otro)', TEXTOS_TIENDA.cuerpo, TEXTOS_TIENDA.cta],
      ['editar pedido', TEXTOS_TIENDA.cuerpoCarrito, TEXTOS_TIENDA.ctaCarrito], ['dirección con pago', '*Dirección de entrega*\nEscríbela en el formulario', 'Escribir dirección'],
      ['dirección sin pago', '*Dirección de entrega*\nEn el formulario toca «Continuar»', TEXTOS_TIENDA.ctaCarrito]];
    for (const [nombre, inicio, cta] of casos) {
      const [, , mk] = escenario(nombre), r = armar(F.cfgTienda(), mk(), null);
      assert(r, nombre);
      const p = r.carga.action.parameters;
      assert(r.texto.startsWith(inicio), `${nombre}: ${r.texto}`);
      assert.equal(p.flow_cta, cta, nombre); assert.equal(p.flow_action, 'data_exchange', nombre);
      assert.equal(p.flow_action_payload, undefined, nombre); assert.equal(p.flow_id, F.IDS.tienda, nombre);
      assert.equal(r.botones[0].datos.version, VERSION_TIENDA, nombre);
      assert.equal(payloadInteractivoValido(r.carga, r.texto), true, nombre);
      assert(r.texto.length <= 1024 && cta.length <= 30, nombre);
    }
  });
  for (const k of ['cta', 'ctaCarrito']) assert(TEXTOS_TIENDA[k].length <= 30);
  // El mensaje no promete fotos: un platillo sin foto va sin imagen y en Obispado son la mayoría (10 de 76 con foto, 3-oct).
  for (const k of ['cuerpo', 'cuerpoCarrito']) assert.doesNotMatch(TEXTOS_TIENDA[k], /foto/i, k);
});
await t('el recibo de la tienda es el de «Tu carrito»: mismas filas, mismo resumen comercial y el mismo carrito aplicado', async () => {
  await F.conEntornoFlows(async () => {
    const [, accion, mk] = escenario('tu carrito (agregar otro)');
    const foto = fotoFormulario(ctxDe(F.cfgTienda(), mk()), accion), carrito = fotoFormulario(ctxDe(F.cfgHoy, mk()), accion);
    assert.equal(foto.version, VERSION_TIENDA); assert.equal(carrito.version, 'carrito_v1');
    assert.deepEqual(foto.lineas, carrito.lineas); assert.deepEqual(foto.productos, carrito.productos);
    // Agrega unos chilaquiles, edita el café a 3, quita los chilaquiles de la foto, continúa a domicilio con dirección y nota.
    let b = borradorTienda(foto);
    const paso = (screen, data) => { const r = cambiarTienda(foto, b, { action: 'data_exchange', screen, data }); assert.equal(r.error, undefined, `${screen} ${r.error}`); b = r.borrador; };
    paso('CATEGORIA', { operacion: 'ver', producto: 'p0' });
    paso('PERSONALIZAR', { operacion: 'agregar', apertura: b.vista.apertura, producto: 'p0', cantidad: '1', observaciones: '', g0_r: 'o2', g1_r: 'o0' });
    paso('EDITAR', { operacion: 'aplicar', revision: String(b.revision), fila: 'e1', cantidad: '3', observaciones: 'Sin azúcar' });
    paso('EDITAR', { operacion: 'quitar', revision: String(b.revision), fila: 'e0' });
    paso('CARRITO', { operacion: 'continuar', revision: String(b.revision) });
    paso('ENTREGA', { operacion: 'revisar', revision: String(b.revision), modalidad: 'm1', pago: 'p0', nota: 'Tocar el timbre' });
    paso('DIRECCION', { operacion: 'direccion', revision: String(b.revision), zona: 'z0', calle: 'Edificio 3', colonia: '', referencias: 'Caseta' });
    assert.equal(b.etapa, 'FINAL');
    // resolverFinalFlow: el cliente solo devuelve {flow_token, revision}; lo demás sale del borrador.
    const tx = { query: async () => ({ rows: [{ contenido: b }] }) };
    const recibo = await resolverFinalFlow(tx, { id: 'q', datos: foto }, { flow_token: 'tk', revision: String(b.revision) });
    assert.deepEqual(Object.keys(recibo).sort(), ['direccion', 'filas', 'flow_token', 'modalidad', 'nota', 'pago']);
    assert.equal(await resolverFinalFlow(tx, { id: 'q', datos: foto }, { flow_token: 'tk', revision: String(b.revision), filas: [] }), null);
    assert.equal(await resolverFinalFlow(tx, { id: 'q', datos: foto }, { flow_token: 'tk', revision: '0' }), null);
    const ct = comandosFormulario(foto, recibo), cc = comandosFormulario(carrito, recibo);
    assert(ct, 'la tienda acepta su recibo'); assert.deepEqual(ct, cc);
    const ctxT = ctxDe(F.cfgTienda(), mk()), ctxC = ctxDe(F.cfgHoy, mk());
    ctxT.estado.eleccionInteractiva = { id: 'abierta' };
    assert.equal((await aplicarFormulario({ accion, datos: foto, respuestaFlow: recibo }, ctxT)).ok, true);
    assert.equal((await aplicarFormulario({ accion, datos: carrito, respuestaFlow: recibo }, ctxC)).ok, true);
    // Iguales salvo el lid de los renglones nuevos (cada aplicar genera el suyo).
    const normal = (c) => ({ ...c, items: c.items.map((i) => ({ ...i, lid: ['L1', 'L2'].includes(i.lid) ? i.lid : 'nuevo' })) });
    assert.deepEqual(normal(ctxT.estado.carrito), normal(ctxC.estado.carrito));
    assert.equal(ctxT.estado.eleccionInteractiva, undefined, 'cierra la elección abierta, como «Tu carrito»');
    assert.deepEqual(ctxT.estado.carrito.items.map((i) => [i.nombre, i.cantidad]), [['Café americano', 3], ['Chilaquiles', 1]]);
    assert.equal(ctxT.estado.carrito.datos.cliente.direccion, 'Edificio 3, UTNC');
    // La vista del formulario enviado y de su respuesta (panel) lee las filas.
    assert.deepEqual(vistaRespuestaFormulario(foto, b).lineas.map((l) => [l.nombre, l.cantidad]), [['Café americano', 3], ['Chilaquiles', 1]]);
    // «Arma tu pedido» (flow_productos) también cierra la elección.
    const [, accionP, mkP] = escenario('arma tu pedido, vacío'), fotoP = fotoFormulario(ctxDe(F.cfgTienda(), mkP()), accionP), ctxP = ctxDe(F.cfgTienda(), mkP());
    ctxP.estado.eleccionInteractiva = { id: 'abierta' };
    const bP = cambiarTienda(fotoP, borradorTienda(fotoP), { action: 'data_exchange', screen: 'PERSONALIZAR',
      data: { operacion: 'agregar', apertura: 'r0.p2', producto: 'p2', cantidad: '2', observaciones: '' } }).borrador;
    const reciboP = { flow_token: 'tk', filas: bP.filas, modalidad: 'm0', pago: 'p0' };
    assert.equal((await aplicarFormulario({ accion: accionP, datos: fotoP, respuestaFlow: reciboP }, ctxP)).ok, true);
    assert.equal(ctxP.estado.eleccionInteractiva, undefined);
    assert.deepEqual(ctxP.estado.carrito.items.map((i) => [i.nombre, i.cantidad]), [['Café americano', 2]]);
  });
});
await t('flowId esperado y transporte: la tienda espera su propio flowId solo configurada; el transporte la deja salir', () => {
  const tienda = { version: VERSION_TIENDA, contrato: 'direccion_v1', contrato_nota: 'nota_v1' };
  for (const modo of ['true', 'prueba']) {
    assert.equal(flowIdEsperadoFormulario(F.cfgTienda(modo), tienda), F.IDS.tienda, modo);
    assert.deepEqual(flowIdsConEndpointFormularios(F.cfgTienda(modo)), [...flowIdsConEndpointConNota(F.cfgTienda(modo)), F.IDS.tienda]);
  }
  assert.equal(flowIdTienda(F.cfgTienda('true', { whatsapp_flow_nota_v1: 'false' })), null, 'sin la nota no hay tienda');
  // Sin «Arma tu pedido» por categorías (su catálogo) tampoco: ni flowId esperado ni en el transporte.
  const sinCategorias = F.cfgTienda('true', { whatsapp_flow_categorias_id: '', whatsapp_flow_repetible_id: '33333333333' });
  assert.equal(tiendaConfigurada(sinCategorias), false);
  assert.deepEqual(flowIdsConEndpointFormularios(sinCategorias), flowIdsConEndpointConNota(sinCategorias));
  // Los de hoy, igual con la tienda encendida.
  const carrito = { version: 'carrito_v1', contrato: 'direccion_v1', contrato_nota: 'nota_v1' };
  assert.equal(flowIdEsperadoFormulario(F.cfgTienda(), carrito), F.IDS.carritoNota);
  for (const k of CLAVES_FLOW_PEDIDO) assert.equal(tiendaConfigurada(F.cfgTienda('true', { whatsapp_flow_tienda_id: F.cfgHoy[k] || F.IDS.tienda, [k]: F.cfgHoy[k] || F.IDS.tienda })), false, k);
});
await t('barrera sinTiendaVieja: corta una tienda que ya no es para el cliente y un carrito o «Arma tu pedido» abierto antes de encenderla; no el que la tienda no admitió', () => {
  const tienda = { version: VERSION_TIENDA }, carrito = { version: 'carrito_v1' }, categorias = { version: 'repetible_v1', presentacion: 'categorias_v1' };
  assert.equal(sinTiendaVieja(F.cfgTienda(), tienda, F.TELEFONO), false);
  assert.equal(sinTiendaVieja(F.cfgTienda('prueba'), tienda, F.TELEFONO), false);
  assert.equal(sinTiendaVieja(F.cfgTienda('prueba'), tienda, F.OTRO_TELEFONO), true, 'su teléfono salió de la lista');
  assert.equal(sinTiendaVieja(F.cfgHoy, tienda, F.TELEFONO), true, 'revertida');
  for (const d of [carrito, categorias]) {
    assert.equal(sinTiendaVieja(F.cfgTienda(), d, F.TELEFONO), true, `${d.version}: abierto antes de encenderla`);
    assert.equal(sinTiendaVieja(F.cfgTienda(), { ...d, sin_tienda: 'renglones' }, F.TELEFONO), false, `${d.version}: la tienda no lo admitió`);
    assert.equal(sinTiendaVieja(F.cfgTienda('prueba'), d, F.OTRO_TELEFONO), false, `${d.version}: cliente fuera de la prueba`);
  }
  for (const d of [{ version: 'repetible_v1' }, { version: 'edicion_v1' }, { version: 'continuo_v1' }, {}]) assert.equal(sinTiendaVieja(F.cfgTienda(), d, F.TELEFONO), false, json(d));
});
await t('retomar: un borrador de la tienda se busca por las dos acciones (misma versión, misma foto)', async () => {
  const consultas = [], db = { query: async (sql, args) => { consultas.push(args); return { rows: [{ datos: { version: VERSION_TIENDA, a: 1 }, contenido: { etapa: 'TIENDA' } }] }; } };
  for (const accion of ['flow_productos', 'flow_configurar']) {
    const r = await borradorCompatible(db, { preparado: { ciclo: 'c', preguntaId: 'p', huella: 'h', botones: [{ accion, datos: { version: VERSION_TIENDA, a: 1 } }] }, negocioId: 'n', sessionId: 's' });
    assert.deepEqual(r?.contenido, { etapa: 'TIENDA' }, accion);
    assert.equal(consultas.at(-1)[5], VERSION_TIENDA);
  }
  const distinta = await borradorCompatible(db, { preparado: { ciclo: 'c', preguntaId: 'p', huella: 'h', botones: [{ accion: 'flow_productos', datos: { version: VERSION_TIENDA, a: 2 } }] }, negocioId: 'n', sessionId: 's' });
  assert.equal(distinta, null, 'otra foto no se retoma');
});

// ── Activación, publicación y migración ──────────────────────────────────
await t('activación: prueba con teléfonos, después todos sobre el mismo Flow; reversa a lo de antes; se niega sin nota, con flowId ajeno o claves a mano', () => {
  const cfg = { ...F.cfgHoy };
  const prueba = planActivacionTienda(cfg, F.IDS.tienda, { modo: 'prueba', telefonos: '52 878 123 4567, 5218780000000' });
  assert.equal(prueba.error, undefined, prueba.error);
  assert.deepEqual(prueba.cambios, { whatsapp_flow_tienda_id: F.IDS.tienda, whatsapp_flow_tienda_v1: 'prueba', whatsapp_flow_tienda_telefonos: '528781234567,5218780000000' });
  assert.deepEqual(prueba.flows, [[F.IDS.tienda, 'tienda']]);
  assert.deepEqual(prueba.respaldo.antes, { whatsapp_flow_tienda_id: null, whatsapp_flow_tienda_v1: null, whatsapp_flow_tienda_telefonos: null });
  const activa = { ...cfg, ...prueba.cambios, [CLAVE_RESPALDO_TIENDA]: JSON.stringify(prueba.respaldo) };
  assert.equal(tiendaParaTelefono(activa, '528781234567'), true); assert.equal(tiendaParaTelefono(activa, '5215550000000'), false);
  const todos = planActivacionTienda(activa, F.IDS.tienda, { modo: 'true' });
  assert.equal(todos.error, undefined, todos.error);
  assert.deepEqual(todos.respaldo.antes, prueba.respaldo.antes, 'conserva el antes original');
  assert.equal(todos.cambios.whatsapp_flow_tienda_telefonos, null);
  const aplicada = { ...activa, ...Object.fromEntries(Object.entries(todos.cambios).filter(([, v]) => v !== null)), [CLAVE_RESPALDO_TIENDA]: JSON.stringify(todos.respaldo) };
  delete aplicada.whatsapp_flow_tienda_telefonos;
  assert.deepEqual(planReversaTienda(aplicada).aplicar, { whatsapp_flow_tienda_id: null, whatsapp_flow_tienda_v1: null, whatsapp_flow_tienda_telefonos: null });
  assert.match(planReversaTienda({ ...aplicada, whatsapp_flow_tienda_v1: 'prueba' }).error, /cambió después/);
  assert.match(planReversaTienda(cfg).error, /Sin respaldo/);
  assert.match(planActivacionTienda(aplicada, '15151515151', { modo: 'true' }).error, /otro flowId/);
  assert.match(planActivacionTienda({ ...aplicada, whatsapp_flow_tienda_v1: 'false' }, F.IDS.tienda, { modo: 'true' }).error, /cambió después/);
  assert.match(planActivacionTienda({ ...cfg, whatsapp_flow_nota_v1: 'false' }, F.IDS.tienda, { modo: 'true' }).error, /dirección y la nota/);
  assert.match(planActivacionTienda({ ...cfg, whatsapp_flow_categorias_id: '' }, F.IDS.tienda, { modo: 'true' }).error, /categorías/);
  assert.match(planActivacionTienda(cfg, F.IDS.carritoNota, { modo: 'true' }).error, /otro formulario/);
  assert.match(planActivacionTienda(cfg, F.IDS.tienda, { modo: 'prueba', telefonos: '123' }).error, /teléfonos/);
  assert.match(planActivacionTienda(cfg, F.IDS.tienda, { modo: 'sí' }).error, /alcance/);
  assert.match(planActivacionTienda(cfg, 'abc', { modo: 'true' }).error, /flowId/);
  assert.match(planActivacionTienda({ ...cfg, whatsapp_flow_tienda_v1: 'true' }, F.IDS.tienda, { modo: 'true' }).error, /a mano/);
  assert.deepEqual(telefonosDePrueba('5218781234567;5218781234567'), ['5218781234567']);
});
await t('publicar: el alcance «tienda» es la definición de la tienda de este build, con endpoint y su nombre por huella; los demás alcances, sin cambio', () => {
  const [[tipo, def]] = flowsDelAlcance('tienda');
  assert.equal(tipo, 'tienda'); assert.deepEqual(def, definicionFlowTienda());
  assert.equal(nombreDelFlow(tipo, def).name, nombreFlowTienda(def));
  assert(TIPOS_CON_ENDPOINT.includes('tienda') && ALCANCES_FLOWS.includes('tienda'));
  assert.deepEqual(flowsDelAlcance('carrito-direccion-nota-beta'), [['carrito', definicionFlowCarrito({ duplicar: true, direccion: true, nota: true })]]);
  assert.deepEqual(flowsDelAlcance('categorias-direccion-nota'), [['categorias', definicionFlowCategorias({ direccion: true, nota: true })]]);
  assert.deepEqual(flowsDelAlcance(undefined).map(([k]) => k), ['productos', 'configurar']);
  assert.throws(() => flowsDelAlcance('tiendas'), /Alcance inválido/);
  const fuente = readFileSync(new URL('./publicar-flows-pedido.mjs', import.meta.url), 'utf8');
  assert.match(fuente, /flowsDelAlcance\(alcance\)/); assert.match(fuente, /TIPOS_CON_ENDPOINT\.includes\(tipo\)\?\{endpoint_uri:endpoint\}/);
});
await t('migración 114: amplía los pasos (TIENDA, DIRECCION) sin quitar ninguno, con su reversa, su predeploy y su lugar en SCRIPTS', () => {
  const leer = (r) => readFileSync(new URL(r, import.meta.url), 'utf8');
  const sql = leer('../migrations/114_actividad_formulario_tienda.sql'), down = leer('../migrations/114_actividad_formulario_tienda_down.sql');
  const pasos = (s) => [...s.matchAll(/CHECK \(paso IN \(([^)]*)\)\)/g)].at(-1)[1].split(',').map((x) => x.trim().replaceAll("'", ''));
  assert.deepEqual(pasos(sql), ['MENU', 'PLATILLO', 'TACOS', 'ENTREGA', 'CARRITO', 'EDITAR', 'FINAL', 'TIENDA', 'DIRECCION']);
  assert.deepEqual(pasos(down), ['MENU', 'PLATILLO', 'TACOS', 'ENTREGA', 'CARRITO', 'EDITAR', 'FINAL']);
  assert.match(sql, /DROP CONSTRAINT IF EXISTS agente_actividad_formulario_paso_check/);
  assert.doesNotMatch(sql, /\b(UPDATE|DELETE|INSERT|DROP TABLE|DROP COLUMN)\b/);
  assert(existsSync(new URL('./predeploy-114-actividad-formulario-tienda.mjs', import.meta.url)));
  assert.equal(problemaDe114EnScripts(leer('./predeploy-run-032-033.mjs')), null);
});
await t('SCRIPTS se lee por sus entradas: una migración nueva al final no rompe el chequeo de la 114, una comentada no cuenta', () => {
  const base = "const SCRIPTS = [\n  '110-agente-actividad-formulario',\n  // comentario\n  '114-actividad-formulario-tienda',\n];\n";
  assert.deepEqual(entradasDeScripts(base), ['110-agente-actividad-formulario', '114-actividad-formulario-tienda']);
  assert.deepEqual(entradasDeScripts(base.replace("];", "  '115-otra-cosa',\n];")).slice(-2), ['114-actividad-formulario-tienda', '115-otra-cosa']);
  assert.deepEqual(entradasDeScripts(base.replace("  '114", "  // '114")), ['110-agente-actividad-formulario']);
  assert.deepEqual(entradasDeScripts(base.replace("  '114", "  /* '114-actividad-formulario-tienda', */ '113-otra',\n  '114")),
    ['110-agente-actividad-formulario', '113-otra', '114-actividad-formulario-tienda']);
  // El veredicto sobre la 114: con otras migraciones antes o después, bien; fuera, comentada o antes de la 110, no.
  const sin110 = base.replace("  '110-agente-actividad-formulario',\n", '');
  assert.equal(problemaDe114EnScripts(base), null);
  assert.equal(problemaDe114EnScripts(base.replace('];', "  '115-otra-cosa',\n  '116-otra-mas',\n];")), null);
  assert.equal(problemaDe114EnScripts(base.replace('  // comentario', "  '113-conversaciones-pausa-vencimientos',")), null);
  assert.match(problemaDe114EnScripts(base.replace("  '114", "  // '114")), /no está en SCRIPTS/);
  assert.match(problemaDe114EnScripts(sin110.replace('];', "  '110-agente-actividad-formulario',\n];")), /después de la 110/);
  assert.match(problemaDe114EnScripts(sin110), /después de la 110/);
});
await t('valores por omisión (preguntas sin respuesta del dueño): reemplaza los dos formularios, conserva «Varios tacos a la vez», vigencia de 30 min', () => {
  assert.deepEqual({ ...POR_OMISION_TIENDA }, { reemplazaArmaTuPedido: true, reemplazaTuCarrito: true, variosTacos: true, vigenciaMinutos: 30 });
  assert.match(readFileSync(new URL('../src/mesero-agente/flowRepetibleSql.js', import.meta.url), 'utf8'), /interval '30 minutes' AS vigente/);
});

console.log(`plomería de la tienda: ${pasadas} OK, ${fallidas} fallos`);
assert.equal(fallidas, 0);
