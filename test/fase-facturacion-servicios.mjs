import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { validarEntradaServicio } = await import('../src/services/facturacionServicios.js');
const config = { iva_tasa: 0.08, serie: null };
const base = { descripcion: 'Catering evento privado', total: '12500.00', referencia: '', clave_sat: '90101501', forma_pago: 'transferencia', rfc: 'ABC010101AB1', nombre: 'Empresa de Prueba SA de CV', regimen_fiscal: '601', uso_cfdi: 'G03', cp_fiscal: '26000', email: '' };

const ok = validarEntradaServicio(base, config);
assert.equal(ok.descripcion, 'Catering evento privado');
assert.equal(ok.total, 12500);
assert.equal(ok.pago, '03');
assert.equal(ok.fiscal.email, '');
assert.equal(ok.referencia, null);

assert.throws(() => validarEntradaServicio({ ...base, total: '0' }, config), e => e.codigo === 'TOTAL_NO_FACTURABLE');
assert.throws(() => validarEntradaServicio({ ...base, clave_sat: '901' }, config), e => e.codigo === 'CLAVE_SAT_INVALIDA');
assert.throws(() => validarEntradaServicio({ ...base, forma_pago: 'mixto' }, config), e => e.codigo === 'FORMA_PAGO_NO_DETERMINADA');
assert.throws(() => validarEntradaServicio({ ...base, uso_cfdi: 'D10' }, config), e => e.codigo === 'DATOS_FISCALES_INVALIDOS');
assert.throws(() => validarEntradaServicio(base, { iva_tasa: null }), e => e.codigo === 'IVA_NO_CONFIGURADO');

const migration = readFileSync(new URL('../migrations/096_facturacion_servicios.sql', import.meta.url), 'utf8');
assert.match(migration, /CREATE TABLE IF NOT EXISTS facturacion_servicios/);
assert.match(migration, /referencia\s+text/);
assert.match(migration, /snapshot_cifrado/);
assert.match(migration, /UNIQUE INDEX IF NOT EXISTS uq_facturacion_servicios_referencia/);

const server = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
assert.match(server, /\/api\/admin\/facturacion\/servicios/);
assert.match(server, /emitirFacturaServicio/);
console.log('OK fase-facturacion-servicios: 10 comprobaciones');
