// ─── Crear terminal de impresión con credencial autenticada ────────────────
// Script MANUAL — nunca se ejecuta automáticamente en el arranque del
// servidor ni en ninguna migración. Crea (o valida) la sucursal indicada de
// un negocio ya existente, crea una terminal de tipo 'impresora' y emite un
// token criptográficamente seguro para /ws/print-agent. Muestra el token en
// claro UNA sola vez -- no queda guardado en ningún archivo del
// repositorio ni en la base de datos (solo su hash SHA-256).
//
// Esta herramienta se escribió pensando en el piloto Nonna Maye, pero NO
// asume ningún negocio por defecto: --negocio-slug es siempre obligatorio,
// sin fallback, igual que --sucursal-nombre/--terminal-nombre/
// --terminal-codigo. No crea sucursales silenciosamente (requiere
// --crear-sucursal explícito) ni reutiliza/regenera una terminal existente
// (si ya existe una con el mismo nombre o código, se detiene sin mostrar
// ningún token -- ver tools/regenerar-token-terminal.mjs, todavía no
// implementada, para ese caso).
//
// Uso:
//   DATABASE_URL='postgresql://usuario:pass@localhost:5432/xabor' \
//   node scripts/crear-terminal-impresion.js \
//     --negocio-slug nonna-maye \
//     --sucursal-nombre "Piedras Negras" \
//     --terminal-nombre "Cocina impresora" \
//     --terminal-codigo "IMPRESORA-01"
//
// Flags opcionales:
//   --crear-sucursal     Crea la sucursal si no existe (si se omite y la
//                        sucursal no existe, la herramienta se detiene).
//   --dry-run            Solo consulta y valida; no crea nada, no genera
//                        ningún token real, no modifica la base de datos.
//   --allow-production   Permite conectar a un host que no sea local
//                        (localhost/127.0.0.1/::1) o que coincida con un
//                        dominio de producción conocido (Railway). Por
//                        defecto la herramienta SIEMPRE se niega a correr
//                        contra un host remoto o con NODE_ENV=production,
//                        sin excepción para este último caso.
//
// Regeneración de token: deliberadamente NO implementada aquí. Si una
// terminal ya existe y necesita un nuevo token, esa es responsabilidad de
// una herramienta separada y futura (tools/regenerar-token-terminal.mjs),
// para no mezclar "crear" con "rotar credenciales" en el mismo flujo.

import 'dotenv/config';
import { randomBytes, createHash } from 'crypto';
import { pool } from '../src/services/database.js';

function abortar(msg) {
  console.error(`[crear-terminal-impresion] ❌ ${msg}`);
  process.exitCode = 1;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const siguiente = argv[i + 1];
    if (siguiente !== undefined && !siguiente.startsWith('--')) {
      args[key] = siguiente;
      i++;
    } else {
      args[key] = true;
    }
  }
  return args;
}

function esHostLocal(urlStr) {
  try {
    const u = new URL(urlStr);
    return ['localhost', '127.0.0.1', '::1'].includes(u.hostname);
  } catch {
    return false;
  }
}
function pareceProduccionConocida(urlStr) {
  return /railway\.app|rlwy\.net|proxy\.rlwy/i.test(urlStr);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const negocioSlug     = typeof args['negocio-slug'] === 'string' ? args['negocio-slug'] : null;
  const sucursalNombre  = typeof args['sucursal-nombre'] === 'string' ? args['sucursal-nombre'] : null;
  const terminalNombre  = typeof args['terminal-nombre'] === 'string' ? args['terminal-nombre'] : null;
  const terminalCodigo  = typeof args['terminal-codigo'] === 'string' ? args['terminal-codigo'] : null;
  const crearSucursal   = args['crear-sucursal'] === true;
  const dryRun          = args['dry-run'] === true;
  const allowProduction = args['allow-production'] === true;

  if (!negocioSlug)    return abortar('Falta --negocio-slug (obligatorio; no hay negocio por defecto).');
  if (!sucursalNombre) return abortar('Falta --sucursal-nombre (obligatorio; no se asume "primera sucursal" ni "Principal").');
  if (!terminalNombre) return abortar('Falta --terminal-nombre (obligatorio).');
  if (!terminalCodigo) return abortar('Falta --terminal-codigo (obligatorio).');

  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) return abortar('Falta DATABASE_URL.');

  if (process.env.NODE_ENV === 'production') {
    return abortar('NODE_ENV=production detectado -- esta herramienta nunca corre en producción, sin excepción (ni siquiera con --allow-production).');
  }
  if ((!esHostLocal(dbUrl) || pareceProduccionConocida(dbUrl)) && !allowProduction) {
    return abortar(
      'DATABASE_URL no apunta a un host local (localhost/127.0.0.1/::1) o coincide con un dominio de producción conocido (Railway). ' +
      'Esta herramienta se niega a correr ahí por defecto. Si de verdad necesitas conectar a un host remoto, vuelve a ejecutar con ' +
      '--allow-production (bajo tu propio riesgo) -- pero no lo hagas en esta ronda.'
    );
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Resolver negocio -- exactamente una fila, exige activo, nunca
    // crea negocios ni elige "el primero".
    const { rows: negRows } = await client.query(
      'SELECT id, nombre, slug, activo FROM negocios WHERE slug = $1',
      [negocioSlug]
    );
    if (negRows.length === 0) throw new Error(`No existe ningún negocio con slug '${negocioSlug}'.`);
    const negocio = negRows[0];
    if (!negocio.activo) throw new Error(`El negocio '${negocioSlug}' existe pero está inactivo (activo=false) -- no se puede continuar.`);

    // 2. Resolver o crear sucursal -- nunca silenciosamente.
    const { rows: sucRows } = await client.query(
      'SELECT id, nombre, activo FROM sucursales WHERE negocio_id = $1 AND nombre = $2',
      [negocio.id, sucursalNombre]
    );
    let sucursal;
    let sucursalEsNueva = false;
    if (sucRows.length > 0) {
      sucursal = sucRows[0];
      if (!sucursal.activo) {
        throw new Error(`La sucursal '${sucursalNombre}' de '${negocioSlug}' existe pero está inactiva -- no se puede continuar.`);
      }
    } else {
      if (!crearSucursal) {
        throw new Error(
          `No existe una sucursal llamada '${sucursalNombre}' para '${negocioSlug}'. ` +
          `Vuelve a ejecutar con --crear-sucursal si quieres crearla, o usa el nombre exacto de una sucursal ya existente.`
        );
      }
      sucursalEsNueva = true;
      if (dryRun) {
        sucursal = { id: null, nombre: sucursalNombre, activo: true };
      } else {
        const { rows: nuevaSuc } = await client.query(
          'INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, $2) RETURNING id, nombre, activo',
          [negocio.id, sucursalNombre]
        );
        sucursal = nuevaSuc[0];
      }
    }

    // 3. Validar nombre/código de la terminal.
    if (typeof terminalNombre !== 'string' || terminalNombre.trim() === '') {
      throw new Error('--terminal-nombre debe ser un string no vacío.');
    }
    if (typeof terminalCodigo !== 'string' || terminalCodigo.trim() === '') {
      throw new Error('--terminal-codigo debe ser un string no vacío.');
    }

    // 4. Comprobar duplicados dentro de la sucursal -- solo si la sucursal
    // ya tiene un id real (no aplica al caso dry-run + sucursal inexistente,
    // donde no hay ninguna fila real contra la que comparar).
    if (sucursal.id) {
      const { rows: dupNombre } = await client.query(
        'SELECT id FROM terminales WHERE sucursal_id = $1 AND nombre = $2',
        [sucursal.id, terminalNombre]
      );
      if (dupNombre.length > 0) {
        throw new Error(
          `Ya existe una terminal llamada '${terminalNombre}' en esa sucursal (id=${dupNombre[0].id}). ` +
          `No se muestra ningún token. Esta herramienta no regenera tokens de terminales existentes.`
        );
      }
      const { rows: dupCodigo } = await client.query(
        'SELECT id FROM terminales WHERE sucursal_id = $1 AND codigo = $2',
        [sucursal.id, terminalCodigo]
      );
      if (dupCodigo.length > 0) {
        throw new Error(
          `Ya existe una terminal con código '${terminalCodigo}' en esa sucursal (id=${dupCodigo[0].id}). ` +
          `No se muestra ningún token.`
        );
      }
    }

    if (dryRun) {
      console.log('[crear-terminal-impresion] (dry-run) Validaciones OK -- no se creó nada, no se generó ningún token real:');
      console.log(`  negocio:   ${negocio.nombre} (${negocio.slug})`);
      console.log(`  sucursal:  ${sucursalNombre}${sucursalEsNueva ? ' (se crearía -- no existe todavía)' : ' (ya existe, se reutilizaría)'}`);
      console.log(`  terminal:  ${terminalNombre} (código: ${terminalCodigo}) -- se crearía`);
      await client.query('ROLLBACK');
      return;
    }

    // 5. Generar token -- 256 bits de entropía real, nunca se guarda en
    // claro. Solo su hash SHA-256 (hex) va a la base de datos.
    const token = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    // 6. Insertar terminal.
    const { rows: nuevaTerm } = await client.query(
      `INSERT INTO terminales (sucursal_id, nombre, codigo, activo, tipo, token_hash, ultima_conexion)
       VALUES ($1, $2, $3, true, 'impresora', $4, NULL)
       RETURNING id`,
      [sucursal.id, terminalNombre, terminalCodigo, tokenHash]
    );
    const terminalId = nuevaTerm[0].id;

    await client.query('COMMIT');

    // Mostrar el token en claro UNA sola vez. Nunca se vuelve a consultar
    // ni se muestra el hash (no es necesario para operar el agente).
    console.log('\n[crear-terminal-impresion] ✅ Terminal creada correctamente.');
    console.log(`  negocio:     ${negocio.nombre} (${negocio.slug})`);
    console.log(`  sucursal:    ${sucursal.nombre}${sucursalEsNueva ? ' (recién creada)' : ''}`);
    console.log(`  terminalId:  ${terminalId}`);
    console.log(`  nombre:      ${terminalNombre}`);
    console.log(`  código:      ${terminalCodigo}`);
    console.log(`  token:       ${token}`);
    console.log('\n⚠ Este token no se puede recuperar después. Guárdalo ahora en un administrador de secretos o en las variables de entorno de la computadora del agente.\n');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    abortar(e.message);
  } finally {
    client.release();
    await pool.end();
  }
}

await main();
