// Escritura explícita en Meta: sube la maqueta de la tienda (tienda_v1) como
// BORRADOR a la WABA del negocio y devuelve la liga de vista previa para
// abrirla en el teléfono. Cada corrida en modo «subir» necesita la
// autorización del dueño en ese momento (la del 3-oct-2026 fue para esa vez).
// Nunca publica, nunca envía mensajes y no toca la configuración del negocio:
// un borrador no le llega a ningún cliente. La BD solo se lee (credencialFlows).
//
//   node scripts/subir-maqueta-flow-tienda.mjs <negocio> <A|B> <maqueta.json[.gz]> <verificar|subir> "<cuenta esperada>"
//
// Cada variante vive en UN solo Flow de nombre fijo (xabor_tienda_maqueta_A/B):
// subir otra versión reemplaza el flow.json del mismo borrador, así no se
// acumulan borradores en la cuenta. Si ese Flow ya no es borrador, se detiene.
// «verificar» solo lee (cuenta, número y Flows existentes) y no escribe nada.
// Antes de escribir exige que el nombre verificado del número sea la cuenta
// esperada: un UUID equivocado no escribe en la WABA de otro negocio.
// Antes de tocar la red, la maqueta debe pasar validarFlowTienda (los mismos
// límites que check-flow-tienda.mjs, incluido el esquema tipado que Meta exige).
//
// Corre dentro del contenedor desplegado (ahí viven DATABASE_URL y la llave de
// cifrado) o en local con esas variables: los imports son relativos a scripts/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { pathToFileURL } from 'node:url';
import { credencialFlows, clienteMetaFlows } from './lib-meta-flows.mjs';
import { validarFlowTienda, cabeComoMaqueta, LIMITES_TIENDA } from './definicion-flow-tienda.mjs';

export const nombreMaqueta = (variante) => `xabor_tienda_maqueta_${variante}`;

/** El JSON de la maqueta, o lanza: sin servidor no puede pedir data_exchange y debe pasar el validador. */
export function leerMaqueta(ruta) {
  const crudo = readFileSync(ruta);
  const texto = (ruta.endsWith('.gz') ? gunzipSync(crudo) : crudo).toString('utf8');
  const flow = JSON.parse(texto);
  assert.equal(typeof flow.version, 'string', 'Falta version');
  assert(Array.isArray(flow.screens) && flow.screens.length, 'Sin pantallas');
  // Un Flow sin endpoint no puede pedir datos al servidor.
  assert(!('data_api_version' in flow), 'La maqueta no lleva endpoint');
  assert(!texto.includes('"data_exchange"'), 'La maqueta no puede pedir data_exchange');
  assert(flow.screens.some((s) => s.id === 'FIN_MAQUETA'), 'No es la maqueta de la tienda');
  const errores = validarFlowTienda(flow, { endpoint: false });
  assert.equal(errores.length, 0, `La maqueta no pasa el validador: ${errores.slice(0, 5).join(' | ')}`);
  assert(cabeComoMaqueta(flow), `La maqueta pasa del tope de maqueta (${LIMITES_TIENDA.maquetaJson} bytes)`);
  return texto;
}

async function main() {
  const [negocioId, variante, ruta, modo, cuentaEsperada] = process.argv.slice(2);
  assert(['A', 'B'].includes(variante), 'Variante: A o B');
  assert(['subir', 'verificar'].includes(modo), 'Modo explícito: verificar o subir');
  assert(cuentaEsperada, 'Falta la cuenta esperada (nombre verificado del número)');
  assert(ruta, 'Falta el archivo de la maqueta');
  const json = leerMaqueta(ruta);
  const cred = await credencialFlows(negocioId), api = clienteMetaFlows(cred.token);
  const phones = await api(`${cred.wabaId}/phone_numbers?fields=id,display_phone_number,verified_name&limit=100`);
  const numero = phones.data.find((p) => p.id === cred.phoneId);
  assert(numero, 'El número debe pertenecer a la WABA');
  assert.equal(numero.verified_name, cuentaEsperada, 'La cuenta resuelta no es la esperada: no se escribe');
  const name = nombreMaqueta(variante);
  const existentes = await api(`${cred.wabaId}/flows?fields=id,name,status&limit=100`);
  const iguales = existentes.data.filter((x) => x.name === name);
  assert(iguales.length <= 1, `Hay ${iguales.length} Flows llamados ${name}: revisar a mano`);
  let f = iguales[0];
  if (modo === 'verificar') {
    console.log(JSON.stringify({ modo, variante, cuenta: numero.verified_name, flows_en_cuenta: existentes.data.length,
      paginado: !!existentes.paging?.next, existente: f || null, bytes: Buffer.byteLength(json) }));
    return;
  }
  // El listado de 100 podría no traer el borrador si la cuenta tiene más: no crear un duplicado a ciegas.
  assert(f || !existentes.paging?.next, 'La cuenta tiene más de 100 Flows: buscar el borrador a mano antes de crear otro');
  if (!f) {
    f = await api(`${cred.wabaId}/flows`, { method: 'POST', body: new URLSearchParams({ name, categories: '["OTHER"]' }) });
    f.status = 'DRAFT';
  }
  // Solo un borrador se reescribe; un Flow publicado no se toca jamás.
  assert.equal(f.status, 'DRAFT', `${name} ya no es borrador (${f.status}): no se sobrescribe`);
  const body = new FormData();
  body.set('name', 'flow.json'); body.set('asset_type', 'FLOW_JSON');
  body.set('file', new Blob([json], { type: 'application/json' }), 'flow.json');
  const r = await api(`${f.id}/assets`, { method: 'POST', body });
  const actual = await api(`${f.id}?fields=id,name,status,validation_errors`);
  // Se imprime antes de la vista previa: si esa llamada falla, el id y los errores no se pierden.
  console.log(JSON.stringify({ variante, id: f.id, name, status: actual.status, cuenta: numero.verified_name, bytes: Buffer.byteLength(json),
    errores_al_subir: r.validation_errors || [], errores: actual.validation_errors || [] }));
  assert.equal(actual.status, 'DRAFT', 'El Flow dejó de ser borrador');
  if ((actual.validation_errors || []).length) { process.exitCode = 1; return; }
  // La vista previa se pide con fetch propio: la ruta lleva paréntesis que el
  // cliente común no admite. invalidate(true) da una liga nueva que refleja el
  // JSON recién subido y anula la anterior. El token nunca se imprime.
  const resp = await fetch(`https://graph.facebook.com/v20.0/${f.id}?fields=${encodeURIComponent('preview.invalidate(true)')}`,
    { headers: { Authorization: `Bearer ${cred.token}` }, signal: AbortSignal.timeout(30000) });
  const vista = await resp.json();
  if (!resp.ok) throw Error(`Meta ${resp.status} código ${vista.error?.code}: ${String(vista.error?.message || '').replaceAll(cred.token, '[secreto]')}`);
  console.log(JSON.stringify({ variante, id: f.id, vista_previa: vista.preview?.preview_url || null, vence: vista.preview?.expires_at || null,
    retirar: `GET /${f.id}?fields=preview.invalidate(true) anula la liga; DELETE /${f.id} borra el borrador` }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error('FALLA:', e.message); process.exitCode = 1; });
}
