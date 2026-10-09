import assert from 'node:assert/strict';
import pg from 'pg';
import { checkoutsSinPedidoOperativo, pagosSinPedidoOperativo } from '../scripts/checkoutOperativo.mjs';
const url = new URL(process.env.DATABASE_URL);
assert(['localhost','127.0.0.1'].includes(url.hostname));
assert.match(url.pathname, /^\/test_botones_/);
const db = new pg.Client({connectionString: url.href});
const negocio = '11111111-1111-4111-8111-111111111111';
const otro = '22222222-2222-4222-8222-222222222222';
let pasadas = 0;
try {
  await db.connect(); await db.query('BEGIN');
  // Tablas temporales: el SQL real se ejecuta sin alterar los datos copiados.
  await db.query(`CREATE TEMP TABLE tienda_pedidos(negocio_id uuid,pedido_folio text,created_at timestamptz);
    CREATE TEMP TABLE pedidos_activos(negocio_id uuid,folio text,estado text,datos jsonb);
    CREATE TEMP TABLE pedidos_programados(negocio_id uuid,folio text,programado_id bigint,activado boolean,programado_para timestamptz,datos jsonb);
    CREATE TEMP TABLE pagos(negocio_id uuid,pedido_folio text,estado text,created_at timestamptz);`);
  const casos = [
    {nombre:'pedido ausente', checkout:1, pago:1},
    {nombre:'programado futuro sin pago', programado:true, sinPago:true, checkout:0,pago:0},
    {nombre:'programado futuro pagado', programado:true, checkout:0,pago:0},
    {nombre:'pago no reflejado en programado',programado:true, confirmado:false,checkout:0,pago:1},
    {nombre:'programado de otro negocio',programado:true,otro:true,checkout:1,pago:1},
    {nombre:'programado vencido sin activar',programado:true,pasado:true,checkout:1,pago:1},
    {nombre:'programado cancelado',programado:true,estado:'cancelado',checkout:1,pago:1},
    {nombre:'programado activado sin pedido',programado:true,activado:true,checkout:1,pago:1},
    {nombre:'programado sin identidad durable',programado:true,sinId:true,checkout:1,pago:1},
    {nombre:'reserva expirada sin pago',programado:true,activado:true,estado:'cancelado',expirado:true,sinPago:true,checkout:0,pago:0},
    {nombre:'reserva expirada con pago',programado:true,activado:true,estado:'cancelado',expirado:true,checkout:1,pago:1},
    {nombre:'pedido activo pagado',activo:true,checkout:0,pago:0},
    {nombre:'activo sin pago confirmado no se oculta con programado',activo:true,confirmado:false,programado:true,checkout:0,pago:1},
  ];
  for(const c of casos){
    await db.query('TRUNCATE tienda_pedidos,pedidos_activos,pedidos_programados,pagos');
    await db.query("INSERT INTO tienda_pedidos VALUES($1,'XAB-PRUEBA',now())",[negocio]);
    if(!c.sinPago)await db.query("INSERT INTO pagos VALUES($1,'XAB-PRUEBA','pagado',now())",[negocio]);
    const datos=JSON.stringify({estado:c.estado||'nuevo',pago_confirmado:c.confirmado!==false,...(c.expirado?{expirado_por_pago:'true'}:{})});
    if(c.programado)await db.query("INSERT INTO pedidos_programados VALUES($1,'XAB-PRUEBA',$2,$3,now()+$4::interval,$5)",[c.otro?otro:negocio,c.sinId?null:1,c.activado||false,c.pasado?'-1 day':'1 day',datos]);
    if(c.activo)await db.query("INSERT INTO pedidos_activos VALUES($1,'XAB-PRUEBA','nuevo',$2)",[negocio,datos]);
    assert.equal((await checkoutsSinPedidoOperativo(db,negocio)).length,c.checkout,c.nombre+' checkout');
    assert.equal((await pagosSinPedidoOperativo(db,negocio)).length,c.pago,c.nombre+' pago');
    pasadas++;
  }
  console.log(`gate de programados: ${pasadas} casos pasados`);
} finally { await db.query('ROLLBACK').catch(()=>{}); await db.end(); }
