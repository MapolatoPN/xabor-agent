import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  MENSAJE_FALLO_CONSULTA_PAGO,
  MENSAJE_FALLO_CONSULTA_PAGO_SIN_REVISION,
  responderFalloConsultaPago,
} from '../src/channels/pagoFolioSeguro.js';

const contexto = {
  folio: 'XAB-9998',
  error: new Error('db_no_disponible_prueba'),
  telefono: '528100000000',
  nombreMeta: 'Cliente prueba',
  negocioId: '00000000-0000-0000-0000-000000000001',
  credenciales: { token: 'prueba' },
};

let pasadas = 0;
async function prueba(nombre, fn) {
  await fn();
  pasadas += 1;
  console.log(`  OK ${nombre}`);
}

await prueba('solo afirma revisión cuando la marca durable fue confirmada', async () => {
  const enviados = [];
  const guardados = [];
  const resultado = await responderFalloConsultaPago(contexto, {
    marcarRevision: async () => true,
    enviar: async (_telefono, texto) => { enviados.push(texto); },
    guardar: async (...args) => { guardados.push(args); },
  });

  assert.deepEqual(resultado, { revisionMarcada: true, avisado: true });
  assert.deepEqual(enviados, [MENSAJE_FALLO_CONSULTA_PAGO]);
  assert.equal(guardados[0][3], MENSAJE_FALLO_CONSULTA_PAGO);
});

await prueba('retorno false avisa en neutro y propaga para continuidad', async () => {
  const enviados = [];
  const guardados = [];
  await assert.rejects(
    () => responderFalloConsultaPago(contexto, {
      marcarRevision: async () => false,
      enviar: async (_telefono, texto) => { enviados.push(texto); },
      guardar: async (...args) => { guardados.push(args); },
    }),
    (error) => error?.codigo === 'PAGO_REVISION_NO_CONFIRMADA'
      && error?.cause === contexto.error
      && error?.avisado === true,
  );

  assert.deepEqual(enviados, [MENSAJE_FALLO_CONSULTA_PAGO_SIN_REVISION]);
  assert.equal(guardados[0][3], MENSAJE_FALLO_CONSULTA_PAGO_SIN_REVISION);
  assert.doesNotMatch(enviados[0], /qued[oó]\s+en\s+revisi[oó]n/i);
});

await prueba('excepción al marcar nunca se presenta como revisión exitosa', async () => {
  const falloRevision = new Error('no_se_pudo_pausar');
  const enviados = [];
  await assert.rejects(
    () => responderFalloConsultaPago(contexto, {
      marcarRevision: async () => { throw falloRevision; },
      enviar: async (_telefono, texto) => { enviados.push(texto); },
      guardar: async () => true,
    }),
    (error) => error?.codigo === 'PAGO_REVISION_NO_CONFIRMADA'
      && error?.cause === falloRevision
      && error?.avisado === true,
  );

  assert.deepEqual(enviados, [MENSAJE_FALLO_CONSULTA_PAGO_SIN_REVISION]);
  assert.doesNotMatch(enviados[0], /revisi[oó]n/i);
});

await prueba('un envío aceptado sigue contado aunque falle su auditoría local', async () => {
  const enviados = [];
  await assert.rejects(
    () => responderFalloConsultaPago(contexto, {
      marcarRevision: async () => false,
      enviar: async (_telefono, texto) => { enviados.push(texto); },
      guardar: async () => { throw new Error('guardado_no_disponible'); },
    }),
    (error) => error?.codigo === 'PAGO_REVISION_NO_CONFIRMADA'
      && error?.avisado === true,
  );

  assert.deepEqual(enviados, [MENSAJE_FALLO_CONSULTA_PAGO_SIN_REVISION]);
});

await prueba('el canal no manda una segunda disculpa y propaga a continuidad', () => {
  const canal = readFileSync(new URL('../src/channels/whatsapp-meta.js', import.meta.url), 'utf8');
  const captura = canal.indexOf("error?.codigo === 'PAGO_REVISION_NO_CONFIRMADA'");
  const mensajeGenerico = canal.indexOf('const msgFallo =', captura);
  assert.ok(captura >= 0 && mensajeGenerico > captura,
    'el catch general no intercepta el fallo ya avisado antes de su disculpa genérica');
  assert.match(canal.slice(captura, mensajeGenerico), /error\?\.avisado === true[\s\S]*throw error/);
});

console.log(`\nPago por folio fail-closed: ${pasadas} pruebas pasadas.`);
