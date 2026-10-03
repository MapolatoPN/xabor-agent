import { createHash } from 'node:crypto';
import { barrerasDeBotones,interactivosActivos,TOKEN_BOTON } from './interactivos.js';
import { eleccionesActivas } from './eleccionesInteractivas.js';
import { flowsActivos } from './formularioAgrupado.js';
import { borradorInicial,cambiarBorrador,respuestaBorrador } from './flowRepetible.js';
import { borradorCategorias,cambiarCategorias,respuestaCategorias } from './flowCategorias.js';
import { borradorCarrito,cambiarCarrito,respuestaCarrito } from './flowCarrito.js';
import { eventoActividadFormulario,registrarActividadFormulario } from './actividadFormulario.js';
import { CONTRATO_DIRECCION,contratoCarrito,contratoCategorias,esDomicilio,flowIdEsperado } from './direccionFormulario.js';

// El caso más común (7 veces el 2-oct) es un formulario sustituido porque el
// cliente escribió mientras lo tenía abierto: el texto lo manda al más reciente.
export class FlowNoDisponible extends Error {
  constructor(){super('Este formulario ya no está disponible: se actualizó o venció. Usa el más reciente del chat o escribe «seguir pedido».');this.status=427;}
}

// Un formulario sin dirección abierto antes de activar el contrato direccion_v1:
// su recibo ya no coincidiría con la foto nueva y se perdería al final. Se corta
// desde el principio, igual que uno con dirección después de revertir.
export const sinDireccionVieja=(cfg,datos)=>datos?.contrato!==CONTRATO_DIRECCION
  && (datos?.version==='carrito_v1' ? contratoCarrito(cfg)
    : datos?.presentacion==='categorias_v1' && contratoCategorias(cfg));

// Las respuestas al endpoint solamente guardan el borrador. La finalización
// viaja por el webhook habitual: mismo lock, reconciliador y consumo único.
export async function atenderFlowRepetible(db,solicitud) {
  if(!TOKEN_BOTON.test(solicitud?.flow_token || ''))throw new FlowNoDisponible();
  const tx=await db.connect();
  try {
    await tx.query('BEGIN');
    await tx.query("SET LOCAL statement_timeout='4000ms'");
    const {rows:[identidad]}=await tx.query(`SELECT q.id,q.negocio_id,q.session_id FROM agente_botones b
      JOIN agente_preguntas_interactivas q ON q.id=b.pregunta_id WHERE b.token=$1`,[solicitud.flow_token]);
    if(!identidad)throw new FlowNoDisponible();
    // Mismo orden de locks que reservarBotones, también entre dos procesos.
    const {rows:[s]}=await tx.query('SELECT estado FROM conversacion_estado WHERE negocio_id=$1 AND session_id=$2 FOR UPDATE',
      [identidad.negocio_id,identidad.session_id]);
    const {rows:[q]}=await tx.query(`SELECT q.*,b.datos,b.accion,o.estado AS envio,o.wamid_salida,
      q.created_at>clock_timestamp()-interval '30 minutes' AS vigente,
      EXISTS(SELECT 1 FROM whatsapp_entradas e WHERE e.negocio_id=q.negocio_id AND e.telefono=$3
        AND e.recibido_at>q.created_at AND e.payload->'message'->>'type' IN ('text','image','document','order')) AS texto_posterior
      FROM agente_preguntas_interactivas q JOIN agente_botones b ON b.pregunta_id=q.id
      JOIN agente_outbox o ON o.evento_clave=q.outbox_clave WHERE q.id=$1 AND b.token=$2 FOR UPDATE OF q`,
      [identidad.id,solicitud.flow_token,identidad.session_id.replace(/^agente:/,'')]);
    const estado=s?.estado,telefono=identidad.session_id.replace(/^agente:/,'');
    const b=await barrerasDeBotones(tx,identidad.negocio_id,telefono);
    if(!estado || !q || !q.vigente || q.texto_posterior || q.estado!=='disponible' || q.envio!=='entregado'
      || !q.wamid_salida || !['repetible_v1','carrito_v1'].includes(q.datos?.version) || q.ciclo!==estado.conversacionId
      || q.dialogo_id!==estado.pendiente?.dialogo_id || estado.botonesReserva || estado.folio
      || estado.evento || estado.confirmacionIncierta || Object.values(estado.hechos || {}).some(Boolean)
      || !b.activo || !flowsActivos(b.cfg,telefono) || !interactivosActivos(b.cfg) || !eleccionesActivas(b.cfg)
      || flowIdEsperado(b.cfg,q.datos)!==q.datos.flowId || sinDireccionVieja(b.cfg,q.datos))throw new FlowNoDisponible();
    const trazar=b.cfg.whatsapp_trazabilidad_formularios_v1==='true';
    const hash=createHash('sha256').update(JSON.stringify(solicitud)).digest('hex');
    if(solicitud.data?.error) {
      if(trazar)await registrarActividadFormulario(tx,q.id,eventoActividadFormulario(solicitud,
        {borrador:{revision:0}},hash));
      await tx.query('COMMIT');return {data:{acknowledged:true}};
    }
    const categorias=q.datos.presentacion==='categorias_v1';
    const carrito=q.datos.version==='carrito_v1';
    await tx.query('INSERT INTO agente_flows_borradores(pregunta_id,contenido) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [q.id,JSON.stringify(carrito?borradorCarrito(q.datos):categorias?borradorCategorias():borradorInicial())]);
    const {rows:[fila]}=await tx.query('SELECT * FROM agente_flows_borradores WHERE pregunta_id=$1 FOR UPDATE',[q.id]);
    const paso=fila.ultimo_hash===hash ? {borrador:fila.contenido} : (carrito?cambiarCarrito:categorias?cambiarCategorias:cambiarBorrador)(q.datos,fila.contenido,solicitud);
    if(paso.borrador.revision!==fila.contenido.revision)await tx.query(
      'UPDATE agente_flows_borradores SET contenido=$2,ultimo_hash=$3,actualizado_at=now() WHERE pregunta_id=$1',
      [q.id,JSON.stringify(paso.borrador),hash]);
    const respuesta=(carrito?respuestaCarrito:categorias?respuestaCategorias:respuestaBorrador)(q.datos,paso.borrador,solicitud.flow_token,paso.error,solicitud.data);
    if(trazar)await registrarActividadFormulario(tx,q.id,eventoActividadFormulario(solicitud,paso,hash));
    await tx.query('COMMIT');return respuesta;
  } catch(e) {await tx.query('ROLLBACK').catch(()=>{});throw e;}
  finally {tx.release();}
}

// El cliente solo devuelve un recibo opaco. Nunca se acepta una lista de
// platillos ni precios enviada directamente a nfm_reply para este Flow.
export async function resolverFinalFlow(tx,pregunta,respuesta) {
  if(!respuesta || Object.keys(respuesta).some(k=>!['flow_token','revision'].includes(k)))return null;
  const {rows:[r]}=await tx.query('SELECT contenido FROM agente_flows_borradores WHERE pregunta_id=$1',[pregunta.id]);
  const d=r?.contenido;
  if(d?.etapa!=='FINAL' || respuesta.revision!==String(d.revision))return null;
  // La dirección (contrato direccion_v1) sale del borrador validado, nunca del
  // cliente, y solo con domicilio y platillos: una dirección que quedó de un aviso
  // antes de cambiar a recoger rechazaría el recibo entero.
  const modalidad=pregunta.datos?.modalidades?.[Number(String(d.modalidad).slice(1))]?.valor;
  const conPlatillos=(pregunta.datos?.version==='carrito_v1'?d.filas:d.items)?.length>0;
  const direccion=pregunta.datos?.contrato===CONTRATO_DIRECCION && d.direccion && conPlatillos && esDomicilio(modalidad)
    ?{direccion:d.direccion}:{};
  if(pregunta.datos?.version==='carrito_v1')return {flow_token:respuesta.flow_token,filas:d.filas,modalidad:d.modalidad,pago:d.pago,...direccion};
  return {flow_token:respuesta.flow_token,items:d.items,modalidad:d.modalidad,pago:d.pago,...direccion};
}
