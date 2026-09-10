// Levanta un Xabor Edge con un catálogo de prueba, para verificar el modo sin
// conexión con un NAVEGADOR de verdad — no con clientes HTTP.
//
// Sirve también en sitio: permite comprobar el arranque del panel local en la
// caja antes de tocar nada de producción.
//
//   node scripts/edge-local-demo.mjs [puerto]
//
// No habla con la nube (`conectar: false`) y guarda en una carpeta temporal.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { crearEdge } from '../edge/index.js';
import { hashPin } from '../src/services/password.js';

const puerto = Number(process.argv[2]) || 7071;
const NEG = '5de544d8-9a0a-4972-9c92-fd48ff22de66';
const MESERO = randomUUID(), CAJA = randomUUID(), LLEVAR = randomUUID();

const catalogo = {
  version: 1, negocioId: NEG, negocioNombre: 'Mapolato Obispado (demo local)',
  generadoAt: new Date().toISOString(), numMesas: 8,
  metodosPago: ['efectivo', 'terminal'],
  meseros: [
    { id: MESERO, nombre: 'Mesero Uno', rol: 'mesero', pin_hash: hashPin('1111') },
    { id: CAJA, nombre: 'Caja Principal', rol: 'cajero', pin_hash: hashPin('3333') },
    { id: LLEVAR, nombre: 'Para Llevar', rol: 'mesero', pin_hash: hashPin('4444') },
  ],
  cuentasAbiertas: [],
  menu: [{ id: 1, nombre: 'FUERTES', orden: 0, productos: [
    { id: 10, nombre: 'Chilaquiles', precio: 195, categoria_id: 1, disponible: true, modificadores: [
      { id: 100, nombre: 'Guarniciones', requerido: true, minimo: 1, maximo: 2, opciones: [
        { id: 1000, nombre: 'Frijolitos naturales', precio_extra: 0 },
        { id: 1001, nombre: 'Papas a la mexicana', precio_extra: 0 },
      ] }] },
    { id: 11, nombre: 'Refresco', precio: 45, categoria_id: 1, disponible: true, modificadores: [] },
  ] }],
};

const edge = crearEdge({
  config: {
    wsUrl: 'wss://xabor.mx/ws/print-agent', terminalId: randomUUID(), terminalToken: 'demo',
    rutaDatos: mkdtempSync(join(tmpdir(), 'edge-demo-')),
    almacen: 'auto', nivelLog: 'info', heartbeatMs: 60000, timeoutImpresoraMs: 1000,
    puertoSala: puerto,
  },
  transportes: {},
});

await edge.iniciar({ conectar: false });
edge.aplicarCatalogo(catalogo);

console.log(`\n  Edge de demostración escuchando en http://localhost:${edge.servidorSala.puerto}`);
console.log('  PINs:  Mesero Uno 1111 · Caja Principal 3333 · Para Llevar 4444\n');

for (const s of ['SIGINT', 'SIGTERM']) {
  process.on(s, async () => { await edge.detener().catch(() => {}); process.exit(0); });
}
