// Aplica las tablas base (initDB) + migraciones 001-018 en orden sobre
// DATABASE_URL, para levantar una base de prueba desechable desde cero.
// Uso: DATABASE_URL=... node test/aplicar-migraciones.mjs [hastaIndice]
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { initDB, pool } from '../src/services/database.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRACIONES_DIR = join(__dirname, '..', 'migrations');

export const ORDEN_MIGRACIONES = [
  '001_memory_engine.sql',
  '002_campanas.sql',
  '003_multiempresa.sql',
  '003_multiempresa_seed.sql',
  '004_config_menu_negocio.sql',
  '005_usuario_negocios.sql',
  '006_login_password.sql',
  '007_negocio_id_datos_operativos.sql',
  '008_integraciones_canal.sql',
  '008_integraciones_canal_seed.sql',
  '009_caja_fondos_por_negocio.sql',
  '009_caja_fondos_por_negocio_seed.sql',
  '010_terminales_credenciales.sql',
  '011_superadmin_plataforma.sql',
  '012_invitaciones_usuario.sql',
  '013_rewards_tenant_negocio.sql',
  '014_push_subscriptions_negocio.sql',
  '015_rewards_modulo_identidad.sql',
  '016_prompt_overrides_negocio.sql',
  '017_seed_reglas_nonna_maye.sql',
  '018_integraciones_canal_credenciales.sql',
  '019_bot_whatsapp_activo_negocio.sql',
  '020_mensajes_origen_dedup.sql',
  '021_menu_agotado_destacado.sql',
  '022_plan_comercial_negocio.sql',
  '023_prospectos_comerciales.sql',
  '024_activacion_cloud_api_whatsapp.sql',
  '025_pagos_multiempresa.sql',
];

export async function aplicarMigraciones(hastaIndice = ORDEN_MIGRACIONES.length) {
  await initDB();
  console.log('OK   initDB() (tablas base)');

  for (let i = 0; i < hastaIndice; i++) {
    const archivo = ORDEN_MIGRACIONES[i];
    if (archivo === '015_rewards_modulo_identidad.sql') {
      // 015 exige por slug 3 negocios reales de producción (guard
      // fail-closed). En este entorno de prueba efímero, sembramos
      // homónimos sintéticos mínimos únicamente para satisfacer esos
      // guards -- no representan datos reales de Alora/Mapolato.
      await pool.query(`
        INSERT INTO negocios (nombre, slug) VALUES
          ('Alora Florería y Eventos (sintético prueba)', 'alora-floreria-y-eventos'),
          ('Mapolato Acuña (sintético prueba)', 'mapolato-acuna')
        ON CONFLICT (slug) DO NOTHING;
      `);
      console.log('OK   seed sintético: alora-floreria-y-eventos, mapolato-acuna (solo para guard de 015)');
    }
    const sql = readFileSync(join(MIGRACIONES_DIR, archivo), 'utf8');
    await pool.query(sql);
    console.log(`OK   ${archivo}`);
  }
  console.log('\nTodas las migraciones aplicadas correctamente.');
}

// Si se ejecuta directamente (no importado), corre y cierra el pool.
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const hastaIndice = process.argv[2] ? parseInt(process.argv[2], 10) : ORDEN_MIGRACIONES.length;
  try {
    await aplicarMigraciones(hastaIndice);
  } catch (e) {
    console.error(`FALLO: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}
