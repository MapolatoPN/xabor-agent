import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { generarMatrizQr, matrizQrValida } from '../src/services/autofacturaQr.js';
import { renderCuenta } from '../edge/renderers/index.js';
import { construirTicketCuenta } from '../src/services/restauranteService.js';

const url = 'https://xabor.mx/f/abcdefghijklmnopqrstuvwxyz0123456789_-';
const qr = generarMatrizQr(url);
assert.ok(matrizQrValida(qr));
assert.ok(qr.size >= 21 && qr.size <= 177);
assert.equal(generarMatrizQr(''), null);
assert.equal(matrizQrValida({ size: 21, data: [] }), false);

const payload = {
  ticketPagado: true, negocio: 'Mapolato', folio: 'XAB-QR01', total: 229,
  items: [{ cantidad: 1, producto: 'Catering', precioUnitario: 229 }],
  autofacturaUrl: url, autofacturaQr: qr,
};
const bytes = renderCuenta(payload);
assert.match(bytes.toString('latin1'), /ESCANEA PARA FACTURAR/);
assert.ok(bytes.includes(Buffer.from([0x1d, 0x76, 0x30, 0x00])), 'falta imagen raster ESC/POS');

const ticket = construirTicketCuenta({ ventaFolio: 'XAB-QR01', total: 229, subtotal: 229, items: [], pagos: [] }, {
  autofacturaUrl: url, autofacturaQr: qr,
});
assert.equal(ticket.autofacturaUrl, url);
assert.deepEqual(ticket.autofacturaQr, qr);

const panelPos = readFileSync(new URL('../panel/index.html', import.meta.url), 'utf8');
assert.match(panelPos, /function svgQrAutofactura\(qr\)/);
assert.match(panelPos, /autofactura-qr/);
assert.match(panelPos, /if \(data\.autofacturaQr\) p\.autofacturaQr/);
console.log('OK fase-autofactura-qr: QR de Edge y snapshot de ticket verificados');
