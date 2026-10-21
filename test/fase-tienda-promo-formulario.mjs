// La promoción dentro del formulario «tienda» (tienda_v1), antes de enviarlo.
// Pura: sin base de datos, Meta ni red (el motor se sustituye por un doble).
//
// Incidente 21-oct-2026 (Mapolato Acuña): con «Miércoles de Chilaquiles» (2x1)
// vigente, una clienta armó dos chilaquiles que sí participaban, vio
// «Continuar · $450» y escribió «cuando voy a pagar no se me aplica la
// promoción del día». El motor la aplicaba en el resumen del chat; el
// formulario solo dibujaba el subtotal.
//
// Garantías que prueba:
//   dibujo      con la promoción del servidor, el carrito, la barra, los tacos
//               y «Entrega y pago» muestran el descuento y el total con él;
//               cada respuesta conserva la forma que el Flow publicado declara
//   igual       sin promoción (null, descuento 0, o de OTRO subtotal) el
//               formulario es byte a byte el de antes
//   avisos      por qué no aplicó y cuánto falta, en el pie del carrito
//   motor       promoDelBorrador arma la orden con los ids y nombres de la
//               foto, pregunta a previsualizarPedido por canal whatsapp y
//               traduce su respuesta; sin entrega elegida usa la MENOR
//   seguro      error, rechazo o demora → null (se dibuja lo de antes); un
//               fallo no se recuerda; lo bueno se recuerda un minuto
//   interruptor whatsapp_flow_tienda_promos_v1='false' lo apaga
import assert from 'node:assert/strict';
import { borradorTienda, cambiarTienda, respuestaTienda, pedidoDelBorrador, pedidoConPromo, dibujaTotales } from '../src/mesero-agente/flowTienda.js';
import { LIMITES_TIENDA } from '../src/mesero-agente/catalogoFlowTienda.js';
import { promoDelBorrador, ordenDelBorrador, entregasPosibles, pagoParaVista, promosEnFormularioActivas, olvidarPromosDelFormulario }
  from '../src/mesero-agente/promoDelFormulario.js';
import { fotoTienda, vitrinaFalsa, exigirForma, dx, RANURAS_VACIAS } from './lib-fixtures-tienda.mjs';

let pasadas = 0, fallidas = 0;
const t = async (nombre, fn) => {
  try { await fn(); pasadas++; console.log(`  ok  ${nombre}`); } catch (e) { fallidas++; console.log(`FALLA ${nombre}: ${e.message}`); }
};

// Un pedido nuevo (sin líneas previas) como el del incidente: dos chilaquiles
// que participan (Roja y Verde), sin entrega elegida todavía.
const VERDE = { g0_r: 'o1', g1_s: 'o2', g2_m: ['o0'], cantidad: '1', observaciones: '' };
const ROJA = { g0_r: 'o0', g1_s: 'o2', g2_m: ['o0', 'o1'], cantidad: '1', observaciones: '' };
function sesionIncidente() {
  const foto = fotoTienda({ lineas: [] }), vitrina = vitrinaFalsa().vitrina;
  let b = borradorTienda(foto);
  const paso = (sol) => { const r = cambiarTienda(foto, b, sol); assert.equal(r.error, undefined, r.error); b = r.borrador; return r; };
  for (const eleccion of [VERDE, ROJA]) {
    const v = cambiarTienda(foto, b, dx('CATEGORIA', { operacion: 'ver', producto: 'p0' })).borrador.vista;
    paso(dx('PERSONALIZAR', { operacion: 'agregar', apertura: v.apertura, producto: 'p0', ...RANURAS_VACIAS, ...eleccion }));
  }
  return { foto, vitrina, b: () => b, paso };
}
// La promoción como la devolvería el servidor para 2 × $145: 2x1, el de menor precio gratis.
const promo2x1 = (subtotalCentavos = 29000) => ({ subtotalCentavos, descuentoCentavos: 14500,
  promociones: [{ nombre: 'Miércoles de Chilaquiles', descuentoCentavos: 14500 }], avisos: [] });

// ── Dibujo ──────────────────────────────────────────────────────────────
await t('el borrador del incidente: 2 chilaquiles, $290, sin entrega elegida (la promo se calcula con todas)', () => {
  const s = sesionIncidente(), p = pedidoDelBorrador(s.foto, s.b());
  assert.deepEqual([p.unidades, p.subtotalCentavos], [2, 29000]);
  assert.deepEqual(entregasPosibles(s.foto, s.b()), ['recoger en tienda', 'entrega a domicilio']);
});

await t('CARRITO con la promoción: resumen, pie y botón dicen el descuento y el total con él; la forma es la del Flow', () => {
  const s = sesionIncidente();
  const antes = respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina);
  s.paso(dx('CATEGORIA', { operacion: 'ver_carrito' }));
  const r = respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina, promo2x1());
  exigirForma(r, 'CARRITO con promo');
  assert.equal(r.screen, 'CARRITO');
  assert.equal(r.data.resumen, 'Tu pedido: 2 platillos · $145 con promoción');
  assert.equal(r.data.boton, 'Continuar · $145');
  assert.match(r.data.importe, /^Productos: \$290\.00\. Promoción Miércoles de Chilaquiles: -\$145\.00\. Total con promoción: \$145\.00; el envío se suma al revisar\./);
  assert(r.data.importe.length <= LIMITES_TIENDA.texto.TextCaption);
  // Lo que la promoción no toca: renglones y precio de cada uno.
  assert.deepEqual(r.data.filas.map((f) => f.metadata), ['$145', '$145']);
  assert.equal(antes.screen, 'CATEGORIA');
});

await t('CARRITO sin promoción (null, descuento 0 o de otro subtotal): byte a byte el de antes', () => {
  const s = sesionIncidente();
  s.paso(dx('CATEGORIA', { operacion: 'ver_carrito' }));
  const hoy = respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina);
  assert.equal(hoy.data.importe, 'Para agregar bebidas u otros platillos, toca «Seguir pidiendo». Productos: $290.00. Envío y promociones se calculan al revisar.');
  assert.equal(hoy.data.boton, 'Continuar · $290');
  assert.equal(hoy.data.resumen, 'Tu pedido: 2 platillos · $290');
  for (const promo of [null, { subtotalCentavos: 29000, descuentoCentavos: 0, promociones: [], avisos: [] }, promo2x1(30000), 'x', []]) {
    assert.deepEqual(respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina, promo), hoy, JSON.stringify(promo));
  }
});

await t('ENTREGA con la promoción: «Tu pedido: 2 platillos · $145 con promoción» y, si no cabe la indicación, nunca se corta el total', () => {
  const s = sesionIncidente();
  s.paso(dx('CARRITO', { operacion: 'continuar', revision: String(s.b().revision) }));
  assert.equal(s.b().etapa, 'ENTREGA');
  const r = respuestaTienda(s.foto, s.b(), 'tk', '', null, null, promo2x1());
  exigirForma(r, 'ENTREGA con promo');
  assert.equal(r.screen, 'ENTREGA');
  assert.equal(r.data.resumen, 'Tu pedido: 2 platillos · $145 con promoción. Elige cómo lo recibes y cómo pagas.');
  assert(r.data.resumen.length <= LIMITES_TIENDA.texto.TextSubheading);
  // Sin promoción, el de siempre.
  const hoy = respuestaTienda(s.foto, s.b(), 'tk', '', null, null);
  assert.equal(hoy.data.resumen, 'Tu pedido: 2 platillos · $290. Elige cómo lo recibes y cómo pagas.');
});

await t('ENTREGA de un pedido caro con promoción: el total completo, sin «…»', () => {
  const foto = fotoTienda({ lineas: [] });
  let b = borradorTienda(foto);
  for (let i = 0; i < 20; i++) {
    const v = cambiarTienda(foto, b, dx('CATEGORIA', { operacion: 'ver', producto: 'p0' })).borrador.vista;
    b = cambiarTienda(foto, b, dx('PERSONALIZAR', { operacion: 'agregar', apertura: v.apertura, producto: 'p0', ...RANURAS_VACIAS,
      ...VERDE, cantidad: '20' })).borrador;
  }
  b = cambiarTienda(foto, b, dx('CARRITO', { operacion: 'continuar', revision: String(b.revision) })).borrador;
  const p = pedidoDelBorrador(foto, b);
  const promo = { subtotalCentavos: p.subtotalCentavos, descuentoCentavos: 2900000, promociones: [{ nombre: 'Miércoles de Chilaquiles', descuentoCentavos: 2900000 }], avisos: [] };
  const r = respuestaTienda(foto, b, 'tk', '', null, null, promo);
  exigirForma(r, 'ENTREGA cara');
  assert.doesNotMatch(r.data.resumen, /…/);
  assert.match(r.data.resumen, /^Tu pedido: 400 platillos · \$29,000 con promoción/);
});

await t('MENU y CATEGORIA: «Tu pedido» trae el total con la promoción y lo dice; sin ella, como antes', () => {
  const s = sesionIncidente();
  const cat = respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina, promo2x1());
  exigirForma(cat, 'CATEGORIA con promo');
  assert.equal(cat.screen, 'CATEGORIA');
  const barra = cat.data.barra[0];
  assert.equal(barra.end.title, '$145');
  assert.equal(barra['main-content'].metadata, 'Agregaste: 1 × Chilaquiles · promoción aplicada');
  s.paso(dx('CARRITO', { operacion: 'seguir' }));
  const menu = respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina, promo2x1());
  exigirForma(menu, 'MENU con promo');
  assert.equal(menu.data.barra[0].end.title, '$145');
  assert.equal(menu.data.barra[0]['main-content'].metadata, 'Promoción aplicada · toca para revisar o continuar');
  const hoy = respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina);
  assert.equal(hoy.data.barra[0].end.title, '$290');
  assert.equal(hoy.data.barra[0]['main-content'].metadata, 'Toca para revisar o continuar');
});

await t('avisos sin promoción aplicada: por qué no aplicó y cuánto falta, entre el subtotal y «se calculan al revisar»', () => {
  const s = sesionIncidente();
  s.paso(dx('CATEGORIA', { operacion: 'ver_carrito' }));
  const avisos = ['La promoción "Miércoles de Chilaquiles" no se aplicó porque elegiste Suiza en salsa. Para aprovecharla necesitas salsa Roja o Verde.'];
  const r = respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina, { subtotalCentavos: 29000, descuentoCentavos: 0, promociones: [], avisos });
  exigirForma(r, 'CARRITO con aviso');
  assert.equal(r.data.importe, `Para agregar bebidas u otros platillos, toca «Seguir pidiendo». Productos: $290.00. ${avisos[0]} Envío y promociones se calculan al revisar.`);
  assert.equal(r.data.boton, 'Continuar · $290');
  // Muchos avisos: el pie se corta en su límite, con la promoción aplicada primero.
  const largo = { ...promo2x1(), avisos: Array.from({ length: 8 }, () => avisos[0]) };
  const r2 = respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina, largo);
  exigirForma(r2, 'CARRITO con muchos avisos');
  assert(r2.data.importe.length <= LIMITES_TIENDA.texto.TextCaption);
  assert.match(r2.data.importe, /^Productos: \$290\.00\. Promoción Miércoles de Chilaquiles: -\$145\.00\. Total con promoción: \$145\.00/);
});

await t('nombres de promoción con marcas: se dibujan sin ellas', () => {
  const s = sesionIncidente();
  s.paso(dx('CATEGORIA', { operacion: 'ver_carrito' }));
  const promo = { ...promo2x1(), promociones: [{ nombre: '*2x1* [hoy]', descuentoCentavos: 14500 }] };
  const r = respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina, promo);
  assert.match(r.data.importe, /Promoción 2x1 hoy: -\$145\.00\./);
});

await t('dibujaTotales: solo carrito, menú, categoría, tacos y entrega con platillos (no ficha, edición, dirección ni final)', () => {
  const s = sesionIncidente(), b = s.b();
  assert.equal(dibujaTotales(b), true);
  assert.equal(dibujaTotales({ ...b, vista: { pantalla: 'PERSONALIZAR' } }), false);
  assert.equal(dibujaTotales({ ...b, vista: { pantalla: 'EDITAR' } }), false);
  assert.equal(dibujaTotales({ ...b, etapa: 'ENTREGA', vista: { pantalla: 'ENTREGA' } }), true);
  for (const etapa of ['DIRECCION', 'FINAL']) assert.equal(dibujaTotales({ ...b, etapa }), false);
  assert.equal(dibujaTotales({ ...b, filas: [] }), false);
  assert.equal(dibujaTotales(null), false);
});

await t('pedidoConPromo: solo con el mismo subtotal y con platillos', () => {
  const s = sesionIncidente(), p = pedidoDelBorrador(s.foto, s.b());
  assert.equal(pedidoConPromo(p, promo2x1()).promo.descuentoCentavos, 14500);
  assert.equal(pedidoConPromo(p, promo2x1(29001)), p);
  assert.equal(pedidoConPromo({ ...p, unidades: 0 }, promo2x1()).promo, undefined);
});

// ── El motor (doble de previsualizarPedido) ──────────────────────────────
const previaOk = ({ subtotal = 290, descuento = 145, promociones = [{ nombre: 'Miércoles de Chilaquiles', descuento: 145 }], oportunidades = [] } = {}) =>
  ({ ok: true, preview: { subtotal, descuento_total: descuento, promociones, total: subtotal - descuento },
    orden: { items: [], promo_oportunidades: oportunidades } });
function doble(respuesta) {
  const llamadas = [];
  const previsualizar = async (orden, negocioId, opts) => { llamadas.push({ orden, negocioId, opts }); return typeof respuesta === 'function' ? respuesta(orden) : respuesta; };
  return { previsualizar, llamadas };
}
const sinExplicar = async () => '';

await t('ordenDelBorrador: ids y nombres de la foto, opciones por grupo, carta publicada de WhatsApp', () => {
  const s = sesionIncidente();
  const o = ordenDelBorrador({ negocioId: 'n1', foto: s.foto, borrador: s.b(), telefono: '5218130000000', modalidad: 'entrega a domicilio' });
  assert.deepEqual(o, { negocioId: 'n1', telefono_conversacion: '5218130000000', catalogo_publicado: 'whatsapp',
    cliente: { telefono: '5218130000000' }, modalidad: 'entrega a domicilio', forma_pago: 'efectivo', items: [
      { id: '10', nombre: 'Chilaquiles', cantidad: 1, modificadores: [{ grupo: 'Salsa', opcion: 'Verde' }, { grupo: 'Proteína', opcion: 'Pollo' }, { grupo: 'Guarniciones', opcion: 'Frijoles' }] },
      { id: '10', nombre: 'Chilaquiles', cantidad: 1, modificadores: [{ grupo: 'Salsa', opcion: 'Roja' }, { grupo: 'Proteína', opcion: 'Pollo' },
        { grupo: 'Guarniciones', opcion: 'Frijoles' }, { grupo: 'Guarniciones', opcion: 'Papas' }] }] });
});

await t('pagoParaVista: el elegido; si no hay, el primero que ofrece el formulario; sin ninguno, null', () => {
  const s = sesionIncidente();
  assert.equal(pagoParaVista(s.foto, s.b()), 'efectivo');
  assert.equal(pagoParaVista(s.foto, { ...s.b(), pago: 'p1' }), 'tarjeta');
  assert.equal(pagoParaVista(s.foto, { ...s.b(), pago: 1 }), 'tarjeta');
  assert.equal(pagoParaVista({ ...s.foto, pagos: [] }, s.b()), null);
});

await t('promoDelBorrador: canal whatsapp, una pregunta por entrega posible, y la traducción a centavos', async () => {
  olvidarPromosDelFormulario();
  const s = sesionIncidente(), d = doble(previaOk());
  const r = await promoDelBorrador({ negocioId: 'n1', foto: s.foto, borrador: s.b(), telefono: '521', previsualizar: d.previsualizar, explicar: sinExplicar });
  assert.deepEqual(r, { subtotalCentavos: 29000, descuentoCentavos: 14500, promociones: [{ nombre: 'Miércoles de Chilaquiles', descuentoCentavos: 14500 }], avisos: [] });
  assert.deepEqual(d.llamadas.map((l) => [l.negocioId, l.opts.canal, l.orden.modalidad]), [['n1', 'whatsapp', 'recoger en tienda'], ['n1', 'whatsapp', 'entrega a domicilio']]);
  // Y lo que devuelve se dibuja tal cual.
  s.paso(dx('CATEGORIA', { operacion: 'ver_carrito' }));
  assert.equal(respuestaTienda(s.foto, s.b(), 'tk', '', null, s.vitrina, r).data.boton, 'Continuar · $145');
});

await t('sin entrega elegida: se muestra el descuento MENOR (una promo solo para recoger no se promete a domicilio)', async () => {
  olvidarPromosDelFormulario();
  const s = sesionIncidente();
  const d = doble((orden) => (orden.modalidad === 'recoger en tienda' ? previaOk() : previaOk({ descuento: 0, promociones: [] })));
  const r = await promoDelBorrador({ negocioId: 'n1', foto: s.foto, borrador: s.b(), previsualizar: d.previsualizar, explicar: sinExplicar });
  assert.equal(r.descuentoCentavos, 0);
  // Con la entrega elegida, solo esa.
  olvidarPromosDelFormulario();
  const d2 = doble((orden) => (orden.modalidad === 'recoger en tienda' ? previaOk() : previaOk({ descuento: 0, promociones: [] })));
  const r2 = await promoDelBorrador({ negocioId: 'n1', foto: s.foto, borrador: { ...s.b(), modalidad: 'm0' }, previsualizar: d2.previsualizar, explicar: sinExplicar });
  assert.equal(r2.descuentoCentavos, 14500);
  assert.deepEqual(d2.llamadas.map((l) => l.orden.modalidad), ['recoger en tienda']);
});

await t('el descuento se acota al subtotal, como en el registro', async () => {
  olvidarPromosDelFormulario();
  const s = sesionIncidente(), d = doble(previaOk({ descuento: 500 }));
  const r = await promoDelBorrador({ negocioId: 'n1', foto: s.foto, borrador: s.b(), previsualizar: d.previsualizar, explicar: sinExplicar });
  assert.equal(r.descuentoCentavos, 29000);
});

await t('avisos: la explicación del diagnóstico y las oportunidades (sin repetir la ya explicada)', async () => {
  olvidarPromosDelFormulario();
  const s = sesionIncidente();
  const explicacion = 'La promoción "Miércoles de Chilaquiles" no se aplicó porque elegiste Suiza en salsa. Para aprovecharla necesitas salsa Roja o Verde.';
  const d = doble(previaOk({ descuento: 0, promociones: [], oportunidades: [
    { nombre: 'Miércoles de Chilaquiles', unidadesFaltantes: 1 }, { nombre: 'Martes 2x1', unidadesFaltantes: 2 }] }));
  const pedidas = [];
  const r = await promoDelBorrador({ negocioId: 'n1', foto: s.foto, borrador: s.b(), previsualizar: d.previsualizar,
    explicar: async (negocioId, orden, opts) => { pedidas.push([negocioId, opts.canal]); return explicacion; } });
  assert.deepEqual(r.avisos, [explicacion, 'Con 2 platillos participantes más se aplica «Martes 2x1».']);
  assert.deepEqual(pedidas, [['n1', 'whatsapp']]);
  // Una promo aplicada con unidades sueltas: «se aplica otra vez».
  olvidarPromosDelFormulario();
  const d2 = doble(previaOk({ oportunidades: [{ nombre: 'Miércoles de Chilaquiles', unidadesFaltantes: 1 }] }));
  const r2 = await promoDelBorrador({ negocioId: 'n1', foto: s.foto, borrador: s.b(), previsualizar: d2.previsualizar, explicar: sinExplicar });
  assert.deepEqual(r2.avisos, ['Con 1 platillo participante más, «Miércoles de Chilaquiles» se aplica otra vez.']);
  // El diagnóstico que falla no tumba la promoción.
  olvidarPromosDelFormulario();
  const r3 = await promoDelBorrador({ negocioId: 'n1', foto: s.foto, borrador: s.b(), previsualizar: doble(previaOk()).previsualizar,
    explicar: async () => { throw Error('diagnóstico roto'); } });
  assert.equal(r3.descuentoCentavos, 14500);
});

await t('seguro: rechazo, error, demora o sin platillos → null; un fallo no se recuerda', async () => {
  const s = sesionIncidente(), base = { negocioId: 'n1', foto: s.foto, borrador: s.b(), explicar: sinExplicar };
  for (const respuesta of [{ ok: false, rechazos: [{ codigo: 'X' }] }, null, { ok: true }, () => { throw Error('base caída'); }]) {
    olvidarPromosDelFormulario();
    assert.equal(await promoDelBorrador({ ...base, previsualizar: doble(respuesta).previsualizar }), null, JSON.stringify(respuesta));
  }
  // Una de las entregas rechazada basta para no dibujar nada.
  olvidarPromosDelFormulario();
  assert.equal(await promoDelBorrador({ ...base, previsualizar: doble((o) => (o.modalidad === 'entrega a domicilio' ? { ok: false } : previaOk())).previsualizar }), null);
  // Demora: se suelta en esperaMs y se dibuja lo de antes.
  olvidarPromosDelFormulario();
  const inicio = Date.now();
  assert.equal(await promoDelBorrador({ ...base, esperaMs: 40, previsualizar: () => new Promise(() => {}) }), null);
  assert(Date.now() - inicio < 1000, 'no espera de más');
  // Sin platillos o sin negocio no pregunta.
  const d = doble(previaOk());
  assert.equal(await promoDelBorrador({ ...base, borrador: { ...s.b(), filas: [] }, previsualizar: d.previsualizar }), null);
  assert.equal(await promoDelBorrador({ ...base, negocioId: '', previsualizar: d.previsualizar }), null);
  assert.equal(d.llamadas.length, 0);
  // El fallo no se recuerda: la siguiente vez vuelve a preguntar.
  olvidarPromosDelFormulario();
  let n = 0;
  const alterna = async () => (++n === 1 ? { ok: false } : previaOk());
  assert.equal(await promoDelBorrador({ ...base, previsualizar: alterna }), null);
  assert.equal((await promoDelBorrador({ ...base, previsualizar: alterna }))?.descuentoCentavos, 14500);
});

await t('memoria de un minuto: la misma pregunta no vuelve al motor; otro pedido, otro teléfono o ya vencida, sí', async () => {
  olvidarPromosDelFormulario();
  const s = sesionIncidente(), d = doble(previaOk());
  let reloj = 1_000_000;
  const base = { negocioId: 'n1', foto: s.foto, borrador: s.b(), telefono: '521', previsualizar: d.previsualizar, explicar: sinExplicar, ahora: () => reloj };
  await promoDelBorrador(base); await promoDelBorrador(base);
  assert.equal(d.llamadas.length, 2, 'dos entregas, una sola vez');
  await promoDelBorrador({ ...base, telefono: '522' });
  assert.equal(d.llamadas.length, 4);
  s.paso(dx('CATEGORIA', { operacion: 'ver_carrito' }));
  await promoDelBorrador({ ...base, borrador: s.b() });
  assert.equal(d.llamadas.length, 4, 'ver el carrito no cambia los platillos: misma pregunta');
  reloj += 61_000;
  await promoDelBorrador(base);
  assert.equal(d.llamadas.length, 6);
});

await t('interruptor: encendido por omisión; whatsapp_flow_tienda_promos_v1=false lo apaga', () => {
  assert.equal(promosEnFormularioActivas({}), true);
  assert.equal(promosEnFormularioActivas(null), true);
  assert.equal(promosEnFormularioActivas({ whatsapp_flow_tienda_promos_v1: 'true' }), true);
  assert.equal(promosEnFormularioActivas({ whatsapp_flow_tienda_promos_v1: 'false' }), false);
});

console.log(`RESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas} (promoción en el formulario)`);
process.exit(fallidas ? 1 : 0);
