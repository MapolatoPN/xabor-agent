// Solo se invoca después de autenticar el endpoint y validar las barreras de
// negocio/conversación/pregunta. Ningún dato libre del cliente es persistido.
const PASOS=new Set(['MENU','PLATILLO','TACOS','ENTREGA','CARRITO','EDITAR','FINAL']);
// La tienda (tienda_v1) registra sus etapas: TIENDA (explorar, la ficha y el
// carrito), ENTREGA, DIRECCION y FINAL (migración 114). Los formularios de hoy
// siguen con su lista: su DIRECCION queda como hoy, sin paso.
const PASOS_TIENDA=new Set(['TIENDA','ENTREGA','DIRECCION','FINAL']);
const PANTALLAS=new Set(['MENU','CATEGORIA','PERSONALIZAR','PLATILLO','TACOS','CARRITO','EDITAR','ENTREGA','DIRECCION','FINAL']);
export function eventoActividadFormulario(solicitud,paso,clave,{tienda=false,detalle=false}={}) {
  if(!/^[a-f0-9]{64}$/.test(clave || '') || !Number.isSafeInteger(paso?.borrador?.revision)
    || paso.borrador.revision<0)return null;
  const tipo=solicitud?.data?.error?'error_cliente':solicitud?.action==='INIT'?'apertura'
    :['data_exchange','BACK'].includes(solicitud?.action)?paso.error?'validacion':'paso':null;
  if(!tipo)return null;
  const pantalla=paso.borrador.vista?.pantalla || (paso.borrador.etapa==='TIENDA'?'MENU':paso.borrador.etapa);
  return {clave,tipo,paso:(tienda?PASOS_TIENDA:PASOS).has(paso.borrador.etapa)?paso.borrador.etapa:null,revision:paso.borrador.revision,
    ...(detalle?{pantalla:PANTALLAS.has(pantalla)?pantalla:null}:{})};
}

export async function registrarActividadFormulario(tx,preguntaId,evento) {
  if(!evento)return false;
  // La telemetría no puede invalidar una operación de borrador válida. El
  // savepoint conserva la transacción si falta la tabla en una reversión.
  await tx.query('SAVEPOINT actividad_formulario');
  try {
    const detalle=Object.hasOwn(evento,'pantalla');
    const r=await tx.query(`INSERT INTO agente_actividad_formulario(pregunta_id,clave,tipo,paso,revision${detalle?',pantalla':''})
      SELECT $1,$2,$3,$4,$5${detalle?',$6':''} WHERE
        (SELECT count(*) FROM agente_actividad_formulario WHERE pregunta_id=$1)<512
      ON CONFLICT DO NOTHING`,[preguntaId,evento.clave,evento.tipo,evento.paso,evento.revision,...(detalle?[evento.pantalla]:[])]);
    await tx.query('RELEASE SAVEPOINT actividad_formulario');return r.rowCount===1;
  } catch {
    await tx.query('ROLLBACK TO SAVEPOINT actividad_formulario');
    await tx.query('RELEASE SAVEPOINT actividad_formulario');
    console.warn('[FLOW] Evidencia de actividad no disponible');return false;
  }
}
