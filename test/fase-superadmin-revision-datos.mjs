import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { revisionDatosNegocio, FIXTURES_NEGOCIOS_CONOCIDOS } from '../src/services/revisionDatosNegocios.js';
import { exigirBaseLocalPruebas } from './lib-db-pruebas.mjs';

test('las 16 coincidencias documentadas requieren nombre y clave exactos', () => {
  assert.equal(FIXTURES_NEGOCIOS_CONOCIDOS.length, 16);
  for (const fixture of FIXTURES_NEGOCIOS_CONOCIDOS) {
    assert.equal(revisionDatosNegocio(fixture).tipo, 'prueba_tecnica');
    assert.equal(revisionDatosNegocio({ ...fixture, nombre: 'Negocio de un cliente' }).tipo, 'sin_senales');
    assert.equal(revisionDatosNegocio({ ...fixture, slug: fixture.slug + '-cliente' }).tipo, 'sin_senales');
  }
});

test('prueba comercial, pocos datos, correo de pruebas o nombre Demo no prueban que un negocio sea ficticio', () => {
  for (const datos of [
    { nombre: 'Café Demo', slug: 'cafe-demo', plan: 'prueba', num_pedidos: 0 },
    { nombre: 'Nonna Maye', slug: 'nonna-maye', plan: 'prueba' },
    { nombre: 'Cliente', slug: 'cliente', admin_email: 'admin@test.local' }, {},
  ]) assert.equal(revisionDatosNegocio(datos).tipo, 'sin_senales');
});

test('el piloto se reconoce sin convertirlo en una prueba desechable', () => {
  const datos = { nombre: 'Xabor Piloto Mario', slug: 'xabor-piloto-mario-f896222eefe4' };
  assert.equal(revisionDatosNegocio(datos).tipo, 'piloto');
  assert.match(revisionDatosNegocio(datos).evidencia, /contrataciones/);
  assert.equal(revisionDatosNegocio({ ...datos, nombre: 'Cliente Mario' }).tipo, 'sin_senales');
});

test('el guardián rechaza Railway, bases reales, URL incompleta y no revela credenciales', () => {
  for (const url of ['postgres://usuario:SECRETO@postgres.railway.internal/test_qa', 'postgres://u:SECRETO@127.0.0.1/railway', 'postgres://u:SECRETO@localhost/production', '', null]) {
    assert.throws(() => exigirBaseLocalPruebas(url), error => error.message.includes('PRUEBAS_DB_RECHAZADA') && !error.message.includes('SECRETO'));
  }
  assert.equal(exigirBaseLocalPruebas('postgres://u:p@127.0.0.1/test_superadmin'), true);
});

test('el ayudante de segundo factor sintético también rechaza una base real antes de importar pg', () => {
  const resultado = spawnSync(process.execPath, ['--input-type=module', '-e', "const m=await import('./test/lib-superadmin-2fa.mjs');await m.cookie2faDe({usuarioId:'qa',tokenSesion:'qa'});"], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgres://u:valor_privado@127.0.0.1/production' } });
  assert.notEqual(resultado.status, 0);
  assert.match(resultado.stderr, /PRUEBAS_DB_RECHAZADA/);
  assert.doesNotMatch(resultado.stderr, /valor_privado/);
});

test('las semillas históricas fallan antes de conectar con una URL productiva', () => {
  for (const archivo of ['seed-datos-prueba.mjs', 'fase-promociones.mjs', 'fase-promo-productos.mjs', 'fase-promo-condiciones-modificadores.mjs', 'fase-promo-guiado-preview.mjs', 'fase-promo-informativa.mjs', 'fase3a-registro-usos-promociones.mjs']) {
    const resultado = spawnSync(process.execPath, ['test/' + archivo], { encoding: 'utf8', env: { ...process.env, DATABASE_URL: 'postgres://u:valor_privado@127.0.0.1/production' } });
    assert.notEqual(resultado.status, 0, archivo);
    assert.match(resultado.stderr, /PRUEBAS_DB_RECHAZADA/, archivo);
    assert.doesNotMatch(resultado.stderr, /valor_privado/);
  }
});
