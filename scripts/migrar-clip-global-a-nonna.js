// ─── Migración única: Clip global -> integración Clip propia de Nonna Maye ──
// (Incidente P0, seguimiento del fix de aislamiento multiempresa)
//
// Contexto: el fix de aislamiento (fix/p0-aislamiento-pedidos-comandas-pagos)
// eliminó correctamente la lectura de CLIP_API_KEY/CLIP_API_SECRET como
// variables GLOBALES en clip-api.js -- ese era el mecanismo que permitía que
// cualquier negocio (incluida Alora) generara enlaces con la cuenta Clip de
// Nonna Maye. Pero esas mismas dos variables SON las credenciales reales de
// Nonna Maye, que hasta ahora nunca se habían migrado a la integración por
// negocio (integraciones_canal/integraciones_canal_credenciales). Este
// script hace esa migración UNA sola vez, sin reabrir ningún fallback
// global: lee las variables directamente de process.env dentro del propio
// proceso (nunca las imprime, nunca las expone en argumentos de comandos
// hijos) y las guarda cifradas exclusivamente en la fila de Nonna Maye.
//
// Requiere explícitamente MIGRAR_CLIP_GLOBAL_A_NONNA=true para correr --
// nunca se ejecuta por accidente. Idempotente: si Nonna Maye ya tiene una
// integración Clip activa, se detiene sin sobrescribir ni duplicar.
//
// Uso (las credenciales viajan solas dentro del proceso de Railway, nunca
// pasan por la terminal del operador):
//   railway run --service xabor-agent \
//     node scripts/migrar-clip-global-a-nonna.js MIGRAR_CLIP_GLOBAL_A_NONNA=true

import 'dotenv/config';
import { pool, obtenerNegocioIdPorSlug } from '../src/services/database.js';
import { guardarCredencialesClip, obtenerCredencialesClipDescifradas } from '../src/services/integracionesService.js';
import { registrarAuditoriaPlataforma } from '../src/services/database.js';

function abortar(msg) {
  console.error(`[migrar-clip-global-a-nonna] ❌ ${msg}`);
  process.exit(1);
}

const activado = process.env.MIGRAR_CLIP_GLOBAL_A_NONNA === 'true';
if (!activado) {
  abortar("Requiere MIGRAR_CLIP_GLOBAL_A_NONNA=true explícito. No se ejecutó nada.");
}

// Nunca se leen desde argv (evita que queden en el historial de la shell o
// en `ps`) -- solo desde el entorno del propio proceso, inyectado por
// `railway run` a partir de las variables ya configuradas en el servicio.
const apiKey = process.env.CLIP_API_KEY;
const apiSecret = process.env.CLIP_API_SECRET;

try {
  if (typeof apiKey !== 'string' || !apiKey.trim()) abortar('CLIP_API_KEY no está definida o está vacía en este entorno.');
  if (typeof apiSecret !== 'string' || !apiSecret.trim()) abortar('CLIP_API_SECRET no está definida o está vacía en este entorno.');

  const negocioId = await obtenerNegocioIdPorSlug('nonna-maye');
  if (!negocioId) abortar("No existe ningún negocio con slug 'nonna-maye'. No se escribió nada.");

  // auditoria_plataforma.superadmin_id es NOT NULL -- este script no corre
  // con una sesión real, así que se atribuye al primer administrador de
  // plataforma activo (actor técnico), nunca a un usuario inventado.
  const { rows: admins } = await pool.query(
    `SELECT usuario_id FROM administradores_plataforma WHERE activo = true ORDER BY created_at ASC LIMIT 1`
  );
  const actorTecnico = admins[0]?.usuario_id;
  if (!actorTecnico) abortar('No se encontró ningún administrador de plataforma activo para atribuir la auditoría. No se escribió nada.');

  const { rows: existentes } = await pool.query(
    `SELECT estado FROM integraciones_canal WHERE negocio_id = $1 AND canal = 'pagos' AND proveedor = 'clip'`,
    [negocioId]
  );
  if (existentes[0]) {
    console.log(`[migrar-clip-global-a-nonna] Integración Clip ya existe para Nonna Maye (estado='${existentes[0].estado}') -- no se sobrescribe. No se hizo ningún cambio.`);
    process.exit(0);
  }

  const resultado = await guardarCredencialesClip(negocioId, apiKey, apiSecret, actorTecnico);

  // Verificación de lectura cifrada (Fase 3, punto 8): solo se considera
  // exitosa la migración si el descifrado posterior realmente funciona.
  const verificacion = await obtenerCredencialesClipDescifradas(negocioId);
  const descifradoOk = !!(verificacion && verificacion.apiKey && verificacion.apiSecret);
  if (!descifradoOk) {
    abortar('La integración se guardó pero el descifrado posterior falló -- revisar INTEGRATIONS_ENCRYPTION_KEY. No se marca como exitosa.');
  }

  await registrarAuditoriaPlataforma({
    superadminId: actorTecnico,
    accion: 'migrar_credenciales_clip_globales',
    negocioId,
    estadoNuevo: { estado: resultado.estado, canal: 'pagos', proveedor: 'clip' },
    contexto: { origen: 'variables_globales_railway', script: 'migrar-clip-global-a-nonna.js' },
  });

  console.log(`[migrar-clip-global-a-nonna] ✅ Integración Clip creada para Nonna Maye (negocioId=${negocioId}, integracionId=${resultado.id}, estado='${resultado.estado}'). Descifrado verificado.`);
} catch (e) {
  abortar(e.message);
} finally {
  await pool.end();
}
