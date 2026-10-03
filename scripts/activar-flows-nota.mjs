// Operación explícita del dueño: activa (o revierte) la NOTA DEL PEDIDO en los
// formularios con dirección (contrato nota_v1). No envía mensajes ni publica en
// Meta; solo escribe la bandera whatsapp_flow_nota_v1, los dos flowId
// *_nota_id y su respaldo, juntos. Ejecutar sobre el SHA revisado y
// desplegado, a una hora sin formularios abiertos. Exige la dirección ya
// activa (activar-flows-direccion.mjs).
//
//   node scripts/activar-flows-nota.mjs <negocioId> <sha> activar <categoriasNotaId> <carritoNotaId> [--con-formularios-abiertos]
//   node scripts/activar-flows-nota.mjs <negocioId> <sha> revertir
//
// Activar se niega si hay formularios abiertos en los últimos 30 minutos (el
// flag lo fuerza: esos formularios responderán «ya no está disponible»).
// Revertir no espera ni consulta Meta: es la salida de emergencia, y un
// formulario con nota abierto responde «ya no está disponible» y el cliente
// pide otro. Los formularios vuelven a ser los de dirección, sin nota.
// Para quitar todo: primero esta reversa, después la de la dirección. Si la
// dirección se revierte primero, la nota se apaga sola (vive en su pantalla),
// y activar otra dirección se niega hasta revertir la nota.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { pool } from '../src/services/database.js';
import { credencialFlows,clienteMetaFlows } from './lib-meta-flows.mjs';
import { CLAVE_RESPALDO_NOTA,planActivacionNota,planReversaNota } from '../src/mesero-agente/activacionNota.js';
import { definicionFlowCategorias } from './definicion-flow-categorias.mjs';
import { definicionFlowCarrito } from './definicion-flow-carrito.mjs';
const [negocioId,sha,modo,categoriasNotaId,carritoNotaId]=process.argv.slice(2);
const forzar=process.argv.includes('--con-formularios-abiertos');
assert.match(negocioId || '',/^[0-9a-f-]{36}$/);
assert.match(sha || '',/^[a-f0-9]{40}$/);
assert.equal(process.env.RAILWAY_GIT_COMMIT_SHA,sha,'Build distinto al revisado');
assert(['activar','revertir'].includes(modo));
const endpoint='https://xabor.mx/webhook/flows/pedido';
const nombre=(tipo,definicion)=>`xabor_${tipo}_agrupado_${createHash('sha256').update(JSON.stringify(definicion)).digest('hex').slice(0,12)}`;
const definicion=(tipo,duplicar)=>tipo==='categorias'?definicionFlowCategorias({direccion:true,nota:true})
  :definicionFlowCarrito({duplicar,direccion:true,nota:true});
const leerCfg=async(db,bloquear)=>Object.fromEntries((await db.query(
  `SELECT clave,valor FROM configuracion WHERE negocio_id=$1${bloquear?' FOR UPDATE':''}`,[negocioId])).rows.map(r=>[r.clave,r.valor]));
let tx;
try {
  // Meta se consulta ANTES de abrir la transacción: nada queda bloqueado
  // mientras responde (los mensajes, el outbox y la impresión del negocio siguen).
  let duplicarRevisado=null;
  if(modo==='activar') {
    const cfg0=await leerCfg(pool,false);
    const plan=planActivacionNota(cfg0,categoriasNotaId,carritoNotaId);
    assert(!plan.error,plan.error);
    duplicarRevisado=cfg0.whatsapp_flow_carrito_duplicar_v1==='true';
    const cred=await credencialFlows(negocioId),api=clienteMetaFlows(cred.token);
    // Solo Flows de la WABA de ESTE negocio: el nombre por huella es el mismo en
    // todos los negocios, y un Flow ajeno no saldría por su número.
    const propios=(await api(`${cred.wabaId}/flows?fields=id&limit=100`)).data.map(x=>x.id);
    for(const [id,tipo] of plan.flows) {
      assert(propios.includes(id),`Flow ${id} no es de la WABA de este negocio`);
      const f=await api(`${id}?fields=id,name,status,validation_errors,endpoint_uri`);
      assert.equal(f.status,'PUBLISHED',`Flow ${id} no publicado`);
      assert(!f.validation_errors?.length,`Flow ${id} con errores`);
      assert.equal(f.endpoint_uri,endpoint,`Flow ${id} con otro endpoint`);
      // El nombre es la huella de la definición CON la nota de este build: un
      // Flow sin el campo recibiría un nota_inicial que no declara.
      assert.equal(f.name,nombre(tipo,definicion(tipo,duplicarRevisado)),`Flow ${id} no es la definición ${tipo} con nota de este build`);
    }
  }
  tx=await pool.connect();await tx.query('BEGIN');
  await tx.query("SET LOCAL lock_timeout='3s'");
  // La misma llave que activar-flows-direccion.mjs: las dos escriben la misma
  // configuración y la nota depende de la dirección; nunca corren a la vez.
  await tx.query("SELECT pg_advisory_xact_lock(hashtextextended('activar-flows-direccion:' || $1,0))",[negocioId]);
  const {rows:[n]}=await tx.query('SELECT id FROM negocios WHERE id=$1',[negocioId]);
  assert(n,'Negocio inexistente');
  // Releída con FOR UPDATE: si cambió mientras se revisaba Meta, el plan se
  // vuelve a calcular sobre lo que hay (y falla si ya no cuadra).
  const cfg=await leerCfg(tx,true);
  let aplicar,abiertos=null;
  if(modo==='activar') {
    const plan=planActivacionNota(cfg,categoriasNotaId,carritoNotaId);
    assert(!plan.error,plan.error);
    assert.equal(cfg.whatsapp_flow_carrito_duplicar_v1==='true',duplicarRevisado,'Cambió «duplicar» mientras se revisaba Meta: repetir');
    // Un formulario abierto con el flowId de la dirección deja de servir al activar.
    ({rows:[abiertos]}=await tx.query(`SELECT count(*)::int AS n FROM agente_preguntas_interactivas q
      JOIN agente_botones b ON b.pregunta_id=q.id
      WHERE q.negocio_id=$1 AND q.estado='disponible' AND b.accion IN ('flow_productos','flow_configurar')
        AND q.created_at>clock_timestamp()-interval '30 minutes'`,[negocioId]));
    assert(forzar || abiertos.n===0,`Hay ${abiertos.n} formulario(s) abierto(s) en los últimos 30 minutos: intenta más tarde`);
    if(plan.respaldo)await tx.query('INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3)',[negocioId,CLAVE_RESPALDO_NOTA,
      JSON.stringify({build:sha,fecha:new Date().toISOString(),...plan.respaldo})]);
    aplicar=plan.cambios;
  } else {
    const plan=planReversaNota(cfg);
    assert(!plan.error,plan.error);
    aplicar=plan.aplicar;
    await tx.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2',[negocioId,CLAVE_RESPALDO_NOTA]);
  }
  for(const [k,v] of Object.entries(aplicar)) {
    if(v===null)await tx.query('DELETE FROM configuracion WHERE negocio_id=$1 AND clave=$2',[negocioId,k]);
    else await tx.query('INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,$2,$3) ON CONFLICT(negocio_id,clave) DO UPDATE SET valor=EXCLUDED.valor',[negocioId,k,v]);
  }
  await tx.query('COMMIT');
  console.log(JSON.stringify({modo,negocioId,build:sha,cambios:aplicar,formulariosAbiertos:abiertos?.n ?? null,envios:0}));
} catch(e) {await tx?.query('ROLLBACK').catch(()=>{});console.error(e.message);process.exitCode=1;}
finally {tx?.release();await pool.end();}
