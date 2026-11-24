import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

export const MIGRACIONES_BASICO=Object.freeze([
  '150_registro_basico_autoservicio.sql','151_suscripciones_basico_mercadopago.sql',
  '152_basico_ciclo_facturacion.sql','153_basico_conciliacion_alertas.sql','154_basico_limites_registro.sql',
]);
const COLUMNAS={
  solicitudes_registro_basico:['id','email','token_hash','password_hash','used_at','negocio_id','privacidad_aceptada_at','privacidad_sha256'],
  suscripciones_basico_mp:['id','negocio_id','external_reference','preapproval_id','checkout_url','estado_mp','mensualidad','conciliacion_offset','ultima_consulta_at'],
  pagos_suscripcion_basico_mp:['id','negocio_id','preapproval_id','authorized_payment_id','payment_id','monto','moneda','estado_pago','reembolsado','periodo_desde','periodo_hasta'],
  facturas_suscripcion_basico_mp:['authorized_payment_id','negocio_id','preapproval_id','payment_id','estado_pago','consultado_at'],
  alertas_facturacion_basico:['clave','negocio_id','tipo','ocurrencias','resuelta_at'],
  limites_registro_basico:['clave','ventana','intentos'],
};

export async function inspeccionarEsquemaBasico(db) {
  const nombres=Object.keys(COLUMNAS);
  const {rows:tablas}=await db.query("SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1)",[nombres]);
  if(!tablas.length)return {estado:'ausente',faltan:nombres.map(t=>'tabla '+t)};
  const {rows:columnas}=await db.query(`SELECT table_name,column_name,data_type,is_nullable FROM information_schema.columns
    WHERE table_schema='public' AND table_name=ANY($1)`,[nombres]);
  const faltan=[];
  for(const [tabla,campos] of Object.entries(COLUMNAS))for(const campo of campos) {
    if(!columnas.some(c=>c.table_name===tabla&&c.column_name===campo))faltan.push('columna '+tabla+'.'+campo);
  }
  for(const [tabla,campo] of [['suscripciones_basico_mp','mensualidad'],['pagos_suscripcion_basico_mp','monto']]) {
    if(!columnas.some(c=>c.table_name===tabla&&c.column_name===campo&&c.data_type==='numeric'&&c.is_nullable==='NO'))faltan.push('importe obligatorio '+tabla+'.'+campo);
  }
  const {rows:reglas}=await db.query(`SELECT c.conname,c.contype,c.convalidated,t.relname,pg_get_constraintdef(c.oid) AS definicion
    FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
    WHERE n.nspname='public' AND t.relname=ANY($1)`,[nombres]);
  for(const nombre of ['pago_basico_tenant','factura_basico_tenant']) {
    if(!reglas.some(r=>r.conname===nombre&&r.contype==='f'&&r.convalidated&&
      r.definicion.includes('(preapproval_id, negocio_id)')&&r.definicion.includes('REFERENCES suscripciones_basico_mp(preapproval_id, negocio_id)')))faltan.push('aislamiento '+nombre);
  }
  for(const campo of ['authorized_payment_id','payment_id']) {
    if(!reglas.some(r=>r.relname==='pagos_suscripcion_basico_mp'&&r.contype==='u'&&r.definicion.replace(/\s/g,'')==='UNIQUE('+campo+')'))faltan.push('pago único '+campo);
  }
  for(const nombre of ['basico_pago_periodo','basico_pago_devolucion','basico_pago_monto_positivo']) {
    if(!reglas.some(r=>r.conname===nombre&&r.contype==='c'&&r.convalidated))faltan.push('regla '+nombre);
  }
  const {rows:indices}=await db.query("SELECT indexname,indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='suscripciones_basico_mp'");
  if(!indices.some(i=>i.indexname==='basico_mp_un_contrato_vigente'&&i.indexdef.includes('UNIQUE')&&i.indexdef.includes('(negocio_id)')&&i.indexdef.includes('canceled')&&i.indexdef.includes('cancelled')))faltan.push('contrato vigente único');
  return {estado:faltan.length?'incompleto':'completo',faltan};
}

export async function prepararEsquemaBasico(pool,{autorizar=false}={}) {
  const db=await pool.connect();
  try {
    await db.query('BEGIN');
    await db.query("SELECT pg_advisory_xact_lock(hashtext('xabor-basico-esquema'))");
    const previo=await inspeccionarEsquemaBasico(db);
    if(previo.estado==='completo'){await db.query('COMMIT');return {estado:'completo',aplicadas:[]};}
    if(previo.estado==='incompleto')throw Error('El esquema del Básico está incompleto; requiere revisión antes de migrar');
    if(!autorizar)throw Error('Falta autorización de migraciones del Básico');
    for(const nombre of MIGRACIONES_BASICO) {
      let sql=readFileSync(new URL('../migrations/'+nombre,import.meta.url),'utf8');
      const inicio=/^\s*BEGIN;\s*$/gmi,fin=/^\s*COMMIT;\s*$/gmi;
      assert.equal([...sql.matchAll(inicio)].length,1);assert.equal([...sql.matchAll(fin)].length,1);
      sql=sql.replace(inicio,'').replace(fin,'');
      await db.query(sql);
    }
    const posterior=await inspeccionarEsquemaBasico(db);
    assert.equal(posterior.estado,'completo','No se obtuvo el esquema completo; se revierte la migración');
    await db.query('COMMIT');return {estado:'completo',aplicadas:[...MIGRACIONES_BASICO]};
  } catch(e){await db.query('ROLLBACK');throw e;}
  finally{db.release();}
}
