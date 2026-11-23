// Inicializador exclusivo de staging vacío; nunca admite producción ni sus secretos.
import assert from 'node:assert/strict';
import { readdirSync,readFileSync } from 'node:fs';
const db=new URL(process.env.DATABASE_URL);
assert.equal(process.env.XABOR_INICIALIZAR_STAGING_BASICO,'SI_BD_VACIA');
assert.equal(process.env.RAILWAY_ENVIRONMENT_NAME,'staging-basico');
assert.equal(db.hostname,'basico-postgres.railway.internal');
assert.equal(db.pathname,'/xabor_basico_staging');
const {pool,initDB}=await import('../src/services/database.js');
const ORDEN_MIGRACIONES=[
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
  '026_documentos_cotizaciones.sql',
  '027_cotizaciones_iva_tasa.sql',
  '028_sesiones_comerciales.sql',
  '029_chat_imagenes.sql',
  '030_cotizaciones_enviado_por.sql',
  '031_sesiones_comerciales_error_recuperable.sql',
  '032_notificaciones_repartidor.sql',
  '033_token_aceptacion_repartidor.sql',
  '034_modo_conversacion_repartidor.sql',
  '035_perfil_repartidor.sql',
  '036_entregado_at_pedidos.sql',
  '037_central_operaciones_onboarding.sql',
  '038_red_repartidores_config.sql',
  '039_restaurante_mesas.sql',
  '040_restaurante_integracion_ventas.sql',
  '041_usuarios_mesero_pin.sql',
  '042_password_reset_tokens.sql',
  '043_impresion_edge.sql',
  '045_whatsapp_nombre_visible.sql',
  '046_auditoria_actor_negocio.sql',
  '048_whatsapp_menu_automatico.sql',
  '049_whatsapp_coexistence.sql',
  '050_menu_multiimagen.sql',
];
try {
 const {rows:[r]}=await pool.query("SELECT to_regclass('public.basico_staging_preparado') AS preparado,to_regclass('public.negocios') AS negocios");
 if(r.preparado){console.log('[staging-basico] Base preparada anteriormente');}
 else {
  assert.equal(r.negocios,null,'Se exige una base vacía; nunca se migra una base de clientes con este script');
  await initDB();
  const dir=new URL('../migrations/',import.meta.url);
  const nuevas=readdirSync(dir).filter(f=>/^\d{3}_/.test(f)&&Number(f.slice(0,3))>50&&!/_(down|check|seed)(_|\.)/.test(f)).sort();
  for(const f of [...ORDEN_MIGRACIONES,...nuevas]){
   if(f==='015_rewards_modulo_identidad.sql'){
    await pool.query("INSERT INTO negocios(nombre,slug) VALUES('QA sintético Alora','alora-floreria-y-eventos'),('QA sintético Mapolato','mapolato-acuna') ON CONFLICT(slug) DO NOTHING");
   }
   await pool.query(readFileSync(new URL(f,dir),'utf8'));
   console.log('[staging-basico] '+f);
  }
  // No se activan integraciones ni se cargan datos reales.
  await pool.query('UPDATE negocios SET bot_whatsapp_activo=FALSE');
  await pool.query("CREATE TABLE basico_staging_preparado(fecha TIMESTAMPTZ NOT NULL DEFAULT NOW())");
  await pool.query('INSERT INTO basico_staging_preparado DEFAULT VALUES');
 }
 if(process.env.XABOR_STAGING_QA_PASSWORD){
  const {rows}=await pool.query("SELECT 1 FROM usuarios WHERE email='qa-basico@ejemplo.invalid'");
  if(!rows.length){
   const {randomBytes}=await import('node:crypto');
   const {hashPassword}=await import('../src/services/password.js');
   const {confirmarRegistroBasico,hashTokenRegistro}=await import('../src/services/registroBasico.js');
   const token=randomBytes(32).toString('hex');
   await pool.query(`INSERT INTO solicitudes_registro_basico(email,token_hash,password_hash,nombre_propietario,nombre_negocio,expires_at)
   VALUES('qa-basico@ejemplo.invalid',$1,$2,'Persona sintética QA','Fonda de prueba Xabor',NOW()+INTERVAL '30 minutes')`,
   [hashTokenRegistro(token),hashPassword(process.env.XABOR_STAGING_QA_PASSWORD)]);
   await confirmarRegistroBasico(token);
   console.log('[staging-basico] Cuenta sintética preparada');
  }
 }
} finally {await pool.end();}
