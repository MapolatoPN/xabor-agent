import pg from 'pg';
import { randomUUID } from 'node:crypto';
import { pool } from './database.js';
import { ingresarTicketWhatsapp } from './comprasTicketIngreso.js';
import { obtenerCompra, confirmarCompra, cancelarCompra, CompraOperativaError } from './comprasOperativas.js';
import { telefonoComprador, comandoCompra, resumenTicketWhatsapp } from './comprasWhatsappDialogo.js';

// Separado del pool de operaciones: mantener un lock mientras se usa el pool
// principal no puede agotar sus conexiones. No hay transacción durante la IA.
const locks = new pg.Pool({connectionString:process.env.DATABASE_URL,ssl:{rejectUnauthorized:false},max:3,connectionTimeoutMillis:5000});
export async function cerrarComprasWhatsapp() { await locks.end(); }
const ayuda = 'Para registrar compras, envía una foto del ticket. Te devolveré un borrador con su código y las opciones de pago. Revisa y confirma cada ticket; puedes corregirlo en https://xabor.mx/compras.html.';

export async function manejarCompraWhatsapp({negocioId,message,descargar,responder,verificarCanal=async()=>{},ingresar=ingresarTicketWhatsapp}) {
  const telefono = telefonoComprador(message.from);
  if (!telefono || !message.id) return false;
  const {rows:[autorizado]} = await pool.query(`SELECT * FROM compras_whatsapp_autorizados
    WHERE negocio_id=$1 AND telefono=$2 AND activo=true`,[negocioId,telefono]);
  if (!autorizado) return false;
  const comando = comandoCompra(message.text?.body);
  let candidato = message.type==='image' || comando || /^\s*(compras|confirmar|cancelar)\b/i.test(message.text?.body || '');
  if (!candidato && /^\s*(s[ií]|no)\s*[.!]?\s*$/i.test(message.text?.body || '')) {
    const {rows} = await pool.query(`SELECT 1 FROM compras_whatsapp_tickets t JOIN compras_operativas c
      ON c.negocio_id=t.negocio_id AND c.id=t.compra_id WHERE t.negocio_id=$1 AND t.telefono=$2 AND c.estado='borrador' LIMIT 1`,[negocioId,telefono]);
    candidato = rows.length>0;
  }
  if (!candidato) return false;
  await verificarCanal();
  const db = await locks.connect();
  const lock = `compras-wa:${negocioId}`;
  let adquirido = false;
  let respuesta;
  try {
    const {rows:[r]} = await db.query('SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS ok',[lock]);
    adquirido = r.ok;
    if (!adquirido) {
      await responder('Estoy procesando otro ticket. Espera un momento y vuelve a enviar esta foto o confirmación.');
      return true;
    }
    if (message.type==='image') {
      const {rows:[previo]} = await pool.query('SELECT * FROM compras_whatsapp_tickets WHERE negocio_id=$1 AND wamid=$2 AND telefono=$3',[negocioId,message.id,telefono]);
      let compra;
      if (previo) compra = await obtenerCompra(negocioId,previo.compra_id);
      else {
        const {rows:[limite]} = await pool.query("SELECT count(*)::int AS n FROM compras_whatsapp_tickets WHERE negocio_id=$1 AND created_at>now()-interval '1 hour'",[negocioId]);
        if (limite.n >= 30) throw new CompraOperativaError('Llegamos al límite de tickets por hora. Intenta más tarde o usa Compras.','LIMITE_TICKETS');
        if (!message.image?.id) throw new CompraOperativaError('No recibí la foto. Vuelve a enviarla.','FOTO_VACIA');
        const actor = `whatsapp:${telefono}:${message.id}`;
        // Recupera el borrador si el proceso murió después de guardarlo y antes de asociarlo.
        const {rows:[recuperada]} = await pool.query("SELECT id FROM compras_operativas WHERE negocio_id=$1 AND created_by=$2 AND estado<>'cancelada'",[negocioId,actor]);
        const resultado = recuperada || await ingresar(negocioId,(await descargar(message.image.id)).buffer,actor);
        compra = await obtenerCompra(negocioId,resultado.id);
        if (resultado.repetida) {
          const {rows:[propia]} = await pool.query('SELECT 1 FROM compras_whatsapp_tickets WHERE negocio_id=$1 AND compra_id=$2 AND telefono=$3',[negocioId,compra.id,telefono]);
          if (!propia) {
            await responder('Este ticket parece estar registrado. Revísalo en Compras para evitar duplicarlo. No registré otra compra.');
            return true;
          }
        } else await pool.query(`INSERT INTO compras_whatsapp_tickets(negocio_id,telefono,wamid,compra_id,version_mostrada)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[negocioId,telefono,message.id,compra.id,compra.version]);
      }
      if (compra.estado!=='borrador') respuesta = `Este ticket ya está ${compra.estado}. No registré otra compra ni otro pago.`;
      else {
        await pool.query('UPDATE compras_whatsapp_tickets SET version_mostrada=$3 WHERE negocio_id=$1 AND compra_id=$2',[negocioId,compra.id,compra.version]);
        respuesta = resumenTicketWhatsapp(compra);
      }
    } else if (!comando || comando.tipo==='ayuda') respuesta = ayuda;
    else {
      const {rows} = await pool.query(`SELECT * FROM compras_whatsapp_tickets WHERE negocio_id=$1 AND telefono=$2
        AND left(compra_id::text,8)=$3`,[negocioId,telefono,comando.codigo]);
      if (rows.length!==1) throw new CompraOperativaError('No encuentro un ticket tuyo con ese código. Revisa el código o envía la foto.','CODIGO_INVALIDO');
      const ticket = rows[0], compra = await obtenerCompra(negocioId,ticket.compra_id);
      if (compra.estado!=='borrador') respuesta = `La compra ${comando.codigo} ya está ${compra.estado}. No registré otro pago.`;
      else if (compra.version!==comando.version) {
        await pool.query('UPDATE compras_whatsapp_tickets SET version_mostrada=$3 WHERE negocio_id=$1 AND compra_id=$2',[negocioId,compra.id,compra.version]);
        respuesta = 'La compra cambió en el panel. Revisa este resumen y vuelve a confirmar:\n'+resumenTicketWhatsapp(compra);
      } else if (comando.tipo==='cancelar') {
        await cancelarCompra(negocioId,compra.id,{version:compra.version,motivo:'Cancelada por el comprador en WhatsApp'},`whatsapp:${telefono}`);
        respuesta = `Borrador ${comando.codigo} cancelado. No se registró ningún pago.`;
      } else {
        const pago = comando.origen==='credito' ? undefined : {origen:comando.origen==='fondo'?'fondo':'otra_cuenta',
          responsable_id:comando.origen==='fondo'?autorizado.responsable_id:undefined,
          cuenta:comando.cuenta,clave_operacion:randomUUID()};
        await confirmarCompra(negocioId,compra.id,{version:compra.version,tipo_pago:comando.origen==='credito'?'credito':'contado',pago_inicial:pago},`whatsapp:${telefono}`);
        respuesta = `Compra ${comando.codigo} registrada: $${Number(compra.total).toFixed(2)} MXN. `+
          (comando.origen==='credito'?'Quedó pendiente de pago al proveedor.':comando.origen==='fondo'?'El pago se descontó de tu fondo.':`Pago registrado desde ${comando.cuenta}.`);
      }
    }
  } catch(e) {
    console.error('[Compras WhatsApp]',e.codigo || e.code || 'ERROR',e.causa || e.message);
    respuesta = e instanceof CompraOperativaError ? e.message : 'No pude completar la operación. Vuelve a enviar la foto o la confirmación. Puedes revisar el estado en Compras.';
  } finally {
    if (adquirido) await db.query('SELECT pg_advisory_unlock(hashtextextended($1,0))',[lock]).catch(()=>{});
    db.release();
  }
  await responder(respuesta);
  return true;
}
