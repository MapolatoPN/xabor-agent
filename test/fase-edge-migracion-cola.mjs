// ─── Actualizar el Edge no deja comandas atoradas en la PC ──────────────────
//
// Un Edge que corría en un Node sin `node:sqlite` guardaba su cola en
// edge-cola.json. Al instalar la versión nueva (Node 22, con SQLite), lo que
// estaba esperando en la PC se pasa a la cola nueva junto con la identidad de
// la instalación. Sin base de datos: carpetas temporales.
import assert from 'assert';
import { mkdtempSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crearAlmacen, migrarColaJson } from '../edge/storage/index.js';
import { sqliteDisponible } from '../edge/storage/sqlite.js';
import { loggerSilencioso } from '../edge/logger.js';

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(nombre, fn) {
  try { await fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}
const temporales = [];
const carpeta = () => { const d = mkdtempSync(join(tmpdir(), 'xabor-migracion-')); temporales.push(d); return d; };
const trabajo = (id, estado, extra = {}) => ({
  id, documento: 'comanda', impresoraId: 'imp-1', impresoraNombre: 'COCINA', transporte: 'mock', anchoColumnas: 42,
  payload: { mesa: 1, items: [{ producto: 'Chilaquiles', cantidad: 1 }] }, estado, intentos: 2, ultimoError: estado === 'fallido' ? 'sin papel' : null,
  proximoIntentoEn: Date.now() + 60000, creadoEn: Date.now() - 1000, actualizadoEn: Date.now(), ...extra,
});
const colaVieja = (dir, trabajos, estado = { instalacion_id: 'inst-vieja-123' }) => writeFileSync(join(dir, 'edge-cola.json'),
  JSON.stringify({ version: 1, trabajos: Object.fromEntries(trabajos.map(x => [x.id, x])), estado }));

if (!sqliteDisponible()) {
  console.log('Este Node no trae node:sqlite: la migración no aplica aquí (se corre con Node >= 22.5).');
} else {
  await t('1. lo que no terminó pasa a SQLite con su estado; lo enviado no; la identidad de la instalación se conserva', async () => {
    const dir = carpeta();
    colaVieja(dir, [trabajo('a', 'pendiente'), trabajo('b', 'fallido'), trabajo('c', 'incierto'), trabajo('d', 'agotado'),
      trabajo('e', 'enviado'), trabajo('f', 'cancelado')]);
    const al = crearAlmacen({ almacen: 'auto', rutaDatos: dir, logger: loggerSilencioso });
    try {
      assert.strictEqual(al.tipo, 'sqlite');
      assert.deepStrictEqual(al.todos().map(x => [x.id, x.estado]).sort(), [['a', 'pendiente'], ['b', 'fallido'], ['c', 'incierto'], ['d', 'agotado']]);
      // Listos para intentar YA (proximoIntentoEn a 0): la comanda sale en cuanto arranca.
      assert.deepStrictEqual(al.pendientes().map(x => x.id).sort(), ['a', 'b']);
      assert.strictEqual(al.obtener('a').payload.items[0].producto, 'Chilaquiles');
      assert.strictEqual(al.leerEstado('instalacion_id'), 'inst-vieja-123', 'la nube creería que el Edge perdió la memoria');
      assert.ok(!existsSync(join(dir, 'edge-cola.json')), 'el JSON no se renombró');
      assert.ok(readdirSync(dir).some(f => f.startsWith('edge-cola.json.migrado-')), 'no quedó el respaldo');
    } finally { al.cerrar(); }
    // Al volver a arrancar no se migra otra vez ni se duplica nada.
    const otra = crearAlmacen({ almacen: 'auto', rutaDatos: dir, logger: loggerSilencioso });
    try { assert.strictEqual(otra.todos().length, 4); } finally { otra.cerrar(); }
  });

  await t('2. sin cola vieja no pasa nada; con una ilegible el Edge arranca igual y el archivo se queda para revisarlo', async () => {
    const limpio = carpeta();
    const a = crearAlmacen({ almacen: 'auto', rutaDatos: limpio, logger: loggerSilencioso });
    try { assert.strictEqual(a.todos().length, 0); } finally { a.cerrar(); }
    const roto = carpeta();
    writeFileSync(join(roto, 'edge-cola.json'), '{ esto no es json');
    const b = crearAlmacen({ almacen: 'auto', rutaDatos: roto, logger: loggerSilencioso });
    try {
      assert.strictEqual(b.todos().length, 0);
      assert.ok(existsSync(join(roto, 'edge-cola.json')), 'el archivo ilegible no debe moverse');
    } finally { b.cerrar(); }
  });

  await t('3. un trabajo que ya estaba en SQLite (la nube lo reenvió) no se duplica', async () => {
    const dir = carpeta();
    const al = crearAlmacen({ almacen: 'sqlite', rutaDatos: dir, logger: loggerSilencioso });
    try {
      al.registrarTrabajo(trabajo('x', 'pendiente'));
      al.actualizar('x', { estado: 'enviado' });
      colaVieja(dir, [trabajo('x', 'pendiente'), trabajo('y', 'pendiente')], {});
      const r = migrarColaJson(al, join(dir, 'edge-cola.json'), loggerSilencioso);
      assert.strictEqual(r.migrados, 1);
      assert.strictEqual(al.obtener('x').estado, 'enviado', 'la migración pisó un trabajo ya impreso');
    } finally { al.cerrar(); }
  });

  await t('4. con almacén JSON configurado a propósito no se migra nada', async () => {
    const dir = carpeta();
    colaVieja(dir, [trabajo('a', 'pendiente')]);
    const al = crearAlmacen({ almacen: 'json', rutaDatos: dir, logger: loggerSilencioso });
    try {
      assert.strictEqual(al.tipo, 'json');
      assert.ok(existsSync(join(dir, 'edge-cola.json')));
      assert.ok(!existsSync(join(dir, 'edge-cola.sqlite')));
    } finally { al.cerrar(); }
  });
}

for (const d of temporales) { try { rmSync(d, { recursive: true, force: true }); } catch {} }
console.log(`\n${'='.repeat(60)}\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}\n${'='.repeat(60)}`);
if (fallos.length) { console.log('\nFallos:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exitCode = fallidas > 0 ? 1 : 0;
