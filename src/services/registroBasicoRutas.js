// Registro compartido con ofertas cerradas Básico/Pro y banderas separadas.
// No acepta módulos, importes, negocioId ni roles del navegador.
import { rateLimitMiddleware } from './rateLimit.js';
import { ofertaAutoservicio, altaPlanHabilitada } from './planesAutoservicio.js';
import { permitirRegistroBasico } from './limitesRegistroBasico.js';
import { registroBasicoPorInvitacion } from './registroBasicoValidacion.js';
import {
  solicitarRegistroBasico, confirmarRegistroBasico, ErrorRegistroBasico,
} from './registroBasico.js';

export const registroBasicoPublicoHabilitado = () =>
  process.env.XABOR_ALTA_PUBLICA_BASICO === 'true';

const soloSiHabilitado = (req, res, next) => {
  let plan;
  try { plan=ofertaAutoservicio(req.body?.plan).plan; }
  catch { return res.status(400).json({error:'Elige Básico o Pro.',code:'PLAN_INVALIDO'}); }
  if (!altaPlanHabilitada(plan)) {
    return res.status(503).json({ error: 'El registro automático está en preparación', code: 'REGISTRO_NO_DISPONIBLE' });
  }
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
};

function manejarError(res, error) {
  if (error instanceof ErrorRegistroBasico) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  // Nunca devolver SQL, stack, secretos o información de otras cuentas.
  console.error('[registro-basico] Fallo interno:', error?.code || 'desconocido');
  return res.status(500).json({ error: 'No pudimos procesar tu solicitud', code: 'REGISTRO_ERROR' });
}

export function registrarRutasRegistroBasico(app) {
  app.get('/api/publico/registro-basico/estado', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    let oferta;
    try { oferta=ofertaAutoservicio(_req.query.plan); }
    catch { return res.status(400).json({error:'Elige Básico o Pro.',code:'PLAN_INVALIDO'}); }
    const {modulos,...publica}=oferta;
    res.json({ ...publica,habilitado:altaPlanHabilitada(oferta.plan),porInvitacion:registroBasicoPorInvitacion() });
  });
  app.post('/api/publico/registro-basico/solicitar',
    soloSiHabilitado,
    rateLimitMiddleware(req => `registro-basico-ip:${req.ip}`, 5, 15 * 60_000),
    rateLimitMiddleware(req => `registro-basico-email:${typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : 'sin-email'}`, 3, 15 * 60_000),
    async (req, res) => {
      try {
        if(!(await permitirRegistroBasico(req)))return res.status(429).json({error:'Demasiados intentos. Espera quince minutos antes de solicitar otro enlace.'});
        if(req.body?.sitioWeb)return res.status(202).json({ok:true,mensaje:'Si el correo puede registrarse, recibirás un enlace para verificarlo.'});
        const salida = await solicitarRegistroBasico(req.body || {});
        return res.status(202).json(salida);
      } catch (e) { return manejarError(res, e); }
    });
  app.post('/api/publico/registro-basico/confirmar',
    (_req,res,next)=>{res.set('Cache-Control','no-store');res.set('Referrer-Policy','no-referrer');next();},
    rateLimitMiddleware(req => `confirmar-basico:${req.ip}`, 12, 15 * 60_000),
    async (req, res) => {
      try {
        const salida = await confirmarRegistroBasico(req.body?.token,{exigirHabilitado:true});
        return res.status(201).json(salida);
      } catch (e) { return manejarError(res, e); }
    });
}
