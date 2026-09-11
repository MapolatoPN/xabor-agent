// Incidente Obispado: un acompañamiento incluido no es un modificador inexistente.
// PostgreSQL local y esquema aislado. Sin modelos ni mensajes externos.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
const url = new URL(process.env.INGREDIENTES_TEST_DATABASE_URL || 'postgresql://postgres@127.0.0.1:55454/postgres');
assert(['localhost','127.0.0.1','[::1]'].includes(url.hostname), 'Solo PostgreSQL local');
const schema = 'ingredientes_' + randomUUID().replaceAll('-', '');
url.searchParams.set('options', '-c search_path=' + schema);
process.env.DATABASE_URL = url.toString();
const db = new pg.Client({ connectionString: url.toString(), ssl: { rejectUnauthorized: false } });
await db.connect();
const { pool } = await import('../src/services/database.js');
const { validarBorradorPedido, mensajeBorradorParaCliente } = await import('../src/orders/validadorOrden.js');
const A=randomUUID(), B=randomUUID(); let pasadas=0, fallidas=0;
const caso=async(nombre,fn)=>{try{await fn();pasadas++;console.log('OK',nombre);}catch(e){fallidas++;console.error('FALLO',nombre,e.message);}};
const hot='Hotcakes Tradicionales', waffle='Waffles';
const borrador=(nombres=[hot,waffle])=>({items:nombres.map(nombre=>({nombre,cantidad:nombre===hot?4:1,modificadores:[]}))});
const validar=(b=borrador(),menciones=['con fruta'],negocio=A,texto='Me puedes mandar 4 platillos de hotkeis con fruta de 139\nY un platillo de waffles con fruta de 149')=>validarBorradorPedido(b,negocio,{textoCiclo:texto,menciones});
const descripcion = (id, texto, negocio=A) => db.query('UPDATE menu_productos SET descripcion=$1 WHERE id=$2 AND negocio_id=$3',[texto,id,negocio]);
try {
  await db.query(`CREATE SCHEMA ${schema};
    CREATE TABLE menu_categorias(id int PRIMARY KEY,activa boolean);
    CREATE TABLE menu_productos(id int,negocio_id uuid,nombre text,descripcion text,precio numeric,disponible boolean,agotado boolean,opciones jsonb,categoria_id int);
    CREATE TABLE menu_modificadores_grupos(id int,producto_id int,negocio_id uuid,nombre text,requerido boolean,minimo int,maximo int,orden int);
    CREATE TABLE menu_modificadores_opciones(id int,grupo_id int,negocio_id uuid,nombre text,precio_extra numeric,disponible boolean,orden int);
    INSERT INTO menu_categorias VALUES(1,true);`);
  for (const negocio of [A,B]) {
    await db.query(`INSERT INTO menu_productos VALUES
      (78,$1,$2,'La orden incluye 2 piezas acompañadas de fruta fresca de temporada.',149,true,false,NULL,1),
      (81,$1,$3,'2 piezas de waffle, acompañados de fruta y algún topping.',159,true,false,NULL,1)`,[negocio,hot,waffle]);
    await db.query(`INSERT INTO menu_modificadores_grupos VALUES(1,78,$1,'Topping',true,1,4,0),(2,81,$1,'Topping',true,1,4,0)`,[negocio]);
    for (const [grupo,nombres] of [[1,['Tradicional','Nutella','Hersheys','Cajeta','Lechera','Chispas de Chocolate','Blueberries Cheesecake']],[2,['Miel y Mantequilla','Nutella','Hersheys','Cajeta','Lechera','Blueberries Cheesecake']]]) {
      for (const [i,nombre] of nombres.entries()) await db.query('INSERT INTO menu_modificadores_opciones VALUES($1,$2,$3,$4,$5,true,$6)',[grupo*20+i,grupo,negocio,nombre,i?30:0,i]);
    }
  }
  await caso('pedido real: no niega fruta y sigue preguntando ambas elecciones obligatorias',async()=>{
    const r=await validar(), texto=mensajeBorradorParaCliente(r);
    assert.doesNotMatch(texto,/no manejamos|no tenemos/);
    assert.match(texto,/Hotcakes Tradicionales/); assert.match(texto,/Waffles/);
    assert.equal(r.ok,false); assert.equal(r.productos.length,2);
    for(const p of r.productos){assert.equal(p.elegidas.length,0);assert.equal(p.faltantes.length,1);}
  });
  await caso('ingrediente desconocido no queda autorizado por existir fruta',async()=>{
    await assert.rejects(validar(borrador(),['con mango'],'', ''),/negocioId obligatorio/);
    const desconocido=await validar(borrador(),['con mango'],A,'Hotcakes y waffles con mango');
    assert.match(mensajeBorradorParaCliente(desconocido),/no manejamos/);
  });
  for(const desc of ['No incluye fruta.','Puede acompañarse de fruta.','Incluye fruta opcional.','Incluye pan o fruta.','Incluye fruta con costo adicional.','No siempre incluye fruta.','Incluye pan. La fruta se cobra aparte.','No incluye pan y fruta.','Si lo solicitas incluye fruta.','Incluye fruta y pan con costo adicional.','Incluye fruta excepto domingos.']) {
    await caso('no convierte descripción condicional en ingrediente incluido: '+desc,async()=>{
      await descripcion(81,desc);
      const r=await validar(borrador([waffle]));
      assert.equal(r.mencionesNoResueltas.length,1);
    });
  }
  await caso('no toma acompañamiento de otro platillo ni de otro negocio',async()=>{
    await descripcion(81,'Incluye miel y mantequilla.');
    const r=await validar(borrador([waffle])); assert.equal(r.mencionesNoResueltas.length,1);
    const otro=await validar(borrador([waffle]),['con fruta'],B);
    assert.equal(otro.mencionesNoResueltas.length,0);
    const mixto=await validar();
    assert.doesNotMatch(mensajeBorradorParaCliente(mixto),/no manejamos "con fruta"/);
    assert.match(mensajeBorradorParaCliente(mixto),/a qu[eé] platillo/i);
  });
  await caso('una fruta incluida no autoriza cantidad extra',async()=>{
    await descripcion(81,'Acompañados de fruta y algún topping.');
    for(const span of ['extra fruta','doble fruta','sin fruta']){
      const r=await validar(borrador([waffle]),[span],A,`Waffles ${span}`);
      assert.equal(r.mencionesNoResueltas.length,1);
    }
  });
  await caso('topping real se conserva y no desaparece por aparecer en la descripción',async()=>{
    await descripcion(81,'Acompañados de fruta y Nutella.');
    const b=borrador([waffle]); b.items[0].modificadores=['Nutella'];
    const r=await validar(b,['con fruta'],A,'Waffles con fruta y Nutella');
    assert.equal(r.ok,true); assert.equal(r.productos[0].elegidas[0].opcion,'Nutella');
  });
  await caso('las preguntas iguales se conservan para productos diferentes y se deduplican por producto',async()=>{
    await db.query("UPDATE menu_modificadores_opciones SET nombre='Tradicional' WHERE grupo_id=2 AND precio_extra=0 AND negocio_id=$1",[A]);
    const r=await validar(borrador([hot,hot,waffle]),[],A,'Hotcakes y waffles');
    const texto=mensajeBorradorParaCliente(r);
    assert.equal((texto.match(/Hotcakes Tradicionales/g)||[]).length,1);
    assert.equal((texto.match(/Waffles/g)||[]).length,1);
  });
  console.log(`${pasadas} aprobadas, ${fallidas} fallidas`); if(fallidas)process.exitCode=1;
} finally { await pool.end(); await db.query(`DROP SCHEMA ${schema} CASCADE`); await db.end(); }
