import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encolarMensaje } from '../src/utils/colaMensajes.js';
const espera = ms => new Promise(r => setTimeout(r, ms));

test('un cliente lento conserva orden; otro cliente no espera', async () => {
  const fin = []; let activos = 0, max = 0;
  const procesar = async texto => {
    activos++; max = Math.max(max, activos);
    await espera(texto === 'primero' ? 90 : 5);
    fin.push(texto); activos--;
  };
  encolarMensaje('a', 'primero', procesar, 5);
  await espera(20);
  encolarMensaje('a', 'segundo', procesar, 5);
  encolarMensaje('b', 'otro', async t => { fin.push(t); }, 5);
  await espera(130);
  assert.equal(max, 1);
  assert.deepEqual(fin, ['otro', 'primero', 'segundo']);
});

test('mantiene agrupamiento dentro de la ventana', async () => {
  const vistos = [];
  encolarMensaje('c', 'uno', async t => vistos.push(t), 20);
  encolarMensaje('c', 'dos', async t => vistos.push(t), 20);
  await espera(50);
  assert.deepEqual(vistos, ['uno\ndos']);
});

test('un rechazo no bloquea el siguiente turno', async () => {
  const vistos = [];
  encolarMensaje('d', 'fallo', async () => { throw new Error('fallo simulado'); }, 5);
  await espera(20);
  encolarMensaje('d', 'siguiente', async t => vistos.push(t), 5);
  await espera(30);
  assert.deepEqual(vistos, ['siguiente']);
});
