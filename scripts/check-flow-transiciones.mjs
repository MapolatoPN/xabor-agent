// La regla del teléfono para «Tu carrito» (carrito_v1) y «Arma tu pedido»
// (categorias_v1), con la pila del teléfono simulada. Corre en el predeploy.
//
// [M] 4-oct (aviso del propio teléfono y telemetría del 1 al 4-oct): la
// respuesta de un data_exchange solo puede ser la misma pantalla, una arista
// del routing_model o la pantalla de la que sale una arista hacia la actual
// (la de antes); un salto entre pantallas no vecinas da «Se produjo un error»
// («invalid-screen-transition … doesn't satisfy provided routing_model»)
// aunque el servidor ya haya guardado el cambio. Así fallaba «Agregar al
// carrito» (PLATILLO → CARRITO), 3 de 3 veces con clientes reales. El INIT
// solo abre en la primera pantalla (una raíz): uno que abrió en ENTREGA dio
// aviso. El Atrás de una pantalla con refresh_on_back responde la de abajo.
//
// Recorre cada pantalla y cada botón de cada formulario (también con la
// variante de Acuña, sin nota) y, después de CADA paso, reabre el formulario:
// la apertura debe ser la raíz. Pura: sin base de datos, Meta ni red.
import assert from 'node:assert/strict';
import { definicionFlowCarrito } from './definicion-flow-carrito.mjs';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import * as F from './fixture-tienda-plomeria.mjs';
import { fotoFormulario } from '../src/mesero-agente/formularioAgrupado.js';
import { borradorCarrito, cambiarCarrito, respuestaCarrito } from '../src/mesero-agente/flowCarrito.js';
import { borradorCategorias, cambiarCategorias, respuestaCategorias } from '../src/mesero-agente/flowCategorias.js';

let ok = 0, fallos = 0;
const t = (nombre, fn) => { try { fn(); ok++; console.log(`OK transiciones: ${nombre}`); } catch (e) { fallos++; console.error(`FALLA transiciones: ${nombre}: ${e.message}`); } };

// Acuña: dirección sin nota. Obispado: dirección y nota.
const { whatsapp_flow_nota_v1, whatsapp_flow_categorias_nota_id, whatsapp_flow_carrito_nota_id, ...cfgAcuna } = F.cfgHoy;
const VARIANTES = [['Obispado (dirección y nota)', F.cfgHoy], ['Acuña (dirección)', cfgAcuna]];
const foto = (cfg, nombre) => {
  const [, accion, mk] = F.ESCENARIOS.find(([n]) => n === nombre);
  return F.conEntornoFlowsSinc(() => fotoFormulario({ estado: mk(), catalogo: F.carta(), modalidades: F.modalidades, metodosPago: F.metodosPago,
    reglas: F.reglas, cfg, telefono: F.TELEFONO }, accion));
};

/**
 * El teléfono: lleva la pila y anota cada respuesta que rompe la regla. Cada
 * paso pasa por el servidor como el adaptador SQL (guarda solo si cambió la
 * revisión) y, antes de seguir, reabre el formulario en una copia.
 */
function telefono(nombre, def, f, b0, cambiar, responder) {
  const rutas = def.routing_model, rob = Object.fromEntries(def.screens.map((s) => [s.id, s.refresh_on_back === true]));
  const raices = def.screens.map((s) => s.id).filter((id) => !Object.values(rutas).some((v) => v.includes(id)));
  const pila = [], saltos = [];
  // Un salto prohibido falla en el acto, con la transición exacta.
  const saltar = (m) => { saltos.push(m); throw new Error(`salto que el teléfono rechaza: ${m}`); };
  let b = b0, ultima = null;
  const servidor = (sol) => {
    const r = cambiar(f, b, sol), resp = responder(f, r.borrador, 'tk', r.error || '', sol.data ?? null);
    if (r.borrador.revision !== b.revision) b = r.borrador;
    return { r, resp };
  };
  const reabrir = (donde) => {
    const r = cambiar(f, b, { action: 'INIT' }), x = responder(f, r.borrador, 'tk', r.error || '', null).screen;
    if (!raices.includes(x) && !(x === 'SUCCESS' && b.etapa === 'FINAL')) saltar(`${nombre} · reabrir tras ${donde}: (apertura) → ${x}`);
  };
  const tel = {
    pila, saltos, get b() { return b; }, get ultima() { return ultima; },
    init() {
      const { resp } = servidor({ action: 'INIT' });
      if (!raices.includes(resp.screen)) saltar(`${nombre} · INIT: (apertura) → ${resp.screen}`);
      pila.length = 0; pila.push(resp.screen); ultima = resp; return resp.screen;
    },
    dx(data, { error = null } = {}) {
      const tope = pila.at(-1), { r, resp } = servidor({ action: 'data_exchange', screen: tope, data: { revision: String(b.revision), ...data } });
      if (error) assert.match(r.error || '', error, `${nombre} · ${tope}/${data.operacion}`);
      else assert.equal(r.error, undefined, `${nombre} · ${tope}/${data.operacion}: ${r.error}`);
      const x = resp.screen;
      if (x === 'SUCCESS') pila.length = 0;
      else if (x === tope) { /* misma pantalla */ }
      else if (rutas[tope]?.includes(x)) pila.push(x);
      else if (rutas[x]?.includes(tope)) { const i = pila.lastIndexOf(x); if (i >= 0) pila.length = i + 1; else pila.push(x); }
      else { saltar(`${nombre} · ${tope}/${data.operacion}: ${tope} → ${x}`); pila.push(x); }
      ultima = resp; if (x !== 'SUCCESS') reabrir(`${tope}/${data.operacion}`); return x;
    },
    atras() {
      const deja = pila.pop();
      if (!rob[deja]) return pila.at(-1);
      const { resp } = servidor({ action: 'BACK', screen: deja });
      if (resp.screen !== pila.at(-1)) saltar(`${nombre} · Atrás desde ${deja}: ${pila.at(-1)} → ${resp.screen}`);
      ultima = resp; reabrir(`Atrás desde ${deja}`); return resp.screen;
    },
  };
  return tel;
}
const id = (lista, titulo) => lista.find((c) => c.title === titulo)?.id;
const chilaquiles = (p) => ({ producto0: p, cantidad: '1', observaciones: '', g0_s: `${p}g0o0`, g1_s: `${p}g1o0` });

for (const [variante, cfg] of VARIANTES) {
  t(`«Tu carrito» ${variante}: agregar platillo, tacos y «Guardar y ver categorías» regresan al menú; toda reapertura es el carrito`, () => {
    const f = foto(cfg, 'tu carrito (agregar otro)');
    assert.equal(f.version, 'carrito_v1');
    const def = definicionFlowCarrito({ direccion: f.contrato === 'direccion_v1', nota: f.contrato_nota === 'nota_v1', duplicar: !!f.duplicar });
    const m = telefono(`carrito ${variante}`, def, f, borradorCarrito(f), cambiarCarrito, respuestaCarrito);
    assert.equal(m.init(), 'CARRITO');
    assert.equal(m.dx({ operacion: 'agregar' }), 'MENU');
    assert.equal(m.dx({ operacion: 'categoria', categoria: id(m.ultima.data.categorias, 'Desayunos') }), 'PLATILLO');
    const p = id(m.ultima.data.productos0, 'Chilaquiles');
    // «Agregar al carrito»: al MENU (la de antes), con el aviso y el resumen del carrito.
    assert.equal(m.dx({ operacion: 'terminar', ...chilaquiles(p) }), 'MENU');
    assert.match(m.ultima.data.error, /^Listo: agregamos 1 × Chilaquiles\.$/); assert.equal(m.ultima.data.error_visible, true);
    assert.match(m.ultima.data.resumen, /^Tu carrito: 4 piezas\. Toca «Ver carrito» o elige una categoría\.$/);
    // «Agregar más» desde el platillo, también al MENU.
    assert.equal(m.dx({ operacion: 'categoria', categoria: id(m.ultima.data.categorias, 'Desayunos') }), 'PLATILLO');
    assert.equal(m.dx({ operacion: 'agregar', ...chilaquiles(p) }), 'MENU');
    // Tacos: «Agregar más» y «Agregar al carrito», al MENU.
    assert.equal(m.dx({ operacion: 'categoria', categoria: id(m.ultima.data.categorias, 'Tacos') }), 'TACOS');
    assert.equal(m.dx({ operacion: 'agregar', tortilla: 'maiz', t0_q: '2', t1_q: '0' }), 'MENU');
    assert.equal(m.dx({ operacion: 'categoria', categoria: id(m.ultima.data.categorias, 'Tacos') }), 'TACOS');
    assert.equal(m.dx({ operacion: 'terminar', tortilla: 'harina', t0_q: '0', t1_q: '1' }), 'MENU');
    assert.match(m.ultima.data.error, /^Listo: agregamos 1 × Taco de Pastor\.$/);
    // «Guardar y ver categorías» con un platillo: al MENU con el aviso.
    assert.equal(m.dx({ operacion: 'categoria', categoria: id(m.ultima.data.categorias, 'Desayunos') }), 'PLATILLO');
    assert.equal(m.dx({ operacion: 'categorias', ...chilaquiles(p) }), 'MENU');
    assert.match(m.ultima.data.error, /^Listo: agregamos 1 × Chilaquiles\.$/);
    // Atrás desde el MENU: el carrito (la de abajo). El aviso no se repite.
    assert.equal(m.atras(), 'CARRITO');
    assert.equal(m.dx({ operacion: 'agregar' }), 'MENU'); assert.equal(m.ultima.data.error_visible, false);
    assert.equal(m.dx({ operacion: 'terminar' }), 'CARRITO');
    assert.equal(m.b.filas.length, 7, 'dos de la foto, dos chilaquiles, dos tacos y el de «Guardar y ver categorías»');
    // Edición, entrega, dirección y cierre.
    assert.equal(m.dx({ operacion: 'editar', editar: m.b.filas[0].key }), 'EDITAR');
    assert.equal(m.atras(), 'CARRITO');
    assert.equal(m.dx({ operacion: 'guardar' }), 'ENTREGA');
    assert.equal(m.atras(), 'CARRITO');
    assert.equal(m.dx({ operacion: 'guardar' }), 'ENTREGA');
    const nota = f.contrato_nota === 'nota_v1' ? { nota: '' } : {};
    assert.equal(m.dx({ operacion: 'revisar', modalidad: 'm1', pago: 'p0', ...nota }), 'DIRECCION');
    assert.equal(m.atras(), 'ENTREGA');
    assert.equal(m.dx({ operacion: 'revisar', modalidad: 'm1', pago: 'p0', ...nota }), 'DIRECCION');
    assert.equal(m.dx({ operacion: 'direccion', zona: 'z0', calle: 'Edificio 3', colonia: '', referencias: 'Caseta' }), 'SUCCESS');
    assert.deepEqual(m.saltos, []);
  });
  t(`«Arma tu pedido» ${variante}: platillos, tacos, categorías, entrega y dirección; toda reapertura es el menú`, () => {
    const f = foto(cfg, 'arma tu pedido con platillos');
    assert.equal(f.presentacion, 'categorias_v1');
    const def = definicionFlowCategorias({ direccion: f.contrato === 'direccion_v1', nota: f.contrato_nota === 'nota_v1' });
    const m = telefono(`categorías ${variante}`, def, f, borradorCategorias(), cambiarCategorias, respuestaCategorias);
    assert.equal(m.init(), 'MENU');
    assert.equal(m.dx({ operacion: 'categoria', categoria: id(m.ultima.data.categorias, 'Desayunos') }), 'PLATILLO');
    const p = id(m.ultima.data.productos0, 'Chilaquiles');
    assert.equal(m.dx({ operacion: 'agregar', ...chilaquiles(p) }), 'PLATILLO');
    assert.equal(m.dx({ operacion: 'categorias' }), 'MENU');
    assert.match(m.ultima.data.resumen, /^1 artículo en tu pedido\. Para seguir, toca ORDEN COMPLETA\.$/);
    assert.equal(m.dx({ operacion: 'categoria', categoria: id(m.ultima.data.categorias, 'Tacos') }), 'TACOS');
    assert.equal(m.dx({ operacion: 'agregar', tortilla: 'maiz', t0_q: '2', t1_q: '0' }), 'TACOS');
    assert.equal(m.atras(), 'MENU');
    assert.equal(m.dx({ operacion: 'categoria', categoria: id(m.ultima.data.categorias, 'Desayunos') }), 'PLATILLO');
    assert.equal(m.dx({ operacion: 'terminar', ...chilaquiles(p) }), 'ENTREGA');
    assert.equal(m.atras(), 'PLATILLO');
    assert.equal(m.dx({ operacion: 'terminar' }), 'ENTREGA');
    const nota = f.contrato_nota === 'nota_v1' ? { nota: '' } : {};
    assert.equal(m.dx({ operacion: 'revisar', modalidad: 'm1', pago: 'p0', ...nota }), 'DIRECCION');
    assert.equal(m.atras(), 'ENTREGA');
    assert.equal(m.dx({ operacion: 'revisar', modalidad: 'm1', pago: 'p0', ...nota }), 'DIRECCION');
    assert.equal(m.dx({ operacion: 'direccion', zona: 'z0', calle: 'Edificio 3', colonia: '', referencias: 'Caseta' }), 'SUCCESS');
    assert.deepEqual(m.saltos, []);
  });
}
t('reabrir a medias conserva lo elegido: «Tu carrito» vuelve al carrito con sus filas; «Arma tu pedido» al menú con platillos, entrega y pago', () => {
  const fc = foto(F.cfgHoy, 'tu carrito (agregar otro)');
  let b = borradorCarrito(fc);
  b = cambiarCarrito(fc, b, { action: 'data_exchange', screen: 'CARRITO', data: { revision: '0', operacion: 'agregar' } }).borrador;
  const r = cambiarCarrito(fc, b, { action: 'INIT' }).borrador;
  assert.deepEqual([r.etapa, r.revision, r.compra, r.filas], ['CARRITO', b.revision + 1, undefined, b.filas]);
  assert.deepEqual(cambiarCarrito(fc, r, { action: 'INIT' }).borrador, r, 'en el carrito, la apertura no escribe');
  const fk = foto(F.cfgHoy, 'arma tu pedido con platillos');
  const en = { ...borradorCategorias(), revision: 6, etapa: 'DIRECCION', items: [{ producto0: 'p2', cantidad: '1' }], modalidad: 'm1', pago: 'p0', navegacion: ['MENU', 'PLATILLO'] };
  const k = cambiarCategorias(fk, en, { action: 'INIT' }).borrador;
  assert.deepEqual([k.etapa, k.revision, k.navegacion, k.items, k.modalidad, k.pago], ['MENU', 7, [], en.items, 'm1', 'p0']);
});

console.log(`transiciones de los formularios: ${ok} OK, ${fallos} fallos`);
if (fallos) process.exit(1);
