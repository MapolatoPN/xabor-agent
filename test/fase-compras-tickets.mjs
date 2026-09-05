import assert from 'node:assert/strict';
import {
  normalizarExtraccionTicket, construirPromptTicket, CATEGORIAS_COMPRA,
} from '../src/services/ticketComprasIA.js';
import { normalizarCompra, CompraOperativaError } from '../src/services/comprasOperativas.js';

let ok = 0;
const t = (nombre, fn) => {
  try { fn(); ok++; console.log(`  ✅ ${nombre}`); }
  catch (e) { console.error(`  ❌ ${nombre}: ${e.message}`); process.exitCode = 1; }
};

console.log('\n=== FASE COMPRAS · TICKETS ===');

t('el ticket es DATA no confiable y nunca decide si está facturado', () => {
  const p = construirPromptTicket();
  assert.match(p, /CONTENIDO NO CONFIABLE/);
  assert.match(p, /NO prueba la existencia de CFDI/);
  assert.doesNotMatch(JSON.stringify(normalizarExtraccionTicket({
    proveedor: 'Tienda', fecha: '2026-09-04', total: 100, items: [], confianza: .9, advertencias: [],
  })), /estado_factura/);
});

t('no inventa fecha/total ilegibles: null + advertencia', () => {
  const r = normalizarExtraccionTicket({ proveedor: 'HEB', fecha: '04/09/26', total: '100', items: [], confianza: .7, advertencias: [] });
  assert.equal(r.fecha, null);
  assert.equal(r.total, null);
  assert(r.advertencias.includes('FECHA_NO_LEGIBLE'));
  assert(r.advertencias.includes('TOTAL_NO_LEGIBLE'));
});

t('conserva cifras visibles aunque items no cuadren con total', () => {
  const r = normalizarExtraccionTicket({
    proveedor: 'Proveedor', fecha: '2026-09-04', subtotal: 90, impuestos: 10, total: 100,
    items: [{ descripcion: 'Carne', cantidad: 1, unidad: 'kg', precio_unitario: 70, importe: 70, categoria_sugerida: 'Proteínas/carnes', confianza: .98 }],
    confianza: .9, advertencias: [],
  });
  assert.equal(r.total, 100);
  assert.equal(r.items[0].importe, 70);
  assert(r.advertencias.includes('TOTAL_NO_COINCIDE_CON_ITEMS'));
});

t('categoría sugerida solo acepta catálogo controlado', () => {
  const r = normalizarExtraccionTicket({
    fecha: '2026-09-04', total: 10, items: [
      { descripcion: 'Leche', importe: 10, categoria_sugerida: 'Lácteos', confianza: 1 },
      { descripcion: 'Otro', importe: 0, categoria_sugerida: 'Gasto deducible mágico', confianza: .5 },
    ], confianza: .9, advertencias: [],
  });
  assert(CATEGORIAS_COMPRA.includes(r.items[0].categoria_sugerida));
  assert.equal(r.items[1].categoria_sugerida, null);
});

t('la revisión puede cambiar la categoría propuesta', () => {
  const n = normalizarCompra({
    proveedor: 'HEB', fecha: '2026-09-04', total: 120, tipo_pago: 'contado', estado_factura: 'pendiente',
    items: [{ descripcion: 'Bolsas', importe: 120, categoria_sugerida: 'Otros', categoria: 'Desechables/empaque' }],
  });
  assert.equal(n.items[0].categoria, 'Desechables/empaque');
  assert.equal(n.items[0].categoria_sugerida, 'Otros');
});

t('crédito y contado son válidos; el tipo no cambia el monto del gasto', () => {
  const a = normalizarCompra({ proveedor: 'A', fecha: '2026-09-04', total: 500, tipo_pago: 'credito' });
  const b = normalizarCompra({ proveedor: 'A', fecha: '2026-09-04', total: 500, tipo_pago: 'contado' });
  assert.equal(a.total, b.total);
  assert.equal(a.tipo_pago, 'credito'); assert.equal(b.tipo_pago, 'contado');
});

t('confirmar exige proveedor, fecha y total; un borrador puede estar incompleto', () => {
  assert.doesNotThrow(() => normalizarCompra({}));
  assert.throws(() => normalizarCompra({}, { confirmar: true }), CompraOperativaError);
  assert.throws(() => normalizarCompra({ proveedor: 'A', fecha: '2026-09-04', total: 0 }, { confirmar: true }), /total mayor a cero/i);
  assert.doesNotThrow(() => normalizarCompra({ proveedor: 'A', fecha: '2026-09-04', total: 1 }, { confirmar: true }));
});

t('valores negativos o estados inventados no atraviesan el normalizador', () => {
  const n = normalizarCompra({ total: -20, subtotal: -1, tipo_pago: 'bitcoin', estado_factura: 'quiza' });
  assert.equal(n.total, null); assert.equal(n.subtotal, null);
  assert.equal(n.tipo_pago, 'contado'); assert.equal(n.estado_factura, 'no_facturado');
});

t('un CFDI inválido nunca se guarda como UUID', () => {
  const n = normalizarCompra({ cfdi_uuid: 'NO-ES-UUID' });
  assert.equal(n.cfdi_uuid, null);
});

if (!process.exitCode) console.log(`\n✅ fase-compras-tickets: ${ok}/${ok}\n`);
