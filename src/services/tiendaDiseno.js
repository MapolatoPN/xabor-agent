// ─── Diseño de la tienda en línea, por negocio ─────────────────────────────
//
// La tienda es UNA plantilla para todos los negocios (panel/tienda.html). El
// diseño "v2" (portada con destacados, rejilla de categorías con foto,
// tarjetas con foto arriba, ficha de producto a dos columnas y cotización de
// eventos por WhatsApp) se enciende negocio por negocio, sin redeploy, con
// una fila en `configuracion`:
//
//   clave = 'tienda_diseno'
//   valor = '{"tema":"v2","tipografia":"redonda","whatsappEventos":"528787954683"}'
//
// Sin esa fila (o con cualquier valor que no se entienda) la tienda sigue en
// el diseño clásico, exactamente como antes. Este módulo NUNCA lanza: un error
// de lectura se traduce en "clásico" para que la tienda jamás deje de cargar
// por culpa de su diseño.
//
// Todo lo que sale de aquí va a una API pública y termina pintado en la
// página, así que se filtra con listas blancas: nada de texto libre del
// negocio viaja sin validar.
import { pool } from './database.js';

export const CLAVE_DISENO = 'tienda_diseno';
const TEMAS = new Set(['clasico', 'v2']);
const TIPOGRAFIAS = new Set(['sistema', 'redonda']);

export const DISENO_CLASICO = Object.freeze({ tema: 'clasico', tipografia: 'sistema', eventos: null });

// Normaliza el JSON guardado. Exportada aparte para poder probarla sin base.
export function normalizarDiseno(crudo) {
  let v = crudo;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch { return { ...DISENO_CLASICO }; }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return { ...DISENO_CLASICO };

  const tema = TEMAS.has(v.tema) ? v.tema : 'clasico';
  if (tema === 'clasico') return { ...DISENO_CLASICO };

  const tipografia = TIPOGRAFIAS.has(v.tipografia) ? v.tipografia : 'sistema';
  // Solo dígitos, con lada de país: 10 a 15 dígitos. Cualquier otra cosa
  // apaga el bloque de eventos en vez de armar un enlace roto.
  const wa = String(v.whatsappEventos || '').replace(/\D/g, '');
  const eventos = wa.length >= 10 && wa.length <= 15 ? { whatsapp: wa } : null;

  return { tema, tipografia, eventos };
}

export async function disenoTienda(negocioId) {
  try {
    const { rows } = await pool.query(
      `SELECT valor FROM configuracion WHERE negocio_id = $1 AND clave = $2 LIMIT 1`,
      [negocioId, CLAVE_DISENO]
    );
    return normalizarDiseno(rows[0]?.valor);
  } catch (e) {
    console.error('[Tienda] diseño:', e?.message || e);
    return { ...DISENO_CLASICO };
  }
}
