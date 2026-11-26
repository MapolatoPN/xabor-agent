import { pool } from './database.js';
import { consultarEstadoComercialBasico } from './accesoComercialBasico.js';
import { estadoWhatsappNegocio } from './whatsappAutoservicio.js';

// Solo hechos del negocio autenticado. Sin tokens ni casillas que permitan
// declarar pagada/configurada una integración desde el navegador.
export async function estadoOnboardingAutoservicio(negocioId) {
  const comercial=await consultarEstadoComercialBasico(negocioId);
  if(!comercial)return null;
  const {rows:[n]}=await pool.query(`SELECT n.nombre,n.slug,n.bot_whatsapp_activo,
    (SELECT count(*)::int FROM menu_productos WHERE negocio_id=n.id) AS productos,
    (SELECT count(*)::int FROM usuario_negocios WHERE negocio_id=n.id AND activo) AS usuarios,
    (SELECT estado FROM tienda_config WHERE negocio_id=n.id) AS tienda,
    EXISTS(SELECT 1 FROM impresion_rutas r JOIN impresoras i ON i.id=r.impresora_id
      WHERE r.negocio_id=n.id AND r.activa AND i.activa) AS impresion
    FROM negocios n WHERE n.id=$1`,[negocioId]);
  const {rows:config}=await pool.query(`SELECT clave,valor FROM configuracion WHERE negocio_id=$1
    AND clave IN ('telefono','ciudad','direccion','horario','restaurante_num_mesas')`,[negocioId]);
  const cfg=Object.fromEntries(config.map(r=>[r.clave,r.valor]));
  const whatsapp=comercial.plan==='pro'?await estadoWhatsappNegocio(negocioId):null;
  const paso=(id,titulo,detalle,completo,enlace,accion)=>({id,titulo,detalle,completo:!!completo,enlace,accion});
  const pasos=[
    paso('cuenta','Tu cuenta está lista','Correo verificado y negocio creado.',true,null,null),
    paso('suscripcion','Activa tu plan',comercial.permitido?'Puedes usar Xabor. Consulta tu prueba o periodo pagado.':'Autoriza tu mensualidad en Mercado Pago. El acceso se habilita al verificar el pago.',comercial.permitido,'/suscripcion-basico','Ver mi suscripción'),
    paso('datos','Completa los datos del negocio','Revisa nombre, teléfono, dirección y horarios.',!!(cfg.telefono&&cfg.direccion&&cfg.horario),'/app#config','Configurar mi negocio'),
    paso('menu','Carga tus productos','Agrega categorías, precios y fotografías desde el menú.',n.productos>0,'/app#menu',n.productos?'Ver mis productos':'Agregar mi primer producto'),
    paso('mesas','Configura tus mesas','Si atiendes en mostrador, puedes comenzar a vender sin este paso.',Number(cfg.restaurante_num_mesas)>0,'/restaurante','Configurar mesas'),
  ];
  if(comercial.plan==='pro')pasos.push(
    paso('web','Publica tu página','Personaliza tu catálogo, revisa las modalidades y publícalo cuando esté listo.',n.tienda==='publicada','/app#tienda','Configurar mi página'),
    paso('whatsapp','Conecta WhatsApp','Conecta tu cuenta de Meta desde Configuración. Sus tarifas de mensajería se pagan aparte.',whatsapp?.conectado,'/app#config','Conectar WhatsApp'),
    paso('automatizacion','Prepara tus respuestas y formularios','Revisa horarios, reglas y pruebas antes de encender la atención automática.',whatsapp?.conectado&&n.bot_whatsapp_activo,'/app#entrenamiento','Preparar atención'),
    paso('equipo','Invita a tu equipo','Opcional: crea accesos con permisos propios para cada persona.',n.usuarios>1,'/app#config','Administrar accesos'),
    paso('impresion','Conecta tus impresoras','Asigna las impresoras en Xabor Edge. Antes de operar, confirma físicamente que cada prueba salga legible y en el lugar correcto.',n.impresion,'/app#config','Configurar impresión'),
  );
  for(const p of pasos)p.opcional=!['cuenta','suscripcion','datos','menu'].includes(p.id);
  return {negocio:{nombre:n.nombre},plan:comercial.plan,montoMensual:Number(comercial.mensualidad),
    diasPrueba:comercial.dias_prueba,accesoPermitido:comercial.permitido,estadoComercial:comercial.estado,
    pasos,repartidoresPendiente:comercial.plan==='pro'};
}
export function registrarRutasOnboardingAutoservicio(app,{requireSesionNegocio}) {
  app.get('/api/onboarding/estado',requireSesionNegocio('admin'),async(req,res)=>{
    res.set('Cache-Control','private, no-store');
    try {
      const estado=await estadoOnboardingAutoservicio(req.negocioId);
      if(!estado)return res.status(404).json({error:'Este negocio conserva su configuración habitual.'});
      res.json(estado);
    }catch{res.status(503).json({error:'No pudimos consultar la configuración. Intenta de nuevo.'});}
  });
}
