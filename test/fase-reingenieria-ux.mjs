// ─── Contratos de la reingeniería UX (estáticos sobre panel/index.html) ─────
// Protegen las decisiones de producto de la reingeniería: el selector de
// modalidad, la Operación unificada (capturas sin nav propia + chips),
// Pagos como única ubicación de configuración de pagos, el gating del
// bottom-nav y los ids que se corrigieron. Mismo estilo que
// fase-controles-atencion-frontend.mjs: regex de presencia/ausencia, sin DB.
import { readFileSync } from 'fs';
import assert from 'assert';

const html = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
let pasadas = 0;

function t(nombre, fn) {
  fn();
  pasadas++;
  console.log(`OK ${nombre}`);
}

// ─── Selector de modalidad ──────────────────────────────────────────────────
t('modal de modalidad existe como elemento', () => {
  assert.match(html, /<div id="modal-modalidad"/);
});
t('las 4 modalidades rutean por nuevoPedidoModalidad', () => {
  for (const m of ['restaurante', 'llevar', 'recoger', 'domicilio']) {
    assert.ok(html.includes(`nuevoPedidoModalidad('${m}')`), `falta modalidad ${m}`);
  }
});
t('la tarjeta Restaurante del modal respeta el módulo', () => {
  assert.match(html, /data-modulo="restaurante" onclick="nuevoPedidoModalidad\('restaurante'\)"/);
});
t('funciones del flujo de nuevo pedido presentes', () => {
  for (const f of ['abrirNuevoPedido', 'cerrarNuevoPedido', 'nuevoPedidoModalidad', 'pintarChipsModalidad', 'etiquetaEstadoPedido']) {
    assert.ok(html.includes(`function ${f}`), `falta ${f}`);
  }
});
t('el botón primario + Nuevo pedido exige módulo pos', () => {
  assert.match(html, /id="btn-nuevo-pedido" data-modulo="pos"/);
});

// ─── Operación unificada ────────────────────────────────────────────────────
t('las capturas NO son destinos del sidebar (sin tab-presencial/tab-envios)', () => {
  assert.ok(!html.includes('id="tab-presencial"'), 'tab-presencial sigue en el nav');
  assert.ok(!html.includes('id="tab-envios"'), 'tab-envios sigue en el nav');
});
t('el bottom-nav ya no tiene botón POS separado', () => {
  assert.ok(!html.includes('id="bnav-presencial"'));
});
t('mostrador y envíos llevan el encabezado de modalidad con regreso a Pedidos', () => {
  const presencial = html.indexOf('<div id="vista-presencial"');
  const envios = html.indexOf('<div id="vista-envios"');
  assert.ok(presencial > 0 && envios > 0);
  // cada vista abre con el mod-header (aparece antes de 600 chars de su inicio)
  for (const inicio of [presencial, envios]) {
    const tramo = html.slice(inicio, inicio + 700);
    assert.ok(tramo.includes('class="mod-header"'), 'falta mod-header');
    assert.ok(tramo.includes("mostrarTab('comandas')"), 'falta regreso a Pedidos');
  }
});
t('los chips cubren las 4 modalidades en ambas capturas', () => {
  for (const m of ['llevar', 'recoger', 'domicilio', 'restaurante']) {
    const n = html.split(`data-mod="${m}"`).length - 1;
    assert.strictEqual(n, 2, `chip ${m}: esperaba 2 (uno por captura), hay ${n}`);
  }
});
t('envTipo sincroniza los chips del encabezado', () => {
  assert.match(html, /function envTipo\(t\)\{[\s\S]{0,600}pintarChipsModalidad\(t\)/);
});

// ─── Config → Pagos sin duplicación ─────────────────────────────────────────
t('la sección Operación de Config ya no anuncia pagos', () => {
  assert.ok(!html.includes('Horarios, operación, pagos y entregas'));
  assert.ok(html.includes('Horarios, operación y entregas'));
});
t('metodos-pago-form existe una sola vez y vive en cfg-sec-pagos', () => {
  assert.strictEqual(html.split('id="metodos-pago-form"').length - 1, 1);
  const sec = html.indexOf('id="cfg-sec-pagos"');
  const form = html.indexOf('id="metodos-pago-form"');
  const cierre = html.indexOf('cfg-sec-facturacion');
  assert.ok(sec > 0 && form > sec && form < cierre, 'metodos-pago-form fuera de la sección Pagos');
});
t('las notas de pago de reglas viven en el slot de Pagos, no en Operación', () => {
  const slot = html.indexOf('id="reglas-pagos-form"');
  const sec = html.indexOf('id="cfg-sec-pagos"');
  const secOp = html.indexOf('id="cfg-sec-operacion"');
  assert.ok(slot > sec && sec > 0, 'reglas-pagos-form no está en la sección Pagos');
  // la plantilla de #reglas-form (Operación) ya no interpola campos de pago
  // (lastIndexOf: la primera aparición es el mensaje de error de carga)
  const renderReglas = html.slice(html.lastIndexOf("getElementById('reglas-form').innerHTML"), html.indexOf('const contPagos'));
  assert.ok(!renderReglas.includes('${pagosHtml}'), 'Operación sigue interpolando la lista de pagos');
  assert.ok(!renderReglas.includes('reg-pago-instrucciones'), 'Operación sigue renderizando instrucciones de pago');
  assert.ok(secOp > 0);
});
t('guardarReglas refleja el feedback también en el bloque de Pagos', () => {
  assert.match(html, /reglas-pagos-fb/);
});

// ─── Gating del bottom-nav y roles ──────────────────────────────────────────
t('bnav-corte respeta el módulo caja', () => {
  assert.match(html, /id="bnav-corte" data-modulo="caja"/);
});
t('navegación de staff: las vistas administrativas siguen marcadas admin-only', () => {
  for (const id of ['tab-config', 'tab-ventas', 'tab-historial', 'tab-usuarios']) {
    const i = html.indexOf(`id="${id}"`);
    assert.ok(i > 0, `falta ${id}`);
    const linea = html.slice(html.lastIndexOf('<button', i), i);
    assert.ok(linea.includes('admin-only'), `${id} sin admin-only`);
  }
  // Inicio y el tablero NO son admin-only: el staff opera con ellos
  for (const id of ['tab-inicio', 'tab-comandas']) {
    const i = html.indexOf(`id="${id}"`);
    const linea = html.slice(html.lastIndexOf('<button', i), i);
    assert.ok(!linea.includes('admin-only'), `${id} quedó admin-only`);
  }
});

// ─── Ids corregidos ─────────────────────────────────────────────────────────
t('pos-empty ya no existe como id (el estado vacío usa solo la clase)', () => {
  assert.ok(!html.includes('id="pos-empty"'));
  assert.ok(html.includes('class="pos-order-empty"'));
});
t('ids de la reingeniería aparecen exactamente una vez', () => {
  for (const id of ['modal-modalidad', 'vista-inicio', 'config-portada', 'reglas-pagos-form',
    'cfg-sec-negocio', 'cfg-sec-operacion', 'cfg-sec-pagos', 'cfg-sec-integraciones',
    'cfg-sec-equipos', 'cfg-sec-facturacion', 'cfg-sec-cotizaciones', 'btn-nuevo-pedido']) {
    const n = html.split(`id="${id}"`).length - 1;
    assert.strictEqual(n, 1, `id ${id}: ${n} apariciones`);
  }
});
// wa-progreso: documentado como falso positivo — son dos plantillas de ramas
// mutuamente excluyentes DENTRO del renderer congelado de WhatsApp
// (pintarWhatsappAutoservicio pinta conectado O no-conectado, nunca ambos).
// No se toca ese código; este contrato solo fija que siga siendo así.
t('wa-progreso solo existe dentro del renderer de WhatsApp (2 ramas excluyentes)', () => {
  assert.strictEqual(html.split('id="wa-progreso"').length - 1, 2);
  const fn = html.slice(html.indexOf('function pintarWhatsappAutoservicio'), html.indexOf('// --- Menu automatico'));
  assert.strictEqual(fn.split('id="wa-progreso"').length - 1, 2, 'wa-progreso apareció fuera del renderer congelado');
});

console.log(`\n${pasadas} pasadas, 0 fallidas`);
