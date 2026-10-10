// Consulta aislada por negocio y copia manual: transporte/print simulados,
// servidor HTTP real y base LOCAL desechable. No crea trabajos de impresión.
import assert from 'node:assert/strict';
import {randomUUID,createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {programadoParaConsulta,estadoPagoProgramado} from '../src/services/programadosConsulta.js';
const panel=readFileSync(new URL('../panel/programados.js',import.meta.url),'utf8');
const html=readFileSync(new URL('../panel/index.html',import.meta.url),'utf8');
assert(html.includes('/programados.js?v='+createHash('sha256').update(panel).digest('hex').slice(0,8)));
let pasadas=0;
async function caso(nombre,fn){await fn();console.log('OK '+(++pasadas)+': '+nombre);}
const fecha='2026-10-10T13:45:00.000Z';
const datos={estado:'pendiente_pago',pago_confirmado:false,requierePagoAnticipado:true,forma_pago:'enlace_pago',
  programado_para:fecha,cliente:{nombre:'Nury de prueba',telefono:'528780000000',calle:'Calle local',numero_exterior:'10',colonia:'Centro'},
  items:[{nombre:'Combito de Chilaquiles',cantidad:2,precio_unitario:195,modificadores:[{grupo:'Salsa',opcion:'Suiza'}],notas:'Salsa: Suiza · Sin crema'}],
  subtotal:390,costo_envio:60,total:450,modalidad:'entrega a domicilio',notas:'Avisar en caseta',
  tienda:{checkout_token:'SECRETO_CHECKOUT',tracking_token:'SECRETO_TRACKING'},clip_link_id:'SECRETO_PAGO'};
const cfg={nombre:'Mapolato de prueba',reglas_atencion:JSON.stringify({timezone:'America/Matamoros'})};
const p=programadoParaConsulta({folio:'XAB-TEST',negocio_id:'negocio-local',programado_id:'reserva-local',datos,programado_para:new Date('2026-10-10T17:45:00Z')},cfg);
const global={};vm.runInNewContext(panel,{window:global,Intl,Date,Number,Object,Array,String});
await caso('pago por enlace es pendiente; pagado, contra entrega, cancelado y legado no se confunden',()=>{
  assert.equal(p.estado_pago,'pendiente');
  assert.equal(estadoPagoProgramado({...datos,pago_confirmado:true,estado:'nuevo'}),'pagado');
  assert.equal(estadoPagoProgramado({forma_pago:'efectivo',pago_confirmado:false}),'al_recibir');
  assert.equal(estadoPagoProgramado({...datos,estado:'cancelado'}),'cancelado');
  assert.equal(estadoPagoProgramado({}),'por_verificar');
});
await caso('fecha durable prevalece sobre fecha SQL interpretada en zona del host',()=>{
  assert.equal(p.programado_para,fecha);assert.equal(p.timezone,'America/Matamoros');
  assert.match(global.XaborProgramados.fecha(p),/8:45/);
});
await caso('respuesta no filtra tokens ni muta el pedido',()=>{
  for(const s of ['SECRETO_CHECKOUT','SECRETO_TRACKING','SECRETO_PAGO'])assert(!JSON.stringify(p).includes(s));
  assert.equal(datos.tienda.checkout_token,'SECRETO_CHECKOUT');assert.equal(datos.pago_confirmado,false);
});
await caso('copia informa pendiente, dirección, opciones, nota libre y total; nunca es comanda',()=>{
  const copia=global.XaborProgramados.copiaHTML(p);
  for(const s of ['PENDIENTE DE PAGO','COPIA PARA CONSULTA','No preparar','Calle local','Salsa: Suiza','Sin crema','450.00','Avisar en caseta'])assert(copia.includes(s),s);
  assert(!copia.includes('COMANDA'));assert(!copia.includes('<script'));
});
await caso('texto de cliente, dirección y folio no ejecutan HTML en tarjeta o copia',()=>{
  const x={...p,cliente:'<img src=x onerror=alert(1)>',folio:'\" onclick=alert(1) x=\"',direccion:'</p><script>alert(1)</script>'};
  const salida=global.XaborProgramados.copiaHTML(x)+global.XaborProgramados.tarjeta(x);
  assert(!salida.includes('<img'));assert(!salida.includes('<script'));assert(salida.includes('&lt;img'));
  assert(!salida.includes('data-programado-folio="" onclick='));
});
await caso('imprimir relee por GET; doble clic, pedido activado y error no imprimen datos viejos',async()=>{
  let listener,consultas=0,prints=0,abiertos=0;
  const aviso={textContent:''};const boton={disabled:false,dataset:{programadoFolio:p.folio,programadoNegocio:p.negocio_id,programadoId:p.programado_id},closest:()=>({querySelector:()=>aviso})};
  const grid={dataset:{},innerHTML:'',contains:b=>b===boton,addEventListener:(_,fn)=>{listener=fn}};
  const documentos=[];
  global.open=()=>{abiertos++;return {closed:false,document:{write(t){documentos.push(t)},close(){},open(){}},focus(){},print(){prints++},close(){this.closed=true}}};
  global.setTimeout=fn=>fn();
  let liberar;
  global.apiFetch=async(url,opciones)=>{consultas++;assert.equal(url,'/api/pedidos-programados');assert.equal(opciones.cache,'no-store');
    await new Promise(r=>{liberar=r});return {ok:true,json:async()=>[{...p,estado_pago:'pagado',pago_confirmado:true}]};};
  global.XaborProgramados.renderizar([p],grid,{style:{}});
  const e={target:{closest:()=>boton}};listener(e);listener(e);
  assert.equal(consultas,1);assert.equal(abiertos,1);liberar();await new Promise(r=>setTimeout(r,5));
  assert.equal(prints,1);assert.equal(boton.disabled,false);assert(documentos.at(-1).includes('PAGADO'));
  global.apiFetch=async()=>({ok:true,json:async()=>[{...p,negocio_id:'otro-negocio'}]});listener(e);await new Promise(r=>setTimeout(r,5));assert.equal(prints,1);
  global.apiFetch=async()=>({ok:true,json:async()=>[{...p,programado_id:'otra-reserva'}]});listener(e);await new Promise(r=>setTimeout(r,5));assert.equal(prints,1);
  global.apiFetch=async()=>({ok:true,json:async()=>[]});listener(e);await new Promise(r=>setTimeout(r,5));
  assert.equal(prints,1);assert.match(aviso.textContent,/ya no está/);
  global.apiFetch=async()=>({ok:false});listener(e);await new Promise(r=>setTimeout(r,5));assert.equal(prints,1);
  global.open=()=>null;listener(e);assert.match(aviso.textContent,/ventanas emergentes/);
});

if(process.env.SOLO_PURAS!=='1'){
  const url=new URL(process.env.DATABASE_URL);assert(['localhost','127.0.0.1'].includes(url.hostname));
  assert.match(url.pathname,/^\/test_botones_programados_/);assert.match(process.env.NODE_OPTIONS||'',/red-solo-local/);
  const {pool,obtenerPedidosProgramadosPendientes}=await import('../src/services/database.js');
  const {crearTokenSesion}=await import('../src/services/session.js');
  const {arrancarServidor}=await import('./lib-servidor.mjs');
  let servidor;
  const ids=[],usuarios=[],folios=[];
  try{
    for(let i=0;i<2;i++){
      const id=randomUUID(),folio='XAB-LOCAL-'+randomUUID().slice(0,6);ids.push(id);folios.push(folio);
      await pool.query('INSERT INTO negocios(id,nombre,slug,activo) VALUES($1,$2,$3,true)',[id,'Programados locales '+i,'programados-'+id]);
      const {rows:[u]}=await pool.query('INSERT INTO usuarios(negocio_id,nombre,email,activo) VALUES($1,$2,$3,true) RETURNING id',[id,'Personal local','programados-'+id+'@local.test']);
      usuarios.push(u.id);await pool.query("INSERT INTO usuario_negocios(usuario_id,negocio_id,rol,activo) VALUES($1,$2,'staff',true)",[u.id,id]);
      await pool.query("INSERT INTO negocio_modulos(negocio_id,modulo,estado) VALUES($1,'pos','activo')",[id]);
      await pool.query("INSERT INTO configuracion(negocio_id,clave,valor) VALUES($1,'reglas_atencion',$2)",[id,cfg.reglas_atencion]);
      await pool.query('INSERT INTO pedidos_programados(folio,negocio_id,programado_id,datos,programado_para,activado) VALUES($1,$2,$3,$4,$5,false)',
        [folio,id,randomUUID(),JSON.stringify({...datos,programado_para:i===1?undefined:fecha,negocioId:id}),fecha]);
    }
    const snapshot=async()=>({reservas:(await pool.query('SELECT folio,datos,activado FROM pedidos_programados WHERE negocio_id=ANY($1::uuid[]) ORDER BY folio',[ids])).rows,
      trabajos:(await pool.query('SELECT count(*)::int AS n FROM impresion_trabajos WHERE negocio_id=ANY($1::uuid[])',[ids])).rows[0].n});
    const antes=await snapshot();
    servidor=await arrancarServidor({PORT:'4797',TZ:'America/New_York',ADMIN_PASSWORD:'solo-local',PANEL_SECRET:'programados-local',SESSION_SECRET:process.env.SESSION_SECRET||'programados-local',META_APP_SECRET:'solo-local'});
    const cookie=i=>'xabor_sesion='+encodeURIComponent(crearTokenSesion({usuarioId:usuarios[i],negocioId:ids[i],rol:'staff'}));
    await caso('HTTP exige sesión y POS; cada negocio solo recibe su reserva y datos de consulta',async()=>{
      const sin=await fetch(servidor.base+'/api/pedidos-programados');assert([401,403].includes(sin.status));
      for(let i=0;i<2;i++){
        const r=await fetch(servidor.base+'/api/pedidos-programados',{headers:{Cookie:cookie(i)}});
        assert.equal(r.status,200);assert.equal(r.headers.get('cache-control'),'no-store');
        const lista=await r.json();assert.equal(lista.length,1);assert.equal(lista[0].folio,folios[i]);
        assert.equal(lista[0].estado_pago,'pendiente');assert.equal(lista[0].programado_para,fecha);
        assert(!JSON.stringify(lista).includes('SECRETO_'));
      }
      await pool.query("DELETE FROM negocio_modulos WHERE negocio_id=$1 AND modulo='pos'",[ids[1]]);
      const r=await fetch(servidor.base+'/api/pedidos-programados',{headers:{Cookie:cookie(1)}});assert.equal(r.status,403);
    });
    await caso('lector de reservas sin negocio falla cerrado; GET no activa, paga ni crea trabajos',async()=>{
      assert.deepEqual(await obtenerPedidosProgramadosPendientes(null),[]);assert.deepEqual(await snapshot(),antes);
    });
  }finally{servidor?.detener();await pool.end();}
}
console.log('Programados y copia manual: '+pasadas+' casos pasados.');
