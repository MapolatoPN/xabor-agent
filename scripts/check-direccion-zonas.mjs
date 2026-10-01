// Regresiones puras: no base de datos, Meta, pedidos reales ni cobros.
import assert from 'node:assert/strict';
import { crearEjecutor, estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { aplicarRespuestaDeEntrega } from '../src/mesero-agente/canalDelAgente.js';
import { calcularCostoEnvio } from '../src/orders/costoEnvioDelPedido.js';
import { readFileSync } from 'node:fs';
import { evaluarDireccion, direccionPorTexto, respuestaDeDireccion, direccionTextoActiva, olvidarDireccionTexto }
  from '../src/mesero-agente/direccionPorTexto.js';
const reglas = { pedidos: { costo_envio: 60, zonas_entrega: [
  {nombre:'Cervecera',costo:150},
  {nombre:'Coca Cola',costo:120}, {nombre:'UTNC',costo:150},
  {nombre:'Cartonera',costo:120}, {nombre:'COMISION FEDERAL / CARBON 2',costo:200},
] } };
const modalidades = ['recoger en tienda','entrega a domicilio'];
const nuevo = () => {
  const estado = estadoNuevo({negocioId:'prueba',conversacionId:'direccion-zonas'});
  estado.carrito.datos = {modalidad:'entrega a domicilio',costo_envio:60};
  return estado;
};
const entregar = (estado,mensaje,args) => crearEjecutor({estado,reglas,modalidades,mensaje})
  .ejecutar('definir_entrega',args);
let pasadas = 0, fallidas = 0;
const t = async (nombre,fn) => {try {await fn();pasadas++;} catch(e) {fallidas++;console.error(`${nombre}: ${e.message}`);}};
await t('dirección con letras y número juntos',async()=>{
  const estado=nuevo();
  const r=await entregar(estado,'Boulevard cbtis34 208 Col Centro',
    {direccion:'Boulevard Cbtis 34 #208, Col Centro'});
  assert.equal(r.aplicado,true);
  assert.equal(estado.carrito.datos.cliente.direccion,'Boulevard Cbtis 34 #208, Col Centro');
});
for(const direccion of ['Boulevard Cbtis 35 #208 Col Centro','Boulevard Cbtis 34 #280 Col Centro',
  'Calle Nogal 900 Col Centro'])await t(`no inventa números: ${direccion}`,async()=>{
  assert.equal((await entregar(nuevo(),'Boulevard cbtis34 208 Col Centro',{direccion})).aplicado,false);
});
await t('conserva sufijos de domicilio',async()=>{
  assert.equal((await entregar(nuevo(),'Calle Nogal 208A Col Centro',
    {direccion:'Calle Nogal 208B Col Centro'})).aplicado,false);
});
for(const [direccion,costo] of [['Cervecera puerta 2',150],['UTNC edificio principal',150],
  ['Coca-Cola entrada 1',120],['Cocacola entrada 1',120],['Cartonera puerta 2',120],
  ['Comisión Federal acceso 1',200],['Carbón 2 caseta',200],
  ['Calle Centro 208',60],['Calle UTNCita 208',60]]) {
  await t(`tarifa desde dirección sin zona del modelo: ${direccion}`,async()=>{
    const estado=nuevo();
    const r=await entregar(estado,direccion,{direccion});
    assert.equal(r.aplicado,true);assert.equal(estado.carrito.datos.costo_envio,costo);
    assert.equal(calcularCostoEnvio({reglas,modalidad:'domicilio',subtotal:200,
      costoSolicitado:estado.carrito.datos.costo_envio}),costo);
  });
}
await t('dirección nueva elimina tarifa vieja y no depende del costo propuesto',async()=>{
  const estado=nuevo();
  await entregar(estado,'UTNC edificio 1',{direccion:'UTNC edificio 1'});
  assert.equal(estado.carrito.datos.costo_envio,150);
  await entregar(estado,'Ahora a Calle Centro 208',{direccion:'Calle Centro 208'});
  assert.equal(estado.carrito.datos.costo_envio,60);
  assert.equal(calcularCostoEnvio({reglas,modalidad:'domicilio',subtotal:200,
    costoSolicitado:estado.carrito.datos.costo_envio}),60);
});
await t('agregar otro en Flow conserva la tarifa del destino existente',async()=>{
  const estado=nuevo();
  await entregar(estado,'UTNC edificio 1',{direccion:'UTNC edificio 1'});
  await entregar(estado,'entrega a domicilio',{modalidad:'entrega a domicilio'});
  assert.equal(estado.carrito.datos.costo_envio,150);
});
await t('recoger no cobra y volver a domicilio recalcula',async()=>{
  const estado=nuevo();
  await entregar(estado,'UTNC edificio 1',{direccion:'UTNC edificio 1'});
  await entregar(estado,'mejor voy a recoger',{modalidad:'recoger en tienda'});
  assert.equal(estado.carrito.datos.costo_envio,0);
  await entregar(estado,'mejor entrega a domicilio',{modalidad:'entrega a domicilio'});
  assert.equal(estado.carrito.datos.costo_envio,150);
});
await t('negocios distintos no comparten tarifas',()=>{
  assert.equal(calcularCostoEnvio({reglas:{pedidos:{costo_envio:25,zonas_entrega:[]}},
    modalidad:'domicilio',subtotal:200,direccion:'UTNC edificio 1',costoSolicitado:150}),25);
});
await t('dos destinos con tarifas distintas exigen aclaración, sin cambiar el pedido',async()=>{
  const estado=nuevo(),antes=structuredClone(estado.carrito);
  const r=await entregar(estado,'UTNC o Coca Cola',{direccion:'UTNC o Coca Cola'});
  assert.equal(r.aplicado,false);assert.equal(r.codigo,'zona_ambigua');assert.deepEqual(estado.carrito,antes);
});
await t('zona explícita acepta un alias configurado, no uno inventado',async()=>{
  const estado=nuevo();
  const r=await entregar(estado,'Es a Carbón 2 caseta',
    {direccion:'Carbón 2 caseta',zona_entrega:'COMISION FEDERAL / CARBON 2'});
  assert.equal(r.aplicado,true);assert.equal(r.parcial,undefined);assert.equal(estado.carrito.datos.costo_envio,200);
});
await t('no anuncia envío antes de tener dirección',()=>{
  const salida={texto:'¿Cuál es la dirección completa para la entrega?',operaciones:[{
    herramienta:'definir_entrega',resultado:{aplicado:true,pedido:{modalidad:'entrega a domicilio',costo_envio:60}}}]};
  assert.doesNotMatch(aplicarRespuestaDeEntrega({salida}).texto,/\$60/);
});
await t('sí comunica el envío después de resolver la dirección',()=>{
  const salida={texto:'Anotado.',operaciones:[{herramienta:'definir_entrega',resultado:{aplicado:true,
    pedido:{modalidad:'entrega a domicilio',cliente:{direccion:'UTNC edificio 1'},costo_envio:150}}}]};
  assert.match(aplicarRespuestaDeEntrega({salida}).texto,/\$150/);
});

// ── La dirección escrita, capturada sin el modelo (direccionPorTexto.js) ──
// Con la IA apagada nadie más la interpretaría; con la IA prendida, una falla
// del proveedor la perdía (incidente 1-oct-2026). Solo se toma un mensaje que
// es ÚNICAMENTE una dirección; lo demás va al camino de siempre.
const carta=[{productos:[{nombre:'Café Americano'},{nombre:'Jugo verde grande'},{nombre:'Coca Cola'},
  {nombre:'ENSALADA SANTA FE'},{nombre:'Chilaquiles Mixtos'},{nombre:'Hotcakes'},{nombre:'Taco de Barbacoa'}]}];
const zonasObispado={pedidos:{costo_envio:60,zonas_entrega:[{nombre:'UTNC',costo:150},{nombre:'Cervecera',costo:150},
  {nombre:'Coca Cola',costo:120},{nombre:'Cartonera',costo:120},{nombre:'COMISION FEDERAL / CARBON 2',costo:200},
  {nombre:'Escuela Ciencias de la Salud',costo:70}]}};
const leer=(m)=>evaluarDireccion(m,{reglas:zonasObispado,catalogo:carta});
const corpus=JSON.parse(readFileSync(new URL('./corpus-direccion.json',import.meta.url),'utf8'));
const cartaObispado=[{productos:corpus.carta.map((nombre)=>({nombre}))}];
const leerConCarta=(m)=>evaluarDireccion(m,{reglas:zonasObispado,catalogo:cartaObispado});
for(const [mensaje,esperada] of [
  ['Calle Ficticia 123\nColonia Centro','Calle Ficticia 123, Colonia Centro'],
  ['Boulevard cbtis34 208 Col Centro','Boulevard cbtis34 208 Col Centro'],
  ['UTNC edificio 3','UTNC edificio 3'],
  ['Cervecera puerta 2','Cervecera puerta 2'],
  ['UTNC biblioteca','UTNC biblioteca'],
  ['Carbon 2 puerta 3','Carbon 2 puerta 3'],
  ['Escuela Ciencias de la Salud, edificio B','Escuela Ciencias de la Salud, edificio B'],
  ['Calle Nogal 900, casa verde con portón café','Calle Nogal 900, casa verde con portón café'],
  ['Av. Ficticia 450, col. Santa Fe','Av. Ficticia 450, col. Santa Fe'],
  ['Mi dirección es Ficticia 123 Centro','Mi dirección es Ficticia 123 Centro'],
  ['Sí, calle Ficticia 123','Sí, calle Ficticia 123'],
  ['Ficticia 405','Ficticia 405'],['Pino #45','Pino #45'],
  ['Ficticia #405 Centro','Ficticia #405 Centro'],
  ['Ficticia No. 210 col. Centro','Ficticia No. 210 col. Centro'],
  ['Calle 5 de Mayo 123','Calle 5 de Mayo 123'],
  ['Manzana 4 lote 12, Colonia Mundo Nuevo','Manzana 4 lote 12, Colonia Mundo Nuevo'],
  ['Fracc. Las Palmas, mz 7 lt 3','Fracc. Las Palmas, mz 7 lt 3'],
  ['Ficticia 405 26000','Ficticia 405 26000'],
  ['Ficticia 405, frente al depósito','Ficticia 405, frente al depósito'],
  ['Calle Ficticia 300, no hay timbre, toca fuerte','Calle Ficticia 300, no hay timbre, toca fuerte'],
  ['Calle Ficticia 300, a las 3 cuadras del Soriana','Calle Ficticia 300, a las 3 cuadras del Soriana'],
  ['Calle Ficticia 300, 2 cuadras al norte del parque','Calle Ficticia 300, 2 cuadras al norte del parque'],
  ['Ficticia 405 col Centro, junto a la tienda de tortillas','Ficticia 405 col Centro, junto a la tienda de tortillas'],
  ['Allende 300 Centro, entre Morelos y 5 de Mayo','Allende 300 Centro, entre Morelos y 5 de Mayo'],
  ['Ficticia 405, casa blanca y un portón negro','Ficticia 405, casa blanca y un portón negro'],
  ['Ficticia 405 Centro, al otro lado del puente','Ficticia 405 Centro, al otro lado del puente'],
  ['Av. Santo Domingo 120 Col. Roma','Av. Santo Domingo 120 Col. Roma'],
  ['Buenas tarde, Ficticia 405 Centro','Buenas tarde, Ficticia 405 Centro'],
  ['Ficticia 405, frente a la sucursal Banorte','Ficticia 405, frente a la sucursal Banorte'],
  ['Ficticia 405 Centro, es la verde','Ficticia 405 Centro, es la verde'],
  ['Hospital General de Zona No. 11 IMSS, urgencias','Hospital General de Zona No. 11 IMSS, urgencias'],
  // Forma real de Obispado (1-oct): calle S/N, colonia y CP en líneas aparte, y una referencia.
  ['Calle de la Rosa S/N\ncol. Las Flores\n26000\nes frente a la escuela',
    'Calle de la Rosa S/N, col. Las Flores, 26000, es frente a la escuela'],
])await t(`dirección escrita: ${mensaje.replace(/\n/g,' / ')}`,()=>{
  assert.deepEqual(leer(mensaje),{direccion:esperada});
});
// Dos revisiones adversariales del 1-oct: versiones que admitían lo que no
// estuviera prohibido aceptaron 103 de 121 y luego 193 de 230 mensajes que no
// eran solo una dirección. Una muestra de cada familia, con su motivo.
for(const [mensaje,motivo] of [
  ['Sí','corto'],['Ficticia','corto'],['Sean 2','cantidad'],['Mesa 4','otro_pedido'],
  ['¿Llegan a la colonia Centro?','pregunta'],['Calle Ficticia 405 col Centro?','pregunta'],
  ['Llegan hasta la UTNC','pregunta'],['Si llegan a la Cartonera','pregunta'],['Que sean 2','pregunta'],
  ['Cuánto cobran a la Cervecera','pregunta'],['A la colonia Centro si llegan','pregunta'],
  ['Es en Ficticia 405 verdad','pregunta'],
  ['Calle Ficticia 405 col Centro, traigo $200','pago'],
  ['Hay un Oxxo enfrente de la casa','consulta'],
  ['Agrega una coca y es en calle Ficticia 12','decision'],['Mejor paso a recoger','decision'],
  ['Agrégale 2 más','decision'],['Quítenle 2 porfa','decision'],['Ficticia 405 Centro, pónganle mucho queso','decision'],
  ['Calle Ficticia 405 col centro\ny también 2 hotcakes','decision'],['Ficticia 405, me traen salsa verde','decision'],
  ['Calle Ficticia 12, mándame dos hotcakes','decision'],['Ficticia 405 Centro, ocupo factura','decision'],
  ['Perdón, es la calle 6 no la 5','correccion'],['Ficticia 405 Centro, antes Zaragoza 210','correccion'],
  ['Ficticia 405 Centro, ya no vivo en Zaragoza 210','correccion'],['Ficticia 405 Centro, la otra calle no','correccion'],
  ['Ficticia 405 o en la UTNC edificio 3','alternativa'],['Ficticia 405 Centro, si no estoy en Zaragoza 210','alternativa'],
  ['Ficticia 405 Centro, sin cebolla porfa','cocina'],['Ficticia 405 Centro, que no pique','cocina'],
  ['Eran 3 no 4 por favor','cantidad'],['Para 4 personas','cantidad'],['Y una coca cola de lata','cantidad'],
  ['Calle Ficticia 12 col Centro, y 2 refrescos','cantidad'],['Calle Ficticia 405, 2 burritos','cantidad'],
  ['Calle Ficticia 405\ndos tortas de jamón','cantidad'],
  ['Lo recojo en la sucursal 2','modalidad'],['Paso yo en 10','modalidad'],['Comer en el local 5','modalidad'],
  ['Lo paso a traer, estoy en calle Ficticia 200','modalidad'],
  ['Pago con un billete de 500','pago'],['Cambio de 1000','pago'],['Ficticia 405 Centro, llevo 1000','pago'],
  ['Ficticia 405 Centro, en dólares','pago'],
  ['Ahorita te la paso','hora'],['Para las 3 de la tarde','hora'],['En 20 minutos llego','hora'],
  ['Para el 15 de octubre','hora'],['Ficticia 405 Centro, el 15 de octubre','hora'],['Ficticia 405 Centro, a las 2:30','hora'],
  ['Ficticia 405 Centro, en una hora','hora'],['Ficticia 405 Centro, entre semana y 2 de octubre','hora'],
  ['Mi número es 878 123 4567','telefono'],['Mi número es 878.123.4567','telefono'],
  ['Mi esposo 878/123/4567','telefono'],['Te paso mi celular luego','telefono'],
  ['Llámenme 8781234567 al llegar','telefono'],['Calle Ficticia 405 col Centro 7123456','telefono'],
  ['No tengo número exterior','sin_dato'],
  ['Es el pedido 1067','otro_pedido'],['Mesa 4 por favor','otro_pedido'],['La misma de la vez pasada','otro_pedido'],
  ['Es para mi mamá','persona_o_factura'],['Con factura, RFC XAXX010101000','telefono'],['Ficticia 405 Centro, quiero factura','decision'],
  ['Calle Ficticia 12, a nombre de Juan Pérez','persona_o_factura'],
  ['Pásame con una persona, vivo en calle Ficticia 12','persona'],
  ['Ya no, cancélenlo todo','cancelacion'],
  ['Coca cola light por favor','zona_platillo'],['Coca cola de 600','zona_platillo'],
  ['Es en la Coca Cola por favor','zona_platillo'],['Coca Cola planta 2, caseta norte','zona_platillo'],
  ['Calle Ficticia 405 Centro, el café sin azúcar','cocina'],['Ficticia 405 Centro chilaquiles mixtos','producto'],
  ['Calle Ficticia 405\njugo verde grande','producto'],['Calle Ficticia 405, 2 jugos','producto'],
  ['Ficticia 405 Centro, de tomar jugo verde','producto'],
  ['En la Cervecera','solo_zona'],['Estoy en la UTNC','solo_zona'],['En la Cervecera, muchas gracias','solo_zona'],
  ['Calle Ficticia 300, frente a la Cervecera','zona_dudosa'],['Ficticia 405 Centro, ya salí de la UTNC','zona_dudosa'],
  ['UTNC edificio 3 y Cartonera puerta 1','zona_dudosa'],['Cervecera puerta 2, no la 1','zona_dudosa'],['Salgo de la UTNC edificio 3','zona_dudosa'],['Calle 5 numero 12 entre UTNC y Cartonera','zona_dudosa'],
  ['Es en la colonia Centro','sin_ancla'],['Por la plaza, enfrente del parque','sin_ancla'],
  ['Burritos 2 porfa','sin_ancla'],['Pasando el puente unos 3','sin_ancla'],
  ['Ficticia 405 Centro, chilakiles verdes','tramo_ajeno'],['Ficticia 405 Centro, lo de siempre','decision'],
  ['Mz 4 Lt 12','sin_nombre'],
  [`Calle Ficticia 123 ${'muy lejos '.repeat(30)}`,'largo'],
])await t(`no es solo una dirección (${motivo}): ${mensaje.slice(0,40).replace(/\n/g,' / ')}`,()=>{
  assert.deepEqual(leer(mensaje),{direccion:null,motivo});
});
// El corpus completo de las revisiones (614 que no son solo una dirección y
// 379 direcciones): ninguno de los primeros se acepta y al menos el 90 % de
// las direcciones sí. Las que no, las lee el modelo como siempre.
await t('corpus de las revisiones: ningún mensaje que no es solo una dirección se acepta',()=>{
  const aceptados=corpus.negativos.filter((m)=>leerConCarta(m).direccion);
  assert.deepEqual(aceptados,[]);
});
await t('corpus de las revisiones: se aceptan al menos 9 de cada 10 direcciones',()=>{
  const aceptadas=corpus.genuinas.filter((m)=>leerConCarta(m).direccion).length;
  assert.ok(aceptadas>=Math.ceil(corpus.genuinas.length*0.9),`${aceptadas}/${corpus.genuinas.length}`);
});

const conPregunta=(extra={})=>{
  const estado=nuevo();
  estado.carrito.items=[{lid:'l1',id:1,nombre:'Café Americano',cantidad:1,modificadores:[]}];
  estado.pendiente={tipo:'direccion',intentos:1,turno:4};estado.turno=5;
  return Object.assign(estado,extra);
};
const porTexto=(estado,mensaje)=>direccionPorTexto({estado,mensaje,reglas:zonasObispado,catalogo:carta});
await t('solo con la pregunta de dirección abierta de un domicilio en curso',()=>{
  assert.equal(porTexto(conPregunta(),'Calle Ficticia 123').tipo,'aceptada');
  for(const [nombre,estado] of [
    ['otra pregunta',conPregunta({pendiente:{tipo:'pago',opciones:[]}})],
    ['sin pregunta',conPregunta({pendiente:null})],
    ['carrito vacío',(()=>{const e=conPregunta();e.carrito.items=[];return e;})()],
    ['para recoger',(()=>{const e=conPregunta();e.carrito.datos.modalidad='recoger en tienda';return e;})()],
    ['con folio',conPregunta({folio:'XAB-0001'})],
    ['evento',conPregunta({evento:{}})],
    ['confirmación incierta',conPregunta({confirmacionIncierta:true})],
    ['programado sin fecha',conPregunta({programacionRequerida:true})],
    ['escalado',(()=>{const e=conPregunta();e.hechos.escalado=true;return e;})()],
  ])assert.equal(porTexto(estado,'Calle Ficticia 123'),null,nombre);
});
await t('el texto que no es solo una dirección no se apunta como intento',()=>{
  const estado=conPregunta();
  assert.deepEqual(porTexto(estado,'ahorita te la paso'),{tipo:'no_es_direccion',motivo:'hora'});
  assert.equal(estado.direccionTexto,undefined);
});
// Revisión del 1-oct: el contador se reiniciaba si un turno del modelo caía en
// medio y la conversación podía dar vueltas sin llegar nunca a una persona.
await t('a los dos intentos con la pregunta abierta deja de capturar, aunque el modelo conteste en medio',()=>{
  const estado=conPregunta();
  assert.equal(porTexto(estado,'Calle Ficticia 123').tipo,'aceptada');
  estado.turno+=3; // el modelo contestó en medio
  assert.equal(porTexto(estado,'Calle Ficticia 124').tipo,'aceptada');
  assert.deepEqual(porTexto(estado,'Calle Ficticia 125'),{tipo:'agotado'});
});
await t('cerrar la pregunta olvida el contador',()=>{
  const estado=conPregunta();
  porTexto(estado,'Calle Ficticia 123');porTexto(estado,'Calle Ficticia 124');
  estado.pendiente={tipo:'confirmar_resumen',huella:'h'};
  olvidarDireccionTexto(estado);
  assert.equal(estado.direccionTexto,undefined);
  estado.pendiente={tipo:'direccion'};
  assert.equal(porTexto(estado,'Calle Ficticia 126').tipo,'aceptada','pregunta nueva, intentos nuevos');
});
await t('la dirección aceptada sale del pedido guardado, no de un «anotado» previo',async()=>{
  const r=respuestaDeDireccion({tipo:'aceptada',direccion:'Calle Ficticia 123, Colonia Centro'});
  assert.equal(r.desdePedido,true);assert.equal(r.texto,'');assert.equal(r.tipo,'direccion_texto');
  assert.deepEqual(r.acciones,[{herramienta:'definir_entrega',motivo:'direccion_por_texto',
    argumentos:{direccion:'Calle Ficticia 123, Colonia Centro'}}]);
  for(const tipo of ['no_es_direccion','agotado'])assert.equal(respuestaDeDireccion({tipo}),null);
  assert.equal(respuestaDeDireccion(null),null);
  // La acción pasa por el ejecutor con el mensaje original como evidencia.
  const estado=conPregunta();
  const ok=await crearEjecutor({estado,reglas:zonasObispado,modalidades,mensaje:'Calle Ficticia 123\nColonia Centro'})
    .ejecutar('definir_entrega',r.acciones[0].argumentos);
  assert.equal(ok.aplicado,true,ok.motivo);
  assert.equal(estado.carrito.datos.costo_envio,60);
});
await t('una zona con su lugar cobra la tarifa de la zona',async()=>{
  const estado=conPregunta();
  const r=respuestaDeDireccion(porTexto(estado,'UTNC edificio 3'));
  const ok=await crearEjecutor({estado,reglas:zonasObispado,modalidades,mensaje:'UTNC edificio 3'})
    .ejecutar('definir_entrega',r.acciones[0].argumentos);
  assert.equal(ok.aplicado,true,ok.motivo);
  assert.equal(estado.carrito.datos.costo_envio,150);
});
// Decisión de Mario (1-oct): la dirección va en el formulario; esto queda
// apagado y solo se prende a propósito, dentro de la beta híbrida.
await t('apagada por omisión: solo whatsapp_direccion_texto_v1=true la prende',()=>{
  const cfg={whatsapp_beta_hibrido_v1:'true',whatsapp_inicio_mapo_v1:'true',whatsapp_atencion_general_v1:'true',
    bot_whatsapp_solo_prueba:'false'};
  assert.equal(direccionTextoActiva(cfg,'528780000000'),false,'sin la clave');
  for(const apagado of ['false','0','off','no','','si'])
    assert.equal(direccionTextoActiva({...cfg,whatsapp_direccion_texto_v1:apagado},'528780000000'),false,apagado);
  for(const prendido of ['true',' TRUE '])
    assert.equal(direccionTextoActiva({...cfg,whatsapp_direccion_texto_v1:prendido},'528780000000'),true,prendido);
  assert.equal(direccionTextoActiva({...cfg,whatsapp_direccion_texto_v1:'true',whatsapp_beta_hibrido_v1:'false'},
    '528780000000'),false,'fuera de la beta');
});
console.log(`dirección y zonas: ${pasadas} OK, ${fallidas} fallos`);
assert.equal(fallidas,0);
