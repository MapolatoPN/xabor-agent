// Pruebas sin BD ni servidor para el preset comercial de alimentos.
// Ejecutar: node --test test/fase-alimentos-basico.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { PRESETS, validarCombinacion, expandirDependencias, checklistOnboarding } from '../src/services/modulosDependencias.js';

test('preset de alimentos básico incluye POS, menú y mesas', () => {
  const p = PRESETS.find(x => x.clave === 'alimentos_basico');
  assert.ok(p, 'Debe existir el preset');
  assert.deepEqual(p.modulos, ['pos', 'menu', 'restaurante']);
  assert.deepEqual(validarCombinacion(p.modulos).faltantes, []);
  assert.deepEqual(expandirDependencias(p.modulos).agregados, []);
});

test('no activa automáticamente funciones de pago adicional', () => {
  const p = PRESETS.find(x => x.clave === 'alimentos_basico');
  for (const m of ['usuarios','whatsapp','impresion','caja','pagos','facturacion','repartidores','tienda_online','rappi','personal']) {
    assert.ok(!p.modulos.includes(m), `El módulo ${m} no debe venir incluido`);
  }
});

test('onboarding básico solicita menú y mesas sin instalación de impresoras', () => {
  const p = PRESETS.find(x => x.clave === 'alimentos_basico');
  const claves = checklistOnboarding(p.modulos).map(x => x.clave);
  assert.deepEqual(claves, ['negocio', 'admin', 'menu', 'restaurante']);
  assert.ok(!claves.includes('impresion'));
});
