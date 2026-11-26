import { pool } from './database.js';
import { zonaHorariaNegocio } from './cortesCaja.js';
import { ticketVentaHtml } from './ticketVentaBasico.js';
import { crearTokenTicket, verificarTokenTicket, enlacePublicoTicket, enlaceWhatsAppTicket,
  correoTicketValido, folioTicketValido, claveEnvioTicket } from './ticketVentaEnlaces.js';
import { correoTicketDisponible, enviarCorreoTicketVenta } from './email.js';
import { tomarLugares } from './limitesPersistentes.js';
import { rateLimitMiddleware } from './rateLimit.js';

const cabeceras = res => res.set({ 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow, noarchive, nosnippet',
  'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });

async function consultarTicket(negocioId, folio) {
  if (!folioTicketValido(folio)) return null;
  const { rows: [p] } = await pool.query(`SELECT p.folio,p.estado,p.datos,p.created_at,n.nombre
    FROM pedidos_activos p JOIN negocios n ON n.id=p.negocio_id
    WHERE p.negocio_id=$1 AND p.folio=$2`, [negocioId, folio]);
  return p || null; // Archivar conserva la fila; una eliminación retira el acceso.
}
const render = async (p, negocioId, entrega) => ticketVentaHtml({ negocio:p.nombre,folio:p.folio,estado:p.estado,
  datos:p.datos,fecha:p.created_at,timeZone:await zonaHorariaNegocio(negocioId),entrega });
const fallo = res => res.status(503).json({error:'No pudimos completar el envío. Intenta de nuevo en unos minutos.'});

export function registrarRutasTicketVenta(app, { requireAuthSeguro, requireSesionNegocio, requireModulo }) {
  app.get('/ticket-venta/:folio', requireAuthSeguro, requireModulo('pos'), async(req,res)=>{
    cabeceras(res);
    try {
      const p = await consultarTicket(req.negocioId, req.params.folio);
      if (!p) return res.status(404).send('Ticket no encontrado');
      const {token} = crearTokenTicket({negocioId:req.negocioId,folio:p.folio});
      const enlace = enlacePublicoTicket(token);
      res.type('html').send(await render(p,req.negocioId,{token,negocioId:req.negocioId,
        whatsappUrl:enlaceWhatsAppTicket({negocio:p.nombre,folio:p.folio,enlace}),correoDisponible:correoTicketDisponible()}));
    } catch { res.status(503).send('El ticket no está disponible en este momento. Intenta de nuevo.'); }
  });

  app.get('/ticket-compartido/:token', rateLimitMiddleware(req=>'ticket-publico:'+req.ip,120,60_000), async(req,res)=>{
    cabeceras(res);
    try {
      const d = verificarTokenTicket(req.params.token);
      const p = d ? await consultarTicket(d.negocioId,d.folio) : null;
      if (!p) return res.status(404).send('Este enlace ya no está disponible. Pide al negocio que te comparta el ticket de nuevo.');
      res.type('html').send(await render(p,d.negocioId));
    } catch { res.status(503).send('El ticket no está disponible en este momento. Intenta de nuevo.'); }
  });

  app.post('/api/tickets-venta/:folio/correo', requireSesionNegocio(), requireModulo('pos'), async(req,res)=>{
    cabeceras(res);
    if(req.get('X-Xabor-Accion')!=='enviar-ticket'||req.get('Sec-Fetch-Site')==='cross-site')return res.status(403).json({error:'Acción no autorizada'});
    const origen=req.get('Origin');
    if(origen){
      let esperado;try{esperado=new URL(process.env.PUBLIC_URL||'https://xabor.mx').origin;}catch{return fallo(res);}
      const permitidos=new Set([esperado]);
      if(esperado==='https://xabor.mx'||esperado==='https://www.xabor.mx'){permitidos.add('https://xabor.mx');permitidos.add('https://www.xabor.mx');}
      if(!permitidos.has(origen))return res.status(403).json({error:'Origen no autorizado'});
    }
    const email=typeof req.body?.email==='string'?req.body.email.trim().toLowerCase():'';
    const solicitudId=req.body?.solicitudId;
    if(!correoTicketValido(email)||typeof solicitudId!=='string'||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(solicitudId)){
      return res.status(400).json({error:'Escribe un correo válido y vuelve a intentar el envío.'});
    }
    const token=req.body?.token,d=verificarTokenTicket(token);
    if(!d||d.negocioId!==req.negocioId||d.folio!==req.params.folio)return res.status(403).json({error:'El enlace no corresponde a este ticket o ya venció. Abre el ticket de nuevo.'});
    if(!correoTicketDisponible())return res.status(503).json({error:'El envío por correo no está disponible en este momento. Puedes compartir por WhatsApp.'});
    try{
      const p=await consultarTicket(req.negocioId,req.params.folio);
      if(!p)return res.status(404).json({error:'Ticket no encontrado'});
      // Límites compartidos entre réplicas. Se guardan huellas, nunca correos.
      const lugar=await tomarLugares([
        {clave:'ticket-usuario:'+req.usuarioId,limite:30,ventanaMs:3600000},
        {clave:'ticket-negocio:'+req.negocioId,limite:300,ventanaMs:86400000},
        {clave:claveEnvioTicket({negocioId:req.negocioId,folio:p.folio,email,solicitudId:'destino',token:''}),limite:3,ventanaMs:900000},
      ]);
      if(!lugar)return res.status(429).json({error:'Alcanzaste el límite de envíos. Intenta más tarde o comparte el ticket por WhatsApp.'});
      const r=await enviarCorreoTicketVenta({to:email,negocio:p.nombre,folio:p.folio,enlace:enlacePublicoTicket(token),
        idempotencyKey:claveEnvioTicket({negocioId:req.negocioId,folio:p.folio,email,solicitudId,token})});
      if(!r.enviado)return fallo(res);
      res.json({enviado:true});
    }catch{return fallo(res);}
  });
}
