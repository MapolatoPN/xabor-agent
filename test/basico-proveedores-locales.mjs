// Preload exclusivo del E2E: proveedores falsos en loopback; jamás hace cargos/correos.
import assert from 'node:assert/strict';
assert.equal(process.env.XABOR_BASICO_QA,'SI');
const db = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1','localhost'].includes(db.hostname));
assert.match(db.pathname,/^\/test_basico_/);
const destino = new URL(process.env.XABOR_QA_PROVEEDORES_URL);
assert.equal(destino.hostname,'127.0.0.1');
const original = globalThis.fetch;
globalThis.fetch = (url,opciones) => {
  const u = new URL(url);
  if (['api.resend.com','api.mercadopago.com'].includes(u.hostname)) {
    return original(new URL('/'+u.hostname+u.pathname+u.search,destino),opciones);
  }
  return original(url,opciones);
};
