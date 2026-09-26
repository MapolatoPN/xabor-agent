// Catálogo de solo lectura, proveedor real, transporte y registro simulados.
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { atenderTurnoConHerramientas } from '../src/mesero-agente/agenteDelMesero.js';
import { estadoNuevo } from '../src/mesero-agente/ejecutorDeHerramientas.js';
import { acusarDialogo } from '../src/mesero-agente/contratoConversacional.js';
import { llamarModeloDelAgente } from '../src/mesero-agente/modeloDelAgente.js';
import { reglasDelAsistenteEnTexto } from '../src/mesero-agente/reglasDelAsistente.js';
const [entrada, destino] = process.argv.slice(2);
assert(entrada && destino && process.env.ANTHROPIC_API_KEY);
const d = JSON.parse(readFileSync(entrada, 'utf8').replace(/^\uFEFF/, ''));
let estado = estadoNuevo({ negocioId:'evaluacion-aislada', conversacionId:'piloto-integral' });
let registros=0; const turnos=[];
const mensajes = ['Hola',
  'Quiero chilaquiles mixtos con salsa suiza y chipotle, huevos estrellados, frijolitos naturales y papas con chorizo',
  'A domicilio y pagaré en efectivo',
  'La dirección es Calle Hidalgo 123, colonia Obispado, Monterrey, casa azul',
  'Agrega un omelette clásico',
  'Tortillas de maíz y agrega un licuado',
  'Grande de plátano con fresa extra, chocolate, vainilla, leche entera y Splenda',
  'Agrega tacos de chicharrón prensado con tortilla de maíz',
  'Agrega un taco de huevo con machacado con tortilla de harina',
  'Agrega un taco de barbacoa con tortilla de maíz',
  'Todavía no confirmes, espera',
  'No canceles mi pedido',
  'Sí, confirmo'];
try {
  for(const mensaje of mensajes) {
    const r = await atenderTurnoConHerramientas({estado,mensaje,catalogo:d.catalogo,
      reglas:d.reglas,metodosPago:d.metodosPago,modalidades:d.reglas.pedidos.modalidades,
      zonaDelNegocio:d.reglas.timezone,
      llamarModelo:p=>llamarModeloDelAgente({...p,model:process.env.MESERO_AGENTE_MODELO||p.model},{clave:process.env.ANTHROPIC_API_KEY}),
      efectos:{confirmar:async()=>{registros++;return{ok:true,folio:'SIMULADO'};},escalar:async()=>({ok:true})},
      contexto:{nombreNegocio:d.nombre,textoCiclo:mensaje,tono:d.reglas.bot?.tono,
        reglasDelNegocio:reglasDelAsistenteEnTexto(d.reglas,{esPrimerTurno:estado.turno===0})}});
    turnos.push({mensaje,texto:r.texto,pedido:r.pedido,operaciones:r.operaciones});
    console.log(JSON.stringify({mensaje,texto:r.texto,estado:r.pedido.estado}));
    assert(!r.escalado && !r.error, 'El recorrido requiere atención sin fallos');
    if(mensaje!=='Sí, confirmo') assert.equal(registros,0,'No hay autorización para confirmar');
    if(mensaje.startsWith('Tortillas')) {
      assert(r.pedido.lineas.some(l=>l.producto==='Licuado'),'No omitir el producto tras la elección');
      assert(r.pedido.lineas.find(l=>/Omelette/.test(l.producto)).opciones.some(o=>/ma[ií]z/i.test(o.opcion)));
    }
    assert(acusarDialogo(estado,r.dialogoId,r.texto));
    estado=JSON.parse(JSON.stringify(estado));
  }
  const p=turnos.at(-1).pedido;
  assert.equal(p.estado,'confirmado'); assert.equal(registros,1); assert.equal(p.lineas.length,6);
  assert.match(p.modalidad,/domicilio/); assert.equal(p.forma_pago,'efectivo');
  assert.match(p.cliente.direccion,/Hidalgo.*123/);
  const ch=p.lineas.find(l=>l.producto==='Chilaquiles Mixtos'); assert(ch,'Respetar la variante mixta');
  assert.deepEqual(ch.opciones.filter(o=>o.grupo==='Salsa').map(o=>o.opcion).sort(),['Chipotle','Suiza']);
  assert.deepEqual(ch.opciones.filter(o=>o.grupo==='Guarniciones').map(o=>o.opcion).sort(),['Frijolitos naturales','Papas con chorizo']);
  assert(p.lineas.every(l=>l.cantidad===1));
  console.log('OK piloto integral real: seis productos, mixtos, guarniciones, mensaje compuesto, domicilio, negaciones y una confirmación.');
} finally { writeFileSync(destino,JSON.stringify({registrosSimulados:registros,turnos},null,2)); }
