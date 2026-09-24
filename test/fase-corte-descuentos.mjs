// Contrato financiero puro del corte. No toca base de datos ni servicios
// compartidos: fija la interpretacion de snapshots historicos de pedidos.
import assert from 'assert';
import {
  normalizarVentaFinanciera,
  construirReporteFinanciero,
} from '../src/services/ventaFinanciera.js';

let pasadas = 0;
async function t(nombre, fn) {
  await fn();
  console.log(`  OK  ${nombre}`);
  pasadas++;
}

await t('tienda: promociones, envio y Rewards concilian sin doble descuento', () => {
  const v = normalizarVentaFinanciera({
    id: 'FIC-STORE-1', canal: 'tienda_online', subtotal: 1000,
    descuento: 100, costo_envio: 0, total: 850,
    rewards_canje: { puntos: 50, monto: 50 },
    tienda: {
      envio_base: 100,
      promociones: [
        { id: 'p1', nombre: 'Promocion desayuno', tipo: 'porcentaje', valor: 10,
          descuento: 100, automatica: true },
        { id: 'p2', nombre: 'Envio gratis', tipo: 'envio_gratis', descuento: 0,
          envio_gratis: true, automatica: true },
      ],
    },
  });
  assert.strictEqual(v.venta_bruta_productos, 1000);
  assert.strictEqual(v.promociones_total, 200);
  assert.strictEqual(v.descuentos_manuales, 0);
  assert.strictEqual(v.rewards, 50);
  assert.strictEqual(v.venta_neta, 850);
  assert.strictEqual(v.descuadre, 0);
  const reporte = construirReporteFinanciero([v]);
  assert.strictEqual(reporte.resumen.venta_bruta_antes_descuentos, 1100);
  assert.strictEqual(v.aplicaciones.find(a => a.concepto === 'Promocion desayuno').porcentaje, 10);
});

await t('restaurante: el descuento manual conserva motivo, porcentaje y actor', () => {
  const v = normalizarVentaFinanciera({
    id: 'FIC-REST-1', canal: 'restaurante_mesa', subtotal: 500,
    descuento: 50, motivo_descuento: 'Cortesia', descuento_tipo: 'porcentaje',
    descuento_valor: 10, descuento_por: 'usuario-ficticio', total: 450, propinas: 60,
  });
  assert.strictEqual(v.descuentos_manuales, 50);
  assert.strictEqual(v.propinas, 60);
  assert.strictEqual(v.descuadre, 0);
  const a = v.aplicaciones.find(x => x.categoria === 'descuento_manual');
  assert.strictEqual(a.concepto, 'Cortesia');
  assert.strictEqual(a.porcentaje, 10);
  assert.strictEqual(a.usuario_id, 'usuario-ficticio');
});

await t('POS: el manual es solo el residual despues de promociones', () => {
  const v = normalizarVentaFinanciera({
    id: 'FIC-POS-1', canal: 'pos', subtotal: 500, descuento: 120, total: 380,
    motivo_descuento: 'Inconveniente',
    promociones: [{ id: 'p1', nombre: 'Promo comida', tipo: 'monto_fijo', valor: 80,
      descuento: 80, automatica: true }],
  });
  assert.strictEqual(v.promociones_total, 80);
  assert.strictEqual(v.descuentos_manuales, 40);
  assert.strictEqual(v.promociones_total + v.descuentos_manuales, 120);
  assert.strictEqual(v.descuadre, 0);
});

await t('Rappi: conserva el importe sin inventar el concepto', () => {
  const v = normalizarVentaFinanciera({
    id: 'FIC-RAPPI-1', canal: 'rappi', subtotal: 300, descuento: 30, total: 270,
  });
  assert.strictEqual(v.promociones_total, 30);
  assert.strictEqual(v.descuentos_manuales, 0);
  assert.strictEqual(v.calidad, 'parcial');
  assert.ok(v.aplicaciones.some(a => a.concepto === 'Descuento Rappi (concepto no informado)'));
});

await t('precio especial: usa snapshots lista/canal, no el catalogo actual', () => {
  const v = normalizarVentaFinanciera({
    id: 'FIC-SPECIAL-1', canal: 'tienda_online', subtotal: 160, total: 160,
    costo_envio: 0,
    items: [{ nombre: 'Producto ficticio', cantidad: 2, precio_lista: 100,
      precio_base: 80, precio_unitario: 80 }],
  });
  assert.strictEqual(v.venta_bruta_productos, 200);
  assert.strictEqual(v.promociones_total, 40);
  assert.strictEqual(v.descuadre, 0);
  assert.ok(v.aplicaciones.some(a => a.tipo_regla === 'precio_especial'));
});

await t('historico incompleto: no fabrica una venta bruta desde el total neto', () => {
  const v = normalizarVentaFinanciera({ id: 'FIC-OLD-1', canal: 'presencial', total: 90 });
  assert.strictEqual(v.venta_bruta_productos, null);
  assert.strictEqual(v.calidad, 'no_determinable');
});

await t('agrupacion: cuenta ventas distintas y mantiene Rewards separado', () => {
  const ventas = [
    normalizarVentaFinanciera({ id: 'F1', canal: 'restaurante_mesa', subtotal: 100,
      descuento: 10, motivo_descuento: 'Cortesia', total: 90 }),
    normalizarVentaFinanciera({ id: 'F2', canal: 'restaurante_mesa', subtotal: 200,
      descuento: 20, motivo_descuento: 'Cortesia', total: 175,
      rewards_canje: { puntos: 5, monto: 5 } }),
  ];
  const r = construirReporteFinanciero(ventas);
  const cortesia = r.descuentos_por_concepto.find(c => c.concepto === 'Cortesia');
  assert.deepStrictEqual({ ventas: cortesia.ventas, importe: cortesia.importe }, { ventas: 2, importe: 30 });
  assert.strictEqual(r.resumen.descuentos_manuales, 30);
  assert.strictEqual(r.resumen.rewards, 5);
  assert.strictEqual(r.resumen.promociones_y_descuentos, 30);
  assert.strictEqual(r.resumen.venta_neta, 265);
});

await t('devoluciones: conserva aplicaciones multiples sin duplicar el resumen legado', () => {
  const v = normalizarVentaFinanciera({
    id: 'FIC-DEV-1', canal: 'pos', subtotal: 300, total: 300,
    devoluciones: [
      { monto: 40, motivo: 'Producto faltante', usuario_id: 'u-1' },
      { monto: 25, motivo: 'Inconveniente', usuario_id: 'u-2' },
    ],
    // La presencia del resumen antiguo no debe sumarse una segunda vez.
    devolucion: { monto: 65, motivo: 'Inconveniente' },
  });
  assert.strictEqual(v.devoluciones, 65);
  assert.strictEqual(v.aplicaciones.filter(a => a.categoria === 'devolucion').length, 2);
});

await t('ajuste administrativo de devolucion queda separado de otros ajustes', () => {
  const r = construirReporteFinanciero([
    normalizarVentaFinanciera({ id: 'FIC-ADJ-1', subtotal: 100, total: 100 }),
  ], [{ folio: 'FIC-ADJ-1', tipo: 'devolucion', monto_ajuste: 20,
    motivo: 'Compensacion autorizada' }]);
  assert.strictEqual(r.resumen.devoluciones, 20);
  assert.strictEqual(r.resumen.ajustes_posteriores, 0);
  assert.ok(r.conceptos.some(c => c.categoria === 'devolucion' && c.importe === 20));
});

console.log(`\n${pasadas} pruebas financieras pasaron.`);
