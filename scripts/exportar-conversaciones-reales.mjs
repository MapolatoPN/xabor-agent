// ─── EL CORPUS: conversaciones reales, anonimizadas ───────────────────────
//
// Exporta conversaciones Cliente ↔ personal/bot desde `mensajes` para poder
// estudiar cómo escribe la gente de verdad y convertir las buenas en fixtures.
//
//   node scripts/exportar-conversaciones-reales.mjs --negocio <uuid> --dias 30
//   node scripts/exportar-conversaciones-reales.mjs --listar-negocios
//
// ── SOLO LECTURA, y comprobado, no prometido ─────────────────────────────
//
// La conexión se abre con `default_transaction_read_only=on`, así que un
// INSERT o un UPDATE que se colara aquí lo rechazaría POSTGRES, no la buena
// intención de este archivo. Y antes de nada se comprueba que la base es de
// solo lectura de verdad; si no lo es, se aborta.
//
// ── Contra qué base se corre ─────────────────────────────────────────────
//
// Para producción hace falta `DATABASE_PUBLIC_URL`: el `DATABASE_URL` de la
// app de Railway es la red interna y no se alcanza desde fuera. Sin ninguna de
// las dos, el script no adivina: dice qué falta y sale.
//
// ── Anonimización ────────────────────────────────────────────────────────
//
// Teléfono, dirección, correo, coordenadas y enlaces se van antes de que nada
// se escriba en disco. El teléfono se sustituye por un seudónimo ESTABLE
// —`cli_<10 hex>`— derivado con HMAC de una sal que se pasa por entorno: con
// la misma sal, la misma persona es el mismo seudónimo entre exportaciones, y
// sin la sal no se puede volver atrás.
//
// ── Lo que NO hace, a propósito ──────────────────────────────────────────
//
// No entrena nada, no reescribe nada y no promueve nada a fixture solo. Cada
// conversación sale CLASIFICADA y la promoción es una decisión humana:
//
//   buena         terminó en pedido, sin escalar y sin corregirse
//   dudosa        acabó sin pedido y sin queja: puede ser un abandono normal
//   error_humano  hubo escalado o el negocio tuvo que rehacer algo
//   obsoleta      menciona productos que hoy NO están en la carta
//
// Lo último importa más de lo que parece: una conversación de hace tres meses
// puede pedir un platillo que ya no existe, y convertirla en fixture sería
// escribir una prueba que exige algo imposible.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHmac } from 'node:crypto';
import pg from 'pg';

const AQUI = dirname(fileURLToPath(import.meta.url));
const SALIDA = join(AQUI, '..', 'corpus');

const args = process.argv.slice(2);
const opt = (n, d = null) => (args.includes(n) ? args[args.indexOf(n) + 1] : d);
const negocioId = opt('--negocio');
const dias = Number(opt('--dias', '30'));
const limite = Number(opt('--limite', '500'));
const listar = args.includes('--listar-negocios');

const cadena = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
if (!cadena) {
  console.error('Falta DATABASE_PUBLIC_URL (o DATABASE_URL para una base local).\n'
    + 'Para producción NO sirve el DATABASE_URL de la app: es la red interna de Railway\n'
    + 'y no se alcanza desde fuera. En el panel de Railway, la variable pública del\n'
    + 'servicio Postgres es DATABASE_PUBLIC_URL.');
  process.exit(2);
}

const SAL = process.env.CORPUS_SALT;
if (!SAL && !listar) {
  console.error('Falta CORPUS_SALT: la sal del seudónimo. Sin ella los seudónimos no serían\n'
    + 'estables entre exportaciones, o —peor— serían reversibles con un diccionario de\n'
    + 'teléfonos. Una cadena larga cualquiera sirve; lo que importa es guardarla.');
  process.exit(2);
}

const db = new pg.Client({ connectionString: cadena, ssl: { rejectUnauthorized: false } });

// ── Anonimización ────────────────────────────────────────────────────────
const seudonimo = (telefono) => `cli_${createHmac('sha256', SAL)
  .update(String(telefono || '')).digest('hex').slice(0, 10)}`;

const RE_TELEFONO = /(\+?\d[\d\s().-]{7,}\d)/g;
const RE_EMAIL = /\b[\w.+-]+@[\w-]+\.[\w.]{2,}\b/gi;
const RE_ENLACE = /\bhttps?:\/\/\S+/gi;
const RE_COORD = /-?\d{1,3}\.\d{4,}\s*,\s*-?\d{1,3}\.\d{4,}/g;
// Una dirección mexicana escrita a mano: una vía y un número. Es generoso a
// propósito — tapar de más en un corpus es barato; filtrar de menos, no.
const RE_DIRECCION = new RegExp(
  '\\b(calle|av\\.?|avenida|blvd\\.?|boulevard|calz\\.?|calzada|priv\\.?|privada|'
  + 'and\\.?|andador|cda\\.?|cerrada|carr\\.?|carretera|col\\.?|colonia|fracc\\.?|'
  + 'fraccionamiento|manzana|mz\\.?|lote|lt\\.?|depto\\.?|departamento|int\\.?|ext\\.?)'
  + '[^\\n,;.]{0,60}', 'gi');

export function anonimizar(texto) {
  return String(texto || '')
    .replace(RE_EMAIL, '[EMAIL]')
    .replace(RE_ENLACE, '[ENLACE]')
    .replace(RE_COORD, '[COORDENADAS]')
    .replace(RE_DIRECCION, '[DIRECCION]')
    .replace(RE_TELEFONO, (m) => (m.replace(/[^0-9]/g, '').length >= 8 ? '[TELEFONO]' : m));
}

// ── Clasificación ────────────────────────────────────────────────────────
const PIDE_HUMANO = /\bhumano\b|\bpersona\b|\bencargad|\bgerente\b|\bdue[ñn]/i;
const QUEJA = /\bqueja\b|\breclam|\bmal\b|\bfrio\b|\bfr[ií]o\b|\bno lleg|\btard/i;

export function clasificar(turnos, nombresDeLaCarta) {
  const texto = turnos.map((t) => t.texto).join(' ').toLowerCase();
  const hayPedido = turnos.some((t) => /\bXAB-\d+/i.test(t.texto));
  const escalo = turnos.some((t) => t.de === 'cliente' && (PIDE_HUMANO.test(t.texto) || QUEJA.test(t.texto)));

  // ¿Menciona algo que hoy NO está en la carta? Se mide al revés de como
  // parece: se buscan los productos ACTUALES; si no aparece ninguno y la
  // conversación fue larga, es candidata a obsoleta.
  const mencionaActuales = (nombresDeLaCarta || []).some((n) => {
    const primera = String(n).toLowerCase().split(/\s+/)[0];
    return primera.length > 3 && texto.includes(primera);
  });

  if (escalo) return 'error_humano';
  if (hayPedido && !mencionaActuales) return 'obsoleta';
  if (hayPedido) return 'buena';
  return 'dudosa';
}

try {
  await db.connect();
  // Solo lectura de verdad: lo hace cumplir Postgres, no este archivo.
  await db.query('SET default_transaction_read_only = on');
  const { rows: [chequeo] } = await db.query('SHOW default_transaction_read_only');
  if (chequeo.default_transaction_read_only !== 'on') {
    throw new Error('no se pudo poner la sesión en solo lectura — se aborta antes de leer nada');
  }

  if (listar) {
    const { rows } = await db.query(
      `SELECT n.id, n.nombre, count(m.id)::int AS mensajes,
              max(m."timestamp") AS ultimo
         FROM negocios n LEFT JOIN mensajes m ON m.negocio_id = n.id
        GROUP BY n.id, n.nombre ORDER BY mensajes DESC LIMIT 30`);
    for (const r of rows) console.log(`${r.id}  ${String(r.nombre).padEnd(28)} ${String(r.mensajes).padStart(7)}  ${r.ultimo || '-'}`);
    process.exit(0);
  }

  if (!negocioId) {
    console.error('Falta --negocio <uuid>. Usa --listar-negocios para verlos.');
    process.exit(2);
  }

  const { rows: carta } = await db.query(
    `SELECT p.nombre FROM menu_productos p
      JOIN menu_categorias c ON c.id = p.categoria_id
     WHERE p.negocio_id = $1 AND c.activa = TRUE`, [negocioId]);
  const nombresDeLaCarta = carta.map((r) => r.nombre);

  const { rows } = await db.query(
    `SELECT telefono, texto, origen, "timestamp"
       FROM mensajes
      WHERE negocio_id = $1
        AND "timestamp" > now() - ($2 || ' days')::interval
        AND texto IS NOT NULL AND btrim(texto) <> ''
      ORDER BY telefono, "timestamp"`, [negocioId, String(dias)]);

  // Se agrupan por teléfono y se cortan en huecos de más de seis horas: dos
  // pedidos de días distintos no son una conversación.
  const porTelefono = new Map();
  for (const r of rows) {
    if (!porTelefono.has(r.telefono)) porTelefono.set(r.telefono, []);
    porTelefono.get(r.telefono).push(r);
  }

  const conversaciones = [];
  for (const [telefono, mensajes] of porTelefono) {
    let actual = [];
    let anterior = null;
    const cerrar = () => {
      if (actual.length >= 2) conversaciones.push({ telefono, mensajes: actual });
      actual = [];
    };
    for (const m of mensajes) {
      const t = new Date(m.timestamp).getTime();
      if (anterior !== null && t - anterior > 6 * 3600 * 1000) cerrar();
      actual.push(m);
      anterior = t;
    }
    cerrar();
  }

  const salida = conversaciones.slice(0, limite).map((c, i) => {
    const turnos = c.mensajes.map((m) => ({
      de: m.origen === 'entrante' || m.origen === 'cliente' ? 'cliente' : (m.origen === 'bot' ? 'bot' : 'negocio'),
      texto: anonimizar(m.texto),
      ts: new Date(m.timestamp).toISOString(),
    }));
    return {
      id: `real-${String(i + 1).padStart(4, '0')}`,
      cliente: seudonimo(c.telefono),
      negocio: negocioId,
      clase: clasificar(turnos, nombresDeLaCarta),
      turnos,
    };
  });

  mkdirSync(SALIDA, { recursive: true });
  const archivo = join(SALIDA, `conversaciones-${negocioId.slice(0, 8)}-${dias}d.json`);
  writeFileSync(archivo, `${JSON.stringify({
    generado: new Date().toISOString(),
    negocio: negocioId,
    dias,
    total: salida.length,
    // Sin un recordatorio aquí, el primer uso del corpus será entrenar con todo.
    aviso: 'Anonimizado. NO se promueve nada a fixture sin revisarlo: las clases '
      + '"dudosa", "error_humano" y "obsoleta" describen conversaciones que NO son ejemplo de nada.',
    por_clase: salida.reduce((a, c) => ({ ...a, [c.clase]: (a[c.clase] || 0) + 1 }), {}),
    conversaciones: salida,
  }, null, 2)}\n`, 'utf8');

  console.log(`${salida.length} conversaciones -> ${archivo}`);
  for (const [k, v] of Object.entries(salida.reduce((a, c) => ({ ...a, [c.clase]: (a[c.clase] || 0) + 1 }), {}))) {
    console.log(`  ${k.padEnd(14)} ${v}`);
  }
  // Una comprobación final, porque una fuga aquí no se puede deshacer.
  //
  // Se mira SOLO el texto de los turnos: los sellos de tiempo son ISO
  // (`2026-09-20T…`) y el detector de teléfonos los cuenta como números largos.
  // Auditar el JSON entero daba veintiún «teléfonos» que eran fechas, y una
  // alarma que siempre suena es una alarma que se deja de mirar.
  const crudo = salida.flatMap((c) => c.turnos.map((t) => t.texto)).join('\n');
  const sospechas = (crudo.match(RE_TELEFONO) || []).filter((m) => m.replace(/[^0-9]/g, '').length >= 8);
  if (sospechas.length) {
    console.error(`\n> AVISO: ${sospechas.length} cadenas siguen pareciendo teléfonos. Revísalas ANTES de compartir el archivo.`);
    process.exitCode = 1;
  }
} catch (e) {
  console.error('[corpus] FALLO:', e.message);
  process.exitCode = 1;
} finally {
  await db.end().catch(() => {});
}
