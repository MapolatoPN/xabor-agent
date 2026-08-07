// Consulta SOLO LECTURA del estado real de las plantillas de repartidores en
// Meta (GET message_templates). No crea, no edita, no somete nada. Nunca
// imprime tokens ni teléfonos. Uso puntual de diagnóstico
// (fase primer-mensaje-repartidores); requiere DATABASE_URL e
// INTEGRATIONS_ENCRYPTION_KEY del entorno real en el ambiente.
import { obtenerNegocioIdPorSlug, obtenerCredencialesWhatsappNegocio, pool } from '../src/services/database.js';

const slug = process.argv[2] || 'nonna-maye';
const negocioId = await obtenerNegocioIdPorSlug(slug);
if (!negocioId) { console.error(`negocio ${slug} no encontrado`); process.exit(1); }

const cred = await obtenerCredencialesWhatsappNegocio(negocioId);
if (!cred?.accessToken) { console.error('sin credenciales resueltas (fail closed)'); process.exit(1); }

// waba_id: primero integraciones_canal, luego configuracion legacy
let wabaId = null;
const r = await pool.query(
  `SELECT waba_id FROM integraciones_canal
   WHERE negocio_id = $1 AND canal = 'whatsapp' AND waba_id IS NOT NULL LIMIT 1`, [negocioId]);
wabaId = r.rows[0]?.waba_id || null;
if (!wabaId) {
  const c = await pool.query(
    `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave IN ('int_wa_waba_id','int_wa_business_id') ORDER BY clave LIMIT 1`, [negocioId]);
  wabaId = c.rows[0]?.valor || null;
}
if (!wabaId) {
  // Fallback solo lectura: los scopes granulares del propio token dicen a
  // qué WABA(s) da acceso (GET debug_token, no modifica nada).
  const dbg = await fetch(`https://graph.facebook.com/v20.0/debug_token?input_token=${encodeURIComponent(cred.accessToken)}`, {
    headers: { Authorization: `Bearer ${cred.accessToken}` }
  });
  const dj = await dbg.json();
  if (dj?.error) console.error('debug_token error:', dj.error.message);
  const scopes = dj?.data?.granular_scopes || [];
  console.log('debug_token: type=' + (dj?.data?.type || '?') + ' scopes=[' +
    (dj?.data?.scopes || []).join(',') + '] granular=[' + scopes.map(s => s.scope + (s.target_ids ? ':' + s.target_ids.length : ':global')).join(',') + ']');
  const ids = scopes.filter(s => /whatsapp_business/.test(s.scope)).flatMap(s => s.target_ids || []);
  wabaId = ids[0] || null;
  if (wabaId) console.log(`wabaId resuelto vía debug_token (scopes whatsapp_business): ${wabaId}`);
}
if (!wabaId) {
  // Segundo fallback solo lectura: negocios del system user → WABAs propias/
  // cliente → la que contenga el phone_number_id configurado.
  const g = async (path) => (await (await fetch(`https://graph.facebook.com/v20.0/${path}`, { headers: { Authorization: `Bearer ${cred.accessToken}` } })).json());
  const biz = await g('me/businesses?limit=25');
  if (biz?.error) console.error('me/businesses error:', biz.error.message);
  console.log(`negocios Meta visibles para el system user: ${biz?.data?.length ?? 0}`);
  const candidatos = [...(biz?.data || [])];
  // Los system users no siempre exponen me/businesses: su negocio dueño
  // viene en el campo `business` del propio nodo.
  const me = await g('me?fields=id,name,business');
  if (me?.business?.id) {
    console.log(`system user "${me.name}" pertenece al negocio Meta "${me.business.name}" (${me.business.id})`);
    if (!candidatos.some(b => b.id === me.business.id)) candidatos.push(me.business);
  }
  for (const b of candidatos) {
    for (const edge of ['owned_whatsapp_business_accounts', 'client_whatsapp_business_accounts']) {
      const wabas = await g(`${b.id}/${edge}?limit=25`);
      for (const w of (wabas?.data || [])) {
        const tels = await g(`${w.id}/phone_numbers?limit=25`);
        const match = (tels?.data || []).some(t => String(t.id) === String(cred.phoneNumberId));
        console.log(` negocio Meta "${b.name}" WABA ${w.id} (${edge}) — contiene el número configurado: ${match}`);
        if (match && !wabaId) wabaId = w.id;
      }
    }
  }
}
if (!wabaId) { console.error('sin waba_id conocido — no se puede consultar message_templates'); process.exit(2); }
console.log(`negocio=${slug} wabaId=${wabaId} (token: resuelto, no se imprime)`);

const resp = await fetch(`https://graph.facebook.com/v20.0/${wabaId}/message_templates?fields=name,status,language,category&limit=100`, {
  headers: { Authorization: `Bearer ${cred.accessToken}` }
});
const data = await resp.json();
if (!resp.ok) { console.error('Meta error:', JSON.stringify(data?.error?.message || data)); process.exit(3); }
const filas = (data.data || []).filter(t => /reparto/i.test(t.name));
console.log(`plantillas con "reparto" (${filas.length} de ${data.data?.length ?? 0} totales):`);
for (const t of filas) console.log(` - ${t.name} | ${t.status} | ${t.language} | ${t.category}`);
const buscadas = ['xabor_nuevo_servicio_reparto', 'xabor_nuevo_servicio_reparto_v2', 'xabor_detalle_servicio_reparto'];
for (const n of buscadas) if (!filas.some(t => t.name === n)) console.log(` - ${n} | INEXISTENTE en este WABA`);
await pool.end();
