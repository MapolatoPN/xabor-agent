// Precuenta de Restaurante — prueba rápida sin Postgres.
// Protege la frontera urgente: Mesa abierta -> documento cuenta -> Caja/Ticket,
// sin cerrar ni cobrar la cuenta.
import assert from 'assert';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { renderCuenta } from '../edge/renderers/index.js';
import { indexarReglas, destinosDeDocumento } from '../src/printing/routingEngine.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');
let ok = 0;
function t(nombre, fn) {
  try { fn(); console.log('  OK  ' + nombre); ok++; }
  catch (e) { console.error('FALLO ' + nombre + ': ' + e.message); process.exitCode = 1; }
}

t('1. el papel dice PRECUENTA y no comprobante', () => {
  const b = renderCuenta({
    precuenta: true,
    leyenda: 'NO ES COMPROBANTE DE PAGO',
    negocio: 'Mapolato', mesa: 7, mesero: 'Karina',
    items: [{ producto: 'Chilaquiles', cantidad: 1, precioUnitario: 195, modificadores: ['Salsa: Verde'] }],
    subtotal: 195, total: 195, pagos: [],
  });
  const s = b.toString('latin1');
  assert.ok(s.includes('PRECUENTA'));
  assert.ok(s.includes('NO ES COMPROBANTE DE PAGO'));
});

t('2. la precuenta conserva modificadores y notas', () => {
  const s = renderCuenta({
    precuenta: true, items: [{ producto:'Licuado', cantidad:1, precioUnitario:75,
      modificadores:['Sabor: Platano'], notas:'Sin fruta extra' }], total:75,
  }).toString('latin1');
  assert.ok(s.includes('Sabor: Platano'));
  assert.ok(s.includes('NOTA: Sin fruta extra'));
});

t('3. pagos parciales muestran Pagado y Saldo', () => {
  const s = renderCuenta({ precuenta:true, items:[], subtotal:200, total:200, pagado:50, saldo:150 }).toString('latin1');
  assert.ok(s.includes('Pagado'));
  assert.ok(s.includes('Saldo'));
});

t('4. documento cuenta solo usa ruta de Caja/Ticket', () => {
  const reglas = indexarReglas([
    { ambito:'documento', clave:'comanda', impresora_id:'cocina', activa:true },
    { ambito:'documento', clave:'cuenta', impresora_id:'ticket', activa:true },
  ]);
  assert.deepStrictEqual(destinosDeDocumento('cuenta', reglas).map(x => x.impresoraId), ['ticket']);
});

const server = readFileSync(join(root, 'src/server.js'), 'utf8');
t('5. el endpoint de precuenta no cierra ni registra pago', () => {
  const ini = server.indexOf("app.post('/api/restaurante/cuentas/:cuentaId/precuenta'");
  const fin = server.indexOf("app.post('/api/restaurante/cuentas/:cuentaId/cerrar'", ini);
  assert.ok(ini >= 0 && fin > ini);
  const bloque = server.slice(ini, fin);
  assert.ok(bloque.includes("documento: 'cuenta'"));
  assert.ok(bloque.includes("origenTipo: 'restaurante_precuenta'"));
  assert.ok(!bloque.includes('cerrarCuenta('));
  assert.ok(!bloque.includes('registrarPago('));
  assert.ok(bloque.includes("destino: 'edge'"));
  assert.ok(bloque.includes("destino: 'navegador'"));
  assert.ok(!bloque.includes('SIN_IMPRESORA_TICKET'));
});

const mesas = readFileSync(join(root, 'panel/mesas.html'), 'utf8');
t('6. la UI ofrece Imprimir precuenta y usa el endpoint dedicado', () => {
  assert.ok(mesas.includes('Imprimir precuenta'));
  assert.ok(mesas.includes('/precuenta'));
  assert.ok(mesas.includes('imprimirPrecuenta'));
  assert.ok(mesas.includes("r.destino === 'navegador'"));
  assert.ok(mesas.includes('imprimirPrecuentaEnNavegador'));
  assert.ok(mesas.includes("document.createElement('iframe')"));
  assert.ok(mesas.includes('marco.contentWindow.print()'));
});

if (!process.exitCode) console.log('\nPRECUENTA OK ' + ok + '/6');
