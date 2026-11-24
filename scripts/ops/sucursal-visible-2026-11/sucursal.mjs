// La sucursal en los mensajes del bot y las sucursales hermanas (XAB-3915):
// revisar, encender y apagar las dos claves POR NEGOCIO. Ver
// src/mesero-agente/sucursalVisible.js.
//
//   node scripts/ops/sucursal-visible-2026-11/sucursal.mjs estado
//   node scripts/ops/sucursal-visible-2026-11/sucursal.mjs activar                     (simulacro)
//   node scripts/ops/sucursal-visible-2026-11/sucursal.mjs activar --aplicar
//   node scripts/ops/sucursal-visible-2026-11/sucursal.mjs activar --solo=<id o slug> --aplicar
//   node scripts/ops/sucursal-visible-2026-11/sucursal.mjs desactivar --aplicar
//
// Por omisión trabaja con Mapolato Obispado y Mapolato Acuña: cada una queda
// como hermana de la otra. --negocios=<id o slug>,<id o slug> cambia el grupo.
//
// Escribe dos filas de `configuracion` por negocio:
//   whatsapp_sucursal_visible_v1  'true' = el saludo, «Revisa tu pedido» y la confirmación nombran la sucursal
//   whatsapp_sucursales_hermanas  JSON con las otras: nombre, ciudad, WhatsApp, tienda, negocio_id, alias
// Los datos de cada hermana salen de la base, no se teclean: su nombre y su
// ciudad (configuracion), su número de WhatsApp (integraciones_canal,
// display_phone_number) y su tienda publicada (tienda_config).
//
// `estado` corre en una transacción READ ONLY: muestra lo que hay, lo que se
// escribiría y los textos que verá el cliente. `activar` es SIMULACRO por
// omisión (ROLLBACK); con --aplicar confirma y antes guarda los valores
// anteriores en --respaldo=<dir> (por omisión C:/xabor-respaldos/sucursal-visible-2026-11).
// `desactivar` borra las dos filas: el bot vuelve a hablar como antes.
// Surte efecto en el siguiente mensaje: no requiere despliegue ni reinicio,
// pero sí que el código de esta rama ya esté en producción (sin él, las
// claves no hacen nada).
import pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CLAVE_SUCURSAL_VISIBLE, CLAVE_HERMANAS, sucursalVisible, deLaSucursal, renglonDelResumen,
  fraseDeConfirmacion, sucursalesHermanas, textoParaHermana, avisoClienteDeHermana,
} from '../../../src/mesero-agente/sucursalVisible.js';

const POR_OMISION = ['5de544d8-9a0a-4972-9c92-fd48ff22de66', 'bb27290a-3359-4348-ba60-03d89f97127f']; // Obispado, Acuña
const BASE_TIENDA = String(process.env.PUBLIC_URL || 'https://xabor.mx').replace(/\/+$/, '');

const argv = process.argv.slice(2);
const valor = (k) => (argv.find((a) => a.startsWith(`--${k}=`)) || '').slice(k.length + 3);
const comando = argv.find((a) => !a.startsWith('--')) || 'estado';
const aplicar = argv.includes('--aplicar');
const negociosArg = valor('negocios').split(',').map((s) => s.trim()).filter(Boolean);
const solo = valor('solo').trim();
const respaldo = valor('respaldo') || 'C:/xabor-respaldos/sucursal-visible-2026-11';

if (!['estado', 'activar', 'desactivar'].includes(comando)) {
  console.error(`Comando desconocido: ${comando}. Usa estado | activar | desactivar`);
  process.exit(2);
}
if (!process.env.DATABASE_URL) { console.error('DATABASE_URL requerida'); process.exit(2); }

const host = new URL(process.env.DATABASE_URL).hostname;
const local = ['localhost', '127.0.0.1', '::1'].includes(host);
console.log(`[sucursal] base: ${host}${local ? ' (local)' : ''}`);
const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
await c.connect();

const digitos = (s) => String(s ?? '').replace(/\D/g, '');
const sinAcentos = (s) => String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();

/** Una sucursal con lo que hace falta para describirla como hermana. */
async function leerSucursal(clave) {
  const { rows } = await c.query(`
    SELECT n.id::text AS id, n.slug, n.nombre AS nombre_negocio,
           (SELECT valor FROM configuracion WHERE negocio_id = n.id AND clave = 'nombre') AS nombre,
           (SELECT valor FROM configuracion WHERE negocio_id = n.id AND clave = 'ciudad') AS ciudad,
           (SELECT valor FROM configuracion WHERE negocio_id = n.id AND clave = 'direccion') AS direccion,
           (SELECT valor FROM configuracion WHERE negocio_id = n.id AND clave = $2) AS visible,
           (SELECT valor FROM configuracion WHERE negocio_id = n.id AND clave = $3) AS hermanas,
           -- El número que Meta da para el WhatsApp conectado (migración 143, a 10 dígitos);
           -- display_phone_number queda de respaldo, muchas conexiones no lo guardaron.
           COALESCE(
             (SELECT '52' || telefono FROM negocio_telefonos_propios
               WHERE negocio_id = n.id AND origen = 'whatsapp' AND activo = TRUE
               ORDER BY updated_at DESC LIMIT 1),
             (SELECT display_phone_number FROM integraciones_canal
               WHERE negocio_id = n.id AND canal = 'whatsapp' AND activo = TRUE AND display_phone_number IS NOT NULL
               ORDER BY principal DESC NULLS LAST, updated_at DESC LIMIT 1)) AS whatsapp,
           tc.estado AS tienda_estado, COALESCE(NULLIF(tc.slug_publico, ''), n.slug) AS tienda_slug
      FROM negocios n LEFT JOIN tienda_config tc ON tc.negocio_id = n.id
     WHERE n.id::text = $1 OR n.slug = $1 OR tc.slug_publico = $1`, [clave, CLAVE_SUCURSAL_VISIBLE, CLAVE_HERMANAS]);
  if (rows.length !== 1) throw new Error(`${clave} resuelve a ${rows.length} negocios: debe ser uno`);
  return rows[0];
}

/** La entrada de `s` en la lista de hermanas de otra sucursal. */
function comoHermana(s) {
  const nombre = (s.nombre || s.nombre_negocio || '').trim();
  const ciudad = (s.ciudad || '').trim();
  const tel = digitos(s.whatsapp);
  const tienda = s.tienda_estado === 'publicada' && s.tienda_slug ? `${BASE_TIENDA}/t/${encodeURIComponent(s.tienda_slug)}` : '';
  // El nombre propio de la sucursal («Obispado») también la nombra: «la quiero en Obispado».
  const ultima = nombre.split(/\s+/).pop() || '';
  const alias = ultima.length >= 4 && sinAcentos(ultima) !== sinAcentos(ciudad) ? [ultima] : [];
  if (!nombre) throw new Error(`${s.slug}: sin nombre en Configuración`);
  if (!ciudad) throw new Error(`${s.slug}: sin «Ciudad y estado» en Configuración: sin ciudad no se le reconoce`);
  if (!(tel.length >= 10 && tel.length <= 13) && !tienda) throw new Error(`${s.slug}: sin WhatsApp activo ni tienda publicada: no hay a dónde mandar al cliente`);
  return { nombre, ciudad, whatsapp: tel.length >= 10 && tel.length <= 13 ? tel : '', tienda, negocio_id: s.id, alias };
}

/** Lo que se escribiría en cada sucursal y los textos que verá su cliente. */
function plan(sucursales) {
  return sucursales.map((s) => {
    const hermanas = sucursales.filter((o) => o.id !== s.id).map(comoHermana);
    const cfg = { nombre: s.nombre || s.nombre_negocio, ciudad: s.ciudad, direccion: s.direccion,
      [CLAVE_SUCURSAL_VISIBLE]: 'true', [CLAVE_HERMANAS]: JSON.stringify(hermanas) };
    if (!sucursalVisible(cfg)) throw new Error(`${s.slug}: la sucursal no se puede nombrar (¿falta el nombre?)`);
    const leidas = sucursalesHermanas(cfg);
    if (leidas.length !== hermanas.length) {
      throw new Error(`${s.slug}: el bot solo leería ${leidas.length} de ${hermanas.length} hermanas (¿dos sucursales en la misma ciudad?)`);
    }
    return { s, cfg, nuevo: { [CLAVE_SUCURSAL_VISIBLE]: 'true', [CLAVE_HERMANAS]: cfg[CLAVE_HERMANAS] } };
  });
}

function pintarActual(s) {
  console.log(`- ${s.nombre || s.nombre_negocio} (${s.slug}): ciudad ${s.ciudad || 'SIN CIUDAD'} · WhatsApp ${s.whatsapp ? `…${digitos(s.whatsapp).slice(-4)}` : 'sin WhatsApp activo'}`
    + ` · tienda ${s.tienda_estado || 'sin tienda'} · sucursal visible ${s.visible === 'true' ? 'ENCENDIDA' : 'apagada'}`
    + ` · hermanas ${s.hermanas ? 'configuradas' : 'ninguna'}`);
}

function pintarTextos({ s, cfg }) {
  const suc = sucursalVisible(cfg);
  console.log(`\n=== ${suc.nombre}: lo que verá el cliente ===`);
  console.log(`Saludo:        «Soy *Mapo Bot*${deLaSucursal(suc)}. …»`);
  console.log(`Revisa pedido: «${renglonDelResumen(suc).trim()}»`);
  console.log(`Confirmación:  recoger → «${fraseDeConfirmacion(suc, 'recoger en tienda')}»`);
  console.log(`               domicilio → «${fraseDeConfirmacion(suc, 'entrega a domicilio')}»`);
  for (const h of sucursalesHermanas(cfg)) {
    console.log(`\nSi escriben «el pedido es en ${h.ciudad}» (alias: ${[h.ciudad, h.nombre, ...h.alias].join(', ')}):`);
    console.log(textoParaHermana({ cfg, hermana: h }).replace(/^/gm, '  | '));
    console.log('A quien solo ha pedido en esa sucursal, el saludo le agrega:');
    console.log(avisoClienteDeHermana({ cfg, hermana: h }).replace(/^/gm, '  | '));
  }
  console.log(`\n${CLAVE_HERMANAS} = ${cfg[CLAVE_HERMANAS]}`);
  void s;
}

try {
  await c.query(comando === 'estado' ? 'BEGIN READ ONLY' : 'BEGIN');
  await c.query("SET LOCAL lock_timeout = '5s'");
  const grupo = negociosArg.length ? negociosArg : POR_OMISION;
  if (grupo.length < 2) throw new Error('--negocios necesita al menos dos sucursales');
  const sucursales = [];
  for (const clave of grupo) sucursales.push(await leerSucursal(clave));
  if (new Set(sucursales.map((s) => s.id)).size !== sucursales.length) throw new Error('una sucursal aparece dos veces en --negocios');
  const destino = solo ? sucursales.filter((s) => s.id === solo || s.slug === solo) : sucursales;
  if (solo && destino.length !== 1) throw new Error(`--solo=${solo} no es una de las sucursales del grupo`);

  console.log('ACTUAL:'); sucursales.forEach(pintarActual);

  if (comando === 'estado') {
    for (const p of plan(sucursales)) pintarTextos(p);
    await c.query('ROLLBACK');
  } else {
    const planes = comando === 'activar' ? plan(sucursales).filter((p) => destino.some((d) => d.id === p.s.id)) : [];
    const anteriores = destino.map((s) => ({ negocio_id: s.id, slug: s.slug,
      [CLAVE_SUCURSAL_VISIBLE]: s.visible ?? null, [CLAVE_HERMANAS]: s.hermanas ?? null }));
    for (const s of destino) {
      if (comando === 'desactivar') {
        await c.query('DELETE FROM configuracion WHERE negocio_id = $1 AND clave = ANY($2)', [s.id, [CLAVE_SUCURSAL_VISIBLE, CLAVE_HERMANAS]]);
      } else {
        const { nuevo } = planes.find((p) => p.s.id === s.id);
        for (const [clave, v] of Object.entries(nuevo)) {
          await c.query(`INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($1,$2,$3)
            ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = $3, updated_at = NOW()`, [s.id, clave, v]);
        }
      }
    }
    const despues = [];
    for (const s of sucursales) despues.push(await leerSucursal(s.id));
    console.log('\nDESPUÉS:'); despues.forEach(pintarActual);
    for (const p of planes) pintarTextos(p);
    if (aplicar) {
      mkdirSync(respaldo, { recursive: true });
      const ruta = join(respaldo, `${comando}-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
      writeFileSync(ruta, JSON.stringify({ comando, anteriores }, null, 2));
      console.log(`\nrespaldo: ${ruta}`);
      await c.query('COMMIT');
      console.log('[sucursal] APLICADO. Surte efecto en el siguiente mensaje: no requiere despliegue ni reinicio.');
    } else {
      await c.query('ROLLBACK');
      console.log('\n[sucursal] SIMULACRO: nada se guardó. Repite con --aplicar para confirmar.');
    }
  }
} catch (e) {
  await c.query('ROLLBACK').catch(() => {});
  console.error(`[sucursal] ABORTADO, nada se guardó: ${e.message}`);
  process.exitCode = 1;
} finally {
  await c.end().catch(() => {});
}
