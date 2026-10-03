// Operación explícita del dueño: registra en el número de WhatsApp de un
// negocio la clave pública de los formularios (Flows), derivada de la privada
// que YA usa el servidor (WHATSAPP_FLOW_PRIVATE_KEY). Nunca genera ni cambia la
// privada: es una sola para todos los negocios y cambiarla rompería los
// formularios que ya funcionan. Se corre dentro del contenedor (railway ssh).
//
//   node scripts/registrar-cifrado-flow-numero.mjs <negocioId> verificar   (solo lectura)
//   node scripts/registrar-cifrado-flow-numero.mjs <negocioId> registrar
import assert from 'node:assert/strict';
import { createPublicKey, createHash } from 'node:crypto';
import { credencialFlows, clienteMetaFlows } from './lib-meta-flows.mjs';

const [negocioId, modo] = process.argv.slice(2);
assert.match(negocioId || '', /^[0-9a-f-]{36}$/, 'negocio inválido');
assert(['verificar', 'registrar'].includes(modo), 'Modo: verificar | registrar');
const privada = process.env.WHATSAPP_FLOW_PRIVATE_KEY;
assert(privada, 'Falta WHATSAPP_FLOW_PRIVATE_KEY en el proceso');
const publica = createPublicKey(privada).export({ type: 'spki', format: 'pem' });
const huella = (k) => createHash('sha256').update(createPublicKey(k).export({ type: 'spki', format: 'der' })).digest('hex');

try {
  const cred = await credencialFlows(negocioId), api = clienteMetaFlows(cred.token);
  const numeros = await api(`${cred.wabaId}/phone_numbers?fields=id&limit=100`);
  assert(numeros.data.some((p) => p.id === cred.phoneId), 'El número no pertenece a la WABA del negocio');
  const antes = await api(`${cred.phoneId}/whatsapp_business_encryption`);
  assert((antes.data?.length || 0) <= 1, 'El número tiene más de una clave: requiere revisión');
  const existente = String(antes.data?.[0]?.business_public_key || '').trim();
  if (existente) assert.equal(huella(existente), huella(publica), 'El número ya tiene OTRA clave pública: no reemplazarla sin revisión');
  if (modo === 'registrar' && !existente) {
    const body = new FormData(); body.set('business_public_key', publica);
    const r = await api(`${cred.phoneId}/whatsapp_business_encryption`, { method: 'POST', body });
    assert.equal(r.success, true);
  }
  const final = modo === 'registrar' ? await api(`${cred.phoneId}/whatsapp_business_encryption`) : antes;
  const fila = final.data?.[0];
  if (modo === 'registrar') {
    assert(fila, 'Meta no devolvió la clave registrada');
    assert.equal(huella(fila.business_public_key), huella(publica));
    assert.equal(fila.business_public_key_signature_status, 'VALID', 'Meta no validó la firma de la clave');
  }
  console.log(JSON.stringify({ negocioId, modo, publicaSha256: huella(publica),
    registradaEnMeta: !!fila, coincide: fila ? huella(fila.business_public_key) === huella(publica) : null,
    estadoMeta: fila?.business_public_key_signature_status ?? null, privadaCambiada: false }));
} catch (e) { console.error('FALLA:', e.message); process.exitCode = 1; }
