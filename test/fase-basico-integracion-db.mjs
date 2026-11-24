import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createHmac, randomUUID } from 'node:crypto';
const db = new URL(process.env.DATABASE_URL);
assert(['127.0.0.1','localhost'].includes(db.hostname));
assert.match(db.pathname,/^\/test_basico_/);
assert.match(process.env.NODE_OPTIONS || '',/red-solo-local/);
const { pool } = await import('../src/services/database.js');
const { default: WebSocket } = await import('ws');
const correos=[];
const contratos=new Map(), facturas=new Map(), pagos=new Map();
let altasMp=0, errorAltaMp=0, logs='', base, proceso;
const firmaSecret='QA_WEBHOOK_SECRET_LOCAL_ONLY';
const password='ClaveLocalDePrueba2026!';
const proveedor=createServer(async(req,res)=>{
  let texto='';for await(const c of req)texto+=c;
  const body=texto?JSON.parse(texto):{};
  const url=new URL(req.url,'http://127.0.0.1');
  const salida=x=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(x));};
  if(url.pathname==='/api.resend.com/emails') {correos.push(body);return salida({id:randomUUID()});}
  if(url.pathname==='/api.mercadopago.com/preapproval'&&req.method==='POST') {
    const error=errorAltaMp;errorAltaMp=0;
    if(error===400){res.statusCode=400;return salida({message:'QA_RECHAZO_DEFINITIVO'});}
    altasMp++;
    const c={...body,id:'QA_CONTRATO_'+randomUUID(),init_point:'https://www.mercadopago.com.mx/subscriptions/checkout?preapproval_id='+altasMp};
    contratos.set(c.id,c);
    if(error){res.statusCode=error;return salida({message:'QA_CREADO_PERO_RESPUESTA_INCIERTA'});}
    return salida(c);
  }
  if(url.pathname.startsWith('/api.mercadopago.com/preapproval/')) {
    const id=url.pathname.split('/').at(-1), c=contratos.get(id);
    if(c){if(req.method==='PUT')Object.assign(c,body);return salida(c);}
  }
  if(url.pathname==='/api.mercadopago.com/authorized_payments/search') {
    // La API real de México rechazó limit=20; devuelve 12 por omisión.
    const limit=Number(url.searchParams.get('limit')||12),offset=Number(url.searchParams.get('offset')||0);
    if(!Number.isInteger(limit)||limit<1||limit>12){res.statusCode=400;return salida({message:'Invalid value for limit'});}
    const result=[...facturas.values()].filter(f=>url.searchParams.has('payment_id')
      ? String(f.payment?.id)===url.searchParams.get('payment_id')
      : f.preapproval_id===url.searchParams.get('preapproval_id'));
    return salida({results:result.slice(offset,offset+limit),paging:{total:result.length,limit,offset}});
  }
  const id=url.pathname.split('/').at(-1);
  if(url.pathname.startsWith('/api.mercadopago.com/authorized_payments/')&&facturas.has(id))return salida(facturas.get(id));
  if(url.pathname.startsWith('/api.mercadopago.com/v1/payments/')&&pagos.has(id))return salida(pagos.get(id));
  res.statusCode=404;salida({error:'Proveedor falso: recurso inexistente'});
});
const request=async(path,{method='GET',body,cookie,headers={}}={})=>{
  const r=await fetch(base+path,{method,headers:{...(body?{'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{}),...headers},body:body?JSON.stringify(body):undefined,redirect:'manual'});
  const text=await r.text();let data;try{data=JSON.parse(text);}catch{data=text;}
  return {status:r.status,data,cookie:r.headers.get('set-cookie')?.split(';')[0]};
};
const datos=email=>({nombreNegocio:'Fonda QA '+email.split('@')[0],nombrePropietario:'Persona de prueba',email,password,aceptaAvisoPrivacidad:true});
const tokenCorreo=email=>{
  const c=correos.findLast(c=>c.to.includes(email));assert(c,'Debe existir correo en proveedor falso');
  return c.html.match(/\?token=([a-f0-9]{64})/)[1];
};
async function registrar(email) {
  assert.equal((await request('/api/publico/registro-basico/solicitar',{method:'POST',body:datos(email)})).status,202);
  assert.equal((await request('/api/publico/registro-basico/confirmar',{method:'POST',body:{token:tokenCorreo(email)}})).status,201);
  const login=await request('/api/auth/negocio/login',{method:'POST',body:{email,password}});
  assert.equal(login.status,200,JSON.stringify(login.data));assert(login.cookie);
  const {rows:[r]}=await pool.query('SELECT id,negocio_id FROM usuarios WHERE email=$1',[email]);
  return {email,cookie:login.cookie,usuarioId:r.id,negocioId:r.negocio_id};
}
async function webhook(tipo,id,extra={}){
  const ts=String(Math.floor(Date.now()/1000)),rid=randomUUID();
  const sig=createHmac('sha256',firmaSecret).update(`id:${id.toLowerCase()};request-id:${rid};ts:${ts};`).digest('hex');
  return request('/webhook/xabor-saas-mp?data.id='+id,{method:'POST',body:{type:tipo,data:{id},...extra},headers:{'x-request-id':rid,'x-signature':`ts=${ts},v1=${sig}`}});
}

test('Xabor Básico: HTTP real + PostgreSQL, proveedores simulados sin red externa',{timeout:90000},async t=>{
  await new Promise(r=>proveedor.listen(0,'127.0.0.1',r));
  const reservaPuerto=createServer();await new Promise(r=>reservaPuerto.listen(0,'127.0.0.1',r));
  const puerto=reservaPuerto.address().port;await new Promise(r=>reservaPuerto.close(r));
  base='http://127.0.0.1:'+puerto;
  proceso=spawn(process.execPath,['src/server.js'],{env:{...process.env,
    NODE_ENV:'production',PORT:String(puerto),PUBLIC_URL:'https://qa.xabor.invalid',
    SESSION_SECRET:'QA_SESSION_'+randomUUID(),META_APP_SECRET:'QA_META_FAKE',
    ADMIN_PASSWORD:'QA_ADMIN_FAKE',INTERNAL_SECRET:'QA_INTERNAL_FAKE',WHATSAPP_ADMIN_NUMERO:'',
    RESEND_API_KEY:'QA_RESEND_NO_REAL',MP_SAAS_ACCESS_TOKEN:'QA_MP_NO_REAL',MP_SAAS_WEBHOOK_SECRET:firmaSecret,
    XABOR_ALTA_PUBLICA_BASICO:'true',XABOR_SUSCRIPCIONES_MP:'true',XABOR_ACCESO_LEGADO:'denegar',
    XABOR_BASICO_QA:'SI',XABOR_QA_PROVEEDORES_URL:'http://127.0.0.1:'+proveedor.address().port,
    NODE_OPTIONS:process.env.NODE_OPTIONS+' --import=./test/basico-proveedores-locales.mjs',
  },stdio:['ignore','pipe','pipe']});
  proceso.stdout.on('data',c=>{logs=(logs+c).slice(-12000);});
  proceso.stderr.on('data',c=>{logs=(logs+c).slice(-12000);});
  const tokenMpAnterior=process.env.MP_SAAS_ACCESS_TOKEN;
  process.env.MP_SAAS_ACCESS_TOKEN='QA_MP_NO_REAL';
  try {
    let listo=false;
    for(let i=0;i<150;i++){
      if(proceso.exitCode!==null)throw Error('Servidor no arrancó: '+logs);
      try{if((await request('/health')).status===200){listo=true;break;}}catch{}
      await new Promise(r=>setTimeout(r,100));
    }
    assert(listo,'Servidor no disponible: '+logs);
    const marca=randomUUID().slice(0,8),email='qa-'+marca+'@ejemplo.invalid';
    let a,b,producto,categoria,mpId,folio,renovacionId,renovacionPago;
    const facturaId=String(Date.now())+'01',pagoId=String(Date.now())+'02';
    await t.test('correo antes del alta, confirmación concurrente y privilegios ignorados',async()=>{
      const r=await request('/api/publico/registro-basico/solicitar',{method:'POST',body:{...datos(email),rol:'superadmin',modulos:['whatsapp'],negocioId:randomUUID()}});
      assert.equal(r.status,202,JSON.stringify(r.data));assert.equal(r.data.token,undefined);
      assert.equal((await pool.query('SELECT 1 FROM usuarios WHERE email=$1',[email])).rowCount,0);
      const token=tokenCorreo(email);
      const rs=await Promise.all([1,2].map(()=>request('/api/publico/registro-basico/confirmar',{method:'POST',body:{token}})));
      assert.deepEqual(rs.map(x=>x.status).sort(),[201,410]);
      const login=await request('/api/auth/negocio/login',{method:'POST',body:{email,password}});
      assert.equal(login.status,200,JSON.stringify(login.data));
      const {rows:[r2]}=await pool.query('SELECT id,negocio_id FROM usuarios WHERE email=$1',[email]);
      a={email,cookie:login.cookie,usuarioId:r2.id,negocioId:r2.negocio_id};
      const {rows:mods}=await pool.query("SELECT modulo FROM negocio_modulos WHERE negocio_id=$1 AND estado='activo' ORDER BY modulo",[a.negocioId]);
      assert.deepEqual(mods.map(m=>m.modulo),['menu','pos']);
      assert.equal((await pool.query('SELECT 1 FROM sucursales WHERE negocio_id=$1',[a.negocioId])).rowCount,1);
      const {rows:[consentimiento]}=await pool.query('SELECT privacidad_aceptada_at,privacidad_sha256 FROM solicitudes_registro_basico WHERE negocio_id=$1',[a.negocioId]);
      assert(consentimiento.privacidad_aceptada_at);assert.match(consentimiento.privacidad_sha256,/^[a-f0-9]{64}$/);
    });
    await t.test('dos negocios: producto y catálogo aislados',async()=>{
      b=await registrar('qb-'+marca+'@ejemplo.invalid');
      const c=await request('/api/admin/menu/categorias',{method:'POST',cookie:a.cookie,body:{nombre:'Comidas'}});
      assert.equal(c.status,200,JSON.stringify(c.data));categoria=c.data;
      const p=await request('/api/admin/menu/productos',{method:'POST',cookie:a.cookie,body:{categoria_id:categoria.id,nombre:'Taco QA',precio:30}});
      assert.equal(p.status,200,JSON.stringify(p.data));producto=p.data;
      const cruzada=await request('/api/admin/menu/productos',{method:'POST',cookie:b.cookie,body:{categoria_id:categoria.id,nombre:'Intruso',precio:1,negocio_id:a.negocioId}});
      assert.equal(cruzada.status,403);
      const menu=await request('/api/menu?negocioId='+a.negocioId,{cookie:b.cookie});
      assert.equal(menu.status,200);assert(!JSON.stringify(menu.data).includes('Taco QA'));
      await request('/api/admin/menu/productos/'+producto.id,{method:'PATCH',cookie:b.cookie,body:{precio:1}});
      assert.equal(Number((await pool.query('SELECT precio FROM menu_productos WHERE id=$1',[producto.id])).rows[0].precio),30);
    });
    await t.test('módulos premium rechazados por el servidor',async()=>{
      const rutas=['/api/admin/usuarios','/api/restaurante/mesas','/api/personal/empleados',
        '/api/config/red-repartidores','/api/impresion/edges','/api/impresion/self-service',
        '/api/admin/repartidores','/api/admin/repartidores/estado'];
      const estados=await Promise.all(rutas.map(async path=>({path,status:(await request(path,{cookie:a.cookie})).status})));
      assert.deepEqual(estados,rutas.map(path=>({path,status:403})));
      assert.equal((await request('/API/IMPRESION/edges',{cookie:a.cookie})).status,403);
      for(const path of ['/api/impresion/edges','/api/impresion/edges/'+randomUUID()+'/emparejar',
        '/api/impresion/self-service/probar','/api/pos/pedidos']) {
        assert.equal((await request(path,{method:'POST',cookie:a.cookie,body:{tipo:'domicilio',nombre:'Sin contratar'}})).status,403,path);
      }
      assert.equal((await pool.query('SELECT 1 FROM terminales t JOIN sucursales s ON s.id=t.sucursal_id WHERE s.negocio_id=$1',[a.negocioId])).rowCount,0);
    });
    await t.test('impresión y reparto conservan acceso anterior y permiten módulos contratados',async()=>{
      // La misma estructura sin marca de alta pública representa un negocio previo.
      await pool.query('UPDATE solicitudes_registro_basico SET negocio_id=NULL WHERE negocio_id=$1',[b.negocioId]);
      try {
        for(const path of ['/api/impresion/edges','/api/admin/repartidores']) {
          assert.equal((await request(path,{cookie:b.cookie})).status,200,path);
        }
        await pool.query("UPDATE negocio_modulos SET estado='activo' WHERE negocio_id=$1 AND modulo IN ('impresion','repartidores')",[a.negocioId]);
        for(const path of ['/api/impresion/edges','/api/admin/repartidores']) {
          assert.equal((await request(path,{cookie:a.cookie})).status,200,path);
        }
      } finally {
        await pool.query('UPDATE solicitudes_registro_basico SET negocio_id=$1 WHERE email=$2',[b.negocioId,b.email]);
        await pool.query("UPDATE negocio_modulos SET estado='no_configurado' WHERE negocio_id=$1 AND modulo IN ('impresion','repartidores')",[a.negocioId]);
      }
    });
    await t.test('primera venta con precio del servidor',async()=>{
      const opciones={method:'POST',cookie:a.cookie,headers:{'Idempotency-Key':randomUUID()},body:{items:[{producto_id:producto.id,cantidad:2,precio:1}],forma_pago:'efectivo'}};
      const [r,duplicado]=await Promise.all([request('/api/pedido-presencial',opciones),request('/api/pedido-presencial',opciones)]);
      assert.equal(r.status,200,JSON.stringify(r.data));
      assert.equal(duplicado.status,200);assert.equal(duplicado.data.pedido.id,r.data.pedido.id);
      assert.equal(Number(r.data.total??r.data.pedido?.total),60,JSON.stringify(r.data));
      folio=r.data.pedido.id;
    });
    await t.test('un negocio no dispara tareas globales ni usa IA o comandas sin contratar',async()=>{
      const rutas=['/api/admin/reporte-diario/enviar','/api/admin/memory/enriquecer',
        '/api/admin/bot-simulador/sesion','/api/admin/bot-simulador/mensaje',
        '/api/pedidos/'+folio+'/reenviar-cocina'];
      for(const path of rutas)assert.equal((await request(path,{method:'POST',cookie:a.cookie,body:{}})).status,403,path);
      assert.equal((await request('/api/admin/bot-whatsapp',{cookie:a.cookie})).status,403);
      // Un negocio anterior tampoco tiene autoridad para ejecutar tareas globales.
      await pool.query('UPDATE solicitudes_registro_basico SET negocio_id=NULL WHERE negocio_id=$1',[b.negocioId]);
      try {
        for(const path of rutas.slice(0,2))assert.equal((await request(path,{method:'POST',cookie:b.cookie,body:{}})).status,403,path);
      } finally {
        await pool.query('UPDATE solicitudes_registro_basico SET negocio_id=$1 WHERE email=$2',[b.negocioId,b.email]);
      }
      await pool.query("UPDATE negocio_modulos SET estado='activo' WHERE negocio_id=$1 AND modulo='whatsapp'",[a.negocioId]);
      try {
        assert.equal((await request('/api/admin/bot-simulador/sesion',{method:'POST',cookie:a.cookie,body:{}})).status,200);
        assert.equal((await request('/api/admin/bot-simulador/mensaje',{method:'POST',cookie:a.cookie,body:{}})).status,400);
      } finally {
        await pool.query("UPDATE negocio_modulos SET estado='no_configurado' WHERE negocio_id=$1 AND modulo='whatsapp'",[a.negocioId]);
      }
      await pool.query('INSERT INTO administradores_plataforma(usuario_id) VALUES($1)',[a.usuarioId]);
      try {
        // Sin destinatario configurado, el envío se omite: no hay mensajes reales.
        assert.equal((await request(rutas[0],{method:'POST',cookie:a.cookie,body:{}})).status,200);
      } finally {
        await pool.query('DELETE FROM administradores_plataforma WHERE usuario_id=$1',[a.usuarioId]);
      }
    });
    await t.test('ticket digital y reportes funcionan sin módulos premium y se aíslan',async()=>{
      const ticket=await request('/ticket-venta/'+folio,{cookie:a.cookie});
      assert.equal(ticket.status,200);assert(ticket.data.includes('Taco QA'));assert(ticket.data.includes('60.00'));
      assert.equal((await request('/ticket-venta/'+folio,{cookie:b.cookie})).status,404);
      const reporte=await request('/api/reportes/ventas?periodo=hoy',{cookie:a.cookie});
      assert.equal(reporte.status,200,JSON.stringify(reporte.data));
      assert.equal(reporte.data.resumen.total_ventas,60);
      assert.equal((await request('/api/reportes/ventas?periodo=hoy&negocioId='+a.negocioId,{cookie:b.cookie})).data.resumen.total_ventas,0);
    });
    await t.test('WebSocket: snapshot solo del negocio de la cookie',async()=>{
      async function snapshot(cookie,ajeno){
        return new Promise((resolve,reject)=>{
          const ws=new WebSocket(base.replace('http','ws')+'/ws/panel?negocioId='+ajeno,{headers:{Cookie:cookie}});
          const timer=setTimeout(()=>{ws.terminate();reject(Error('Sin snapshot WebSocket'));},3000);
          ws.once('open',()=>setTimeout(()=>{clearTimeout(timer);ws.close();resolve('');},300));
          ws.once('message',mensaje=>{clearTimeout(timer);ws.close();resolve(String(mensaje));});
          ws.once('error',reject);
        });
      }
      assert((await snapshot(a.cookie,b.negocioId)).includes(folio));
      assert(!(await snapshot(b.cookie,a.negocioId)).includes(folio));
    });
    await t.test('WebSocket ya abierto se cierra al vencer la prueba',async()=>{
      const ws=new WebSocket(base.replace('http','ws')+'/ws/panel',{headers:{Cookie:a.cookie}});
      const primera=once(ws,'message');
      await once(ws,'open');await primera;
      const {rows:[original]}=await pool.query('SELECT used_at FROM solicitudes_registro_basico WHERE negocio_id=$1',[a.negocioId]);
      try{
        const cierre=once(ws,'close');
        await pool.query("UPDATE solicitudes_registro_basico SET used_at=NOW()-INTERVAL '8 days' WHERE negocio_id=$1",[a.negocioId]);
        const timer=setTimeout(()=>ws.terminate(),35000);
        const [codigo]=await cierre;clearTimeout(timer);
        assert.equal(codigo,1008,'El servidor debe cerrar el socket por acceso vencido');
        assert.equal((await request('/api/menu',{cookie:a.cookie})).status,402);
      }finally{
        ws.terminate();
        await pool.query('UPDATE solicitudes_registro_basico SET used_at=$2 WHERE negocio_id=$1',[a.negocioId,original.used_at]);
      }
    });
    await t.test('WebSocket revocado por cambio de contraseña no recibe una venta nueva',async()=>{
      const c=await registrar('qc-'+marca+'@ejemplo.invalid');
      const cat=await request('/api/admin/menu/categorias',{method:'POST',cookie:c.cookie,body:{nombre:'QA'}});
      const prod=await request('/api/admin/menu/productos',{method:'POST',cookie:c.cookie,body:{categoria_id:cat.data.id,nombre:'Venta privada',precio:10}});
      assert.equal(prod.status,200);
      const venta=cookie=>request('/api/pedido-presencial',{method:'POST',cookie,body:{items:[{producto_id:prod.data.id,cantidad:1}],forma_pago:'efectivo'}});
      assert.equal((await venta(c.cookie)).status,200);
      const ws=new WebSocket(base.replace('http','ws')+'/ws/panel',{headers:{Cookie:c.cookie}});
      const primera=once(ws,'message');await once(ws,'open');await primera;
      const posteriores=[];ws.on('message',m=>posteriores.push(String(m)));
      const cierre=once(ws,'close');
      try{
        assert.equal((await request('/api/auth/negocio/forgot-password',{method:'POST',body:{email:c.email}})).status,200);
        const correo=correos.findLast(m=>m.to.includes(c.email)),token=correo.html.match(/\?token=([A-Za-z0-9_-]+)/)[1];
        const nueva='NuevaClavePrivadaQA2026!';
        assert.equal((await request('/api/auth/negocio/reset-password',{method:'POST',body:{token,password:nueva,passwordConfirm:nueva}})).status,200);
        const login=await request('/api/auth/negocio/login',{method:'POST',body:{email:c.email,password:nueva}});
        assert.equal(login.status,200);
        const nuevaVenta=await venta(login.cookie);assert.equal(nuevaVenta.status,200);
        const timer=setTimeout(()=>ws.terminate(),3000);
        const [codigo]=await cierre;clearTimeout(timer);
        assert.equal(codigo,1008);
        assert(!posteriores.some(m=>JSON.parse(m).pedido?.id===nuevaVenta.data.pedido.id),'La sesión revocada no puede recibir la venta posterior');
      }finally{ws.terminate();}
    });
    await t.test('checkout concurrente único, autorización no equivale a pago',async()=>{
      const rs=await Promise.all([1,2].map(()=>request('/api/suscripciones-basico/checkout',{method:'POST',cookie:a.cookie,body:{negocioId:b.negocioId},headers:{'X-Xabor-Accion':'contratar'}})));
      assert(rs.some(x=>x.status===200),JSON.stringify(rs)+' '+logs.slice(-1500));assert.equal(altasMp,1);
      mpId=[...contratos.keys()][0];contratos.get(mpId).status='authorized';
      assert.equal((await webhook('subscription_preapproval',mpId)).status,200);
      const estado=await request('/api/suscripciones-basico/estado',{cookie:a.cookie});
      assert.equal(estado.data.estado,'prueba');
      assert.equal((await pool.query('SELECT 1 FROM pagos_suscripcion_basico_mp WHERE negocio_id=$1',[a.negocioId])).rowCount,0);
    });
    await t.test('pago rechazado no abre acceso ni crea mensualidad',async()=>{
      await pool.query("UPDATE solicitudes_registro_basico SET used_at=NOW()-INTERVAL '8 days' WHERE negocio_id=$1",[a.negocioId]);
      const id=facturaId+'7',p=pagoId+'7';
      facturas.set(id,{id,preapproval_id:mpId,currency_id:'MXN',transaction_amount:150,payment:{id:p,status:'rejected'}});
      pagos.set(p,{id:p,currency_id:'MXN',transaction_amount:150,status:'rejected'});
      assert.equal((await webhook('payment',p)).status,200);
      assert.equal((await request('/api/menu',{cookie:a.cookie})).status,402);
      assert.equal((await pool.query('SELECT 1 FROM pagos_suscripcion_basico_mp WHERE negocio_id=$1',[a.negocioId])).rowCount,0);
    });
    await t.test('gracia inicial configurable cubre la espera del primer débito sin acreditar pagos',async()=>{
      const {consultarEstadoComercialBasico}=await import('../src/services/accesoComercialBasico.js');
      const anterior=process.env.XABOR_BASICO_GRACIA_DIAS;
      try{
        process.env.XABOR_BASICO_GRACIA_DIAS='2';
        assert.equal((await consultarEstadoComercialBasico(a.negocioId)).estado,'gracia');
        assert.equal((await pool.query('SELECT 1 FROM pagos_suscripcion_basico_mp WHERE negocio_id=$1',[a.negocioId])).rowCount,0);
        await pool.query("UPDATE suscripciones_basico_mp SET estado_mp='pending' WHERE preapproval_id=$1",[mpId]);
        assert.equal((await consultarEstadoComercialBasico(a.negocioId)).permitido,false);
        await pool.query("UPDATE suscripciones_basico_mp SET estado_mp='authorized' WHERE preapproval_id=$1",[mpId]);
        process.env.XABOR_BASICO_GRACIA_DIAS='0';assert.equal((await consultarEstadoComercialBasico(a.negocioId)).permitido,false);
      }finally{
        if(anterior===undefined)delete process.env.XABOR_BASICO_GRACIA_DIAS;else process.env.XABOR_BASICO_GRACIA_DIAS=anterior;
        await pool.query("UPDATE suscripciones_basico_mp SET estado_mp='authorized' WHERE preapproval_id=$1",[mpId]);
      }
    });
    await t.test('firma falsa no acredita; webhook válido duplicado acredita solo una vez',async()=>{
      facturas.set(facturaId,{id:facturaId,preapproval_id:mpId,currency_id:'MXN',transaction_amount:150,payment:{id:pagoId,status:'approved'}});
      pagos.set(pagoId,{id:pagoId,currency_id:'MXN',transaction_amount:150,status:'approved',date_approved:new Date().toISOString()});
      assert.equal((await request('/webhook/xabor-saas-mp?data.id='+pagoId,{method:'POST',body:{type:'payment',data:{id:pagoId}}})).status,401);
      for(let i=0;i<2;i++)assert.equal((await webhook('payment',pagoId)).status,200);
      assert.equal((await pool.query('SELECT 1 FROM pagos_suscripcion_basico_mp WHERE negocio_id=$1',[a.negocioId])).rowCount,1);
      assert.equal((await request('/api/menu',{cookie:a.cookie})).status,200);
    });
    await t.test('renovación verificada: periodo por factura, sin sumar por reintentos',async()=>{
      await pool.query("UPDATE pagos_suscripcion_basico_mp SET periodo_desde=NOW()-INTERVAL '2 months',periodo_hasta=NOW()-INTERVAL '1 month' WHERE negocio_id=$1",[a.negocioId]);
      renovacionId=facturaId+'8';renovacionPago=pagoId+'8';
      const fecha=new Date().toISOString();
      facturas.set(renovacionId,{id:renovacionId,preapproval_id:mpId,currency_id:'MXN',transaction_amount:150,debit_date:fecha,payment:{id:renovacionPago,status:'approved'}});
      pagos.set(renovacionPago,{id:renovacionPago,currency_id:'MXN',transaction_amount:150,status:'approved',date_approved:fecha});
      assert.equal((await webhook('payment',renovacionPago)).status,200);
      const antes=await request('/api/suscripciones-basico/estado',{cookie:a.cookie});
      assert.equal(antes.data.estado,'activo');assert.equal(antes.data.historial.length,2);
      for(let i=0;i<2;i++)await webhook('payment',renovacionPago);
      const despues=await request('/api/suscripciones-basico/estado',{cookie:a.cookie});
      assert.equal(despues.data.proximaFechaPago,antes.data.proximaFechaPago);
      assert.equal((await request('/api/suscripciones-basico/estado',{cookie:b.cookie})).data.historial.length,0);
    });
    await t.test('gracia configurable cubre solo una renovación reciente y autorizada',async()=>{
      const {consultarEstadoComercialBasico}=await import('../src/services/accesoComercialBasico.js');
      const {rows:[periodo]}=await pool.query('SELECT periodo_desde,periodo_hasta FROM pagos_suscripcion_basico_mp WHERE payment_id=$1',[renovacionPago]);
      await pool.query("UPDATE pagos_suscripcion_basico_mp SET periodo_desde=NOW()-INTERVAL '1 month',periodo_hasta=NOW()-INTERVAL '1 hour' WHERE payment_id=$1",[renovacionPago]);
      const anterior=process.env.XABOR_BASICO_GRACIA_DIAS;
      try{process.env.XABOR_BASICO_GRACIA_DIAS='3';assert.equal((await consultarEstadoComercialBasico(a.negocioId)).estado,'gracia');
        process.env.XABOR_BASICO_GRACIA_DIAS='0';assert.equal((await consultarEstadoComercialBasico(a.negocioId)).permitido,false);
      }finally{if(anterior===undefined)delete process.env.XABOR_BASICO_GRACIA_DIAS;else process.env.XABOR_BASICO_GRACIA_DIAS=anterior;
        await pool.query('UPDATE pagos_suscripcion_basico_mp SET periodo_desde=$2,periodo_hasta=$3 WHERE payment_id=$1',[renovacionPago,periodo.periodo_desde,periodo.periodo_hasta]);}
    });
    await t.test('cancelar conserva periodo y recontratar conserva contratos anteriores',async()=>{
      const c=await request('/api/suscripciones-basico/cancelar',{method:'POST',cookie:a.cookie,body:{},headers:{'X-Xabor-Accion':'cancelar'}});
      assert.equal(c.status,200);assert.equal(contratos.get(mpId).status,'canceled');
      assert.equal((await request('/api/menu',{cookie:a.cookie})).status,200);
      const anteriores=altasMp;
      const rs=await Promise.all([1,2].map(()=>request('/api/suscripciones-basico/checkout',{method:'POST',cookie:a.cookie,body:{},headers:{'X-Xabor-Accion':'contratar'}})));
      assert(rs.some(x=>x.status===200),JSON.stringify(rs));assert.equal(altasMp,anteriores+1);
      const nuevo=[...contratos.values()].at(-1);
      assert.notEqual(nuevo.id,mpId);
      const estado=await request('/api/suscripciones-basico/estado',{cookie:a.cookie});
      assert(Date.parse(nuevo.auto_recurring.start_date)>=Date.parse(estado.data.proximaFechaPago));
      nuevo.status='authorized';await webhook('subscription_preapproval',nuevo.id);
      // Un evento tardío del contrato anterior no modifica la nueva autorización.
      await webhook('subscription_preapproval',mpId);
      assert.equal((await request('/api/suscripciones-basico/estado',{cookie:a.cookie})).data.estadoMercadoPago,'authorized');
      assert.equal((await pool.query('SELECT 1 FROM suscripciones_basico_mp WHERE negocio_id=$1',[a.negocioId])).rowCount,2);
      mpId=nuevo.id;
    });
    await t.test('reembolso revoca el periodo, conserva ledger y resiste un evento atrasado',async()=>{
      pagos.get(renovacionPago).status='refunded';pagos.get(renovacionPago).transaction_amount_refunded=150;
      assert.equal((await webhook('payment',renovacionPago)).status,200);
      assert.equal((await request('/api/menu',{cookie:a.cookie})).status,402);
      pagos.get(renovacionPago).status='approved';pagos.get(renovacionPago).transaction_amount_refunded=0;
      await webhook('payment',renovacionPago);
      assert.equal((await request('/api/menu',{cookie:a.cookie})).status,402);
      assert.equal((await pool.query('SELECT 1 FROM pagos_suscripcion_basico_mp WHERE negocio_id=$1',[a.negocioId])).rowCount,2);
    });
    await t.test('contracargo confirmado suspende el periodo sin borrar ventas',async()=>{
      const id=facturaId+'9',p=pagoId+'9';
      facturas.set(id,{id,preapproval_id:mpId,currency_id:'MXN',transaction_amount:150,payment:{id:p,status:'approved'}});
      pagos.set(p,{id:p,currency_id:'MXN',transaction_amount:150,status:'approved',date_approved:new Date().toISOString()});
      await webhook('payment',p);assert.equal((await request('/api/menu',{cookie:a.cookie})).status,200);
      pagos.get(p).status='charged_back';await webhook('payment',p);
      assert.equal((await request('/api/suscripciones-basico/estado',{cookie:a.cookie})).data.estado,'suspendido');
      assert.equal((await request('/api/menu',{cookie:a.cookie})).status,402);
      assert.equal((await pool.query('SELECT 1 FROM pedidos_activos WHERE negocio_id=$1',[a.negocioId])).rowCount,1);
    });
    await t.test('vencimiento bloquea API; mantiene facturación y negocios anteriores',async()=>{
      await pool.query("UPDATE solicitudes_registro_basico SET used_at=NOW()-INTERVAL '9 days' WHERE negocio_id=$1",[b.negocioId]);
      for(const path of ['/api/menu','/api/ventas','/api/config'])assert.equal((await request(path,{cookie:b.cookie})).status,402,path);
      assert.equal((await request('/api/suscripciones-basico/estado',{cookie:b.cookie})).status,200);
      const {accesoComercialBasico}=await import('../src/services/accesoComercialBasico.js');
      const {rows:[antiguo]}=await pool.query('SELECT id FROM negocios WHERE id NOT IN (SELECT negocio_id FROM solicitudes_registro_basico WHERE negocio_id IS NOT NULL) LIMIT 1');
      assert(await accesoComercialBasico(antiguo.id));
      const status=await new Promise((resolve,reject)=>{
        const ws=new WebSocket(base.replace('http','ws')+'/ws/panel',{headers:{Cookie:b.cookie}});
        ws.on('unexpected-response',(_q,r)=>{r.resume();resolve(r.statusCode);});ws.on('error',reject);
      });
      assert.equal(status,402);
    });
    await t.test('recuperar contraseña invalida la sesión anterior; enlace es de un solo uso',async()=>{
      const r=await request('/api/auth/negocio/forgot-password',{method:'POST',body:{email:b.email}});
      assert.equal(r.status,200);
      const correo=correos.findLast(c=>c.to.includes(b.email)),token=correo.html.match(/\?token=([A-Za-z0-9_-]+)/)[1];
      const nueva='OtraClaveLocalSegura2026!';
      const body={token,password:nueva,passwordConfirm:nueva};
      assert.equal((await request('/api/auth/negocio/reset-password',{method:'POST',body})).status,200);
      assert.equal((await request('/api/suscripciones-basico/estado',{cookie:b.cookie})).status,401);
      assert.equal((await request('/api/auth/negocio/reset-password',{method:'POST',body})).status,409);
      assert.equal((await request('/api/auth/negocio/login',{method:'POST',body:{email:b.email,password:nueva}})).status,200);
    });
    await t.test('conciliación recupera webhook perdido y registra errores administrativos',async()=>{
      const {conciliarLoteBasico}=await import('../src/services/conciliacionBasicoMp.js');
      const {buscarFacturasMpSaasPorContrato}=await import('../src/services/mercadoPagoSaasCliente.js');
      const {conciliarFacturaMercadoPago,conciliarEstadoMercadoPago}=await import('../src/services/suscripcionBasicoMp.js');
      const id=facturaId+'6',p=pagoId+'6';
      facturas.set(id,{id,preapproval_id:mpId,currency_id:'MXN',transaction_amount:150,payment:{id:p,status:'approved'}});
      pagos.set(p,{id:p,currency_id:'MXN',transaction_amount:150,status:'approved',date_approved:new Date().toISOString()});
      const opciones={max:30,
        buscarFacturas:(c,paginacion)=>buscarFacturasMpSaasPorContrato(c,{...paginacion,fetchImpl:(url,opciones)=>{
          const u=new URL(url);assert.equal(u.origin,'https://api.mercadopago.com');
          return fetch(new URL('/api.mercadopago.com'+u.pathname+u.search,'http://127.0.0.1:'+proveedor.address().port),opciones);
        }}),
        conciliarFactura:id=>conciliarFacturaMercadoPago(id,{obtenerFactura:async id=>facturas.get(id),obtenerPago:async id=>pagos.get(String(id)),obtenerPreapproval:async id=>contratos.get(id)}),
        conciliarEstado:id=>contratos.has(id)?conciliarEstadoMercadoPago(id,{obtenerPreapproval:async id=>contratos.get(id)}):Promise.resolve({}),
      };
      const r=await conciliarLoteBasico(opciones);assert(r.acreditadas>=1,JSON.stringify(r));
      assert.equal((await request('/api/menu',{cookie:a.cookie})).status,200);
      await conciliarLoteBasico({...opciones,buscarFacturas:async c=>{if(c===mpId)throw Error('PROVEEDOR_SIMULADO_CAIDO');return [];}});
      assert.equal((await pool.query('SELECT 1 FROM alertas_facturacion_basico WHERE clave=$1 AND resuelta_at IS NULL',['conciliacion:'+mpId])).rowCount,1);
      assert.equal((await request('/api/superadmin/basico/alertas',{cookie:a.cookie})).status,403);
      await conciliarLoteBasico(opciones);
      assert.equal((await pool.query('SELECT 1 FROM alertas_facturacion_basico WHERE clave=$1 AND resuelta_at IS NULL',['conciliacion:'+mpId])).rowCount,0);
      const ledgerAntes=(await pool.query('SELECT COUNT(*)::int AS n FROM pagos_suscripcion_basico_mp WHERE negocio_id=$1',[a.negocioId])).rows[0].n;
      const programadas=[];
      for(let i=0;i<26;i++){
        const id=facturaId+'70'+String(i).padStart(2,'0');programadas.push(id);
        facturas.set(id,{id,preapproval_id:mpId,currency_id:'MXN',transaction_amount:150,status:'scheduled'});
      }
      await conciliarLoteBasico(opciones);
      assert.equal((await pool.query('SELECT conciliacion_offset FROM suscripciones_basico_mp WHERE preapproval_id=$1',[mpId])).rows[0].conciliacion_offset,24);
      await conciliarLoteBasico(opciones);
      assert.equal((await pool.query('SELECT conciliacion_offset FROM suscripciones_basico_mp WHERE preapproval_id=$1',[mpId])).rows[0].conciliacion_offset,0);
      assert.equal((await pool.query('SELECT 1 FROM facturas_suscripcion_basico_mp WHERE authorized_payment_id=ANY($1)',[programadas])).rowCount,26);
      assert.equal((await pool.query('SELECT COUNT(*)::int AS n FROM pagos_suscripcion_basico_mp WHERE negocio_id=$1',[a.negocioId])).rows[0].n,ledgerAntes);
    });
    await t.test('checkout: un rechazo 400 se puede corregir; un 500 tras crear no duplica contratos',async()=>{
      const d=await registrar('qd-'+marca+'@ejemplo.invalid');
      const contratar=()=>request('/api/suscripciones-basico/checkout',{method:'POST',cookie:d.cookie,body:{},headers:{'X-Xabor-Accion':'contratar'}});
      const antes=altasMp;errorAltaMp=400;
      assert.equal((await contratar()).status,503);assert.equal(altasMp,antes);
      const fallido=await pool.query("SELECT 1 FROM suscripciones_basico_mp WHERE negocio_id=$1 AND estado_mp='cancelled' AND preapproval_id IS NULL",[d.negocioId]);
      assert.equal(fallido.rowCount,1);
      assert.equal((await contratar()).status,200);assert.equal(altasMp,antes+1);
      assert.equal((await request('/api/suscripciones-basico/cancelar',{method:'POST',cookie:d.cookie,body:{},headers:{'X-Xabor-Accion':'cancelar'}})).status,200);
      errorAltaMp=500;
      assert.equal((await contratar()).status,503);assert.equal(altasMp,antes+2);
      assert.equal((await contratar()).status,409);assert.equal(altasMp,antes+2);
      const pendiente=await pool.query("SELECT 1 FROM suscripciones_basico_mp WHERE negocio_id=$1 AND estado_mp='creando' AND preapproval_id IS NULL",[d.negocioId]);
      assert.equal(pendiente.rowCount,1);
      assert.equal((await pool.query("SELECT 1 FROM alertas_facturacion_basico WHERE negocio_id=$1 AND tipo='checkout_incierto' AND resuelta_at IS NULL",[d.negocioId])).rowCount,1);
    });
    await t.test('límites de registro atómicos en PostgreSQL, compartidos por réplicas',async()=>{
      const {permitirRegistroBasico}=await import('../src/services/limitesRegistroBasico.js');
      const email='limite-'+marca+'@ejemplo.invalid';
      const rs=await Promise.all([1,2,3,4].map(i=>permitirRegistroBasico({ip:'qa-'+marca+'-'+i,body:{email}})));
      assert.equal(rs.filter(Boolean).length,3);
    });
  } finally {
    if(tokenMpAnterior===undefined)delete process.env.MP_SAAS_ACCESS_TOKEN;else process.env.MP_SAAS_ACCESS_TOKEN=tokenMpAnterior;
    if(proceso.exitCode===null){proceso.kill('SIGTERM');await once(proceso,'exit');}
    await new Promise(r=>proveedor.close(r));
    await pool.end();
    const {poolDeClaims}=await import('../src/services/database.js');await poolDeClaims().end();
  }
});
