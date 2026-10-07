// Utilidades de los scripts de la depuración de negocios (oct-2026).
// Cada script hace SIMULACRO por omisión (todo dentro de una transacción que
// termina en ROLLBACK) y solo confirma con --aplicar. Antes de confirmar
// escribe el estado anterior en el directorio de respaldo (--respaldo=<dir>,
// por omisión C:\xabor-respaldos\depuracion-2026-10), fuera de la base.
import pg from 'pg';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export const SALEN = ['nonna-maye', 'carnitas-moreno', 'dcheve-para-llevar',
  'promo-cond-a', 'promo-cond-b', 'promo-guiado-a', 'promo-guiado-b', 'promo-info-a', 'promo-info-b',
  'promo-prod-a', 'promo-prod-b', 'promo-eng-a', 'promo-eng-b',
  'faseb-negocio-a', 'faseb-negocio-b', 'faseb-negocio-c', 'faseb-negocio-d', 'fase3a-neg-a', 'fase3a-neg-b'];
export const QUEDAN = ['mapolato-obispado', 'mapolato-acuna', 'alora-floreria-y-eventos'];
export const SUPERADMIN_EMAIL = 'mario@xabor.mx';

export function opciones() {
  const args = process.argv.slice(2);
  const respaldo = (args.find(a => a.startsWith('--respaldo=')) || '').slice(11) || 'C:/xabor-respaldos/depuracion-2026-10';
  return { aplicar: args.includes('--aplicar'), respaldo };
}

export async function conectar() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL requerida');
  const host = new URL(process.env.DATABASE_URL).hostname;
  const local = ['localhost', '127.0.0.1', '::1'].includes(host);
  console.log(`[depuracion] base: ${host}${local ? ' (local)' : ''}`);
  const c = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: local ? false : { rejectUnauthorized: false } });
  await c.connect();
  return c;
}

export function guardar(dir, nombre, datos) {
  mkdirSync(dir, { recursive: true });
  const ruta = join(dir, nombre);
  writeFileSync(ruta, typeof datos === 'string' ? datos : JSON.stringify(datos, null, 2));
  return ruta;
}

export function sello() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

// Corre `trabajo(c)` dentro de una transacción. Sin --aplicar, ROLLBACK.
export async function enTransaccion(nombre, trabajo) {
  const { aplicar, respaldo } = opciones();
  const c = await conectar();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout = '5s'");
    await trabajo(c, { aplicar, respaldo });
    await c.query(aplicar ? 'COMMIT' : 'ROLLBACK');
    console.log(aplicar ? `[${nombre}] APLICADO.` : `[${nombre}] SIMULACRO: nada se guardó. Repite con --aplicar para confirmar.`);
  } catch (e) {
    await c.query('ROLLBACK').catch(() => {});
    console.error(`[${nombre}] ABORTADO, nada se guardó: ${e.message}`);
    process.exitCode = 1;
  } finally { await c.end().catch(() => {}); }
}

export async function idSuperadmin(c) {
  const { rows: [u] } = await c.query('SELECT id FROM usuarios WHERE email = $1', [SUPERADMIN_EMAIL]);
  if (!u) throw new Error(`no existe ${SUPERADMIN_EMAIL}`);
  return u.id;
}

export async function auditar(c, superadminId, accion, { negocioId = null, usuarioId = null, antes = null, despues = null, contexto = null } = {}) {
  await c.query(
    `INSERT INTO auditoria_plataforma (superadmin_id, accion, negocio_id, usuario_id, estado_anterior, estado_nuevo, contexto)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [superadminId, accion, negocioId, usuarioId, antes && JSON.stringify(antes), despues && JSON.stringify(despues),
     JSON.stringify({ origen: 'depuracion-negocios-2026-10', via: 'script', ...(contexto || {}) })]);
}
