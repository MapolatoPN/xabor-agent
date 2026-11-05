import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {validarProgramacion} from '../src/services/tiendaCheckout.js';
import {validarProgramado} from '../src/mesero-agente/programadoDelAgente.js';
import {validarHoraMinimaProgramados} from '../src/services/horarioProgramados.js';
import {programadoParaConsulta} from '../src/services/programadosConsulta.js';
let n=0;const caso=async(nombre,fn)=>{await fn();console.log(`OK agenda ${++n}: ${nombre}`);};
const ahora=new Date('2026-10-15T02:00:00Z'),fecha='2026-10-15';
const horarios=Object.fromEntries(['lunes','martes','miercoles','jueves','viernes','sabado','domingo'].map(d=>[d,{abierto:true,apertura:'07:30',cierre:'15:00'}]));
const reglas={timezone:'America/Matamoros',horarios,programadosDesde:'08:00'};
const tienda={aceptaProgramados:true,anticipacionMinutos:30};
const checkout=(hora,r=reglas)=>validarProgramacion({tienda,reglas:r,programadoPara:fecha+'T'+hora,ahora});
const agente=(hora,r=reglas)=>validarProgramado({fecha,hora,reglas:r,configTienda:tienda,zona:r.timezone,ahora});
await caso('tienda y agente rechazan 07:30 y 07:59; aceptan exactamente 08:00',()=>{
 for(const h of ['07:30','07:59']){assert.throws(()=>checkout(h),e=>e.codigo==='HORA_PROGRAMADA_NO_DISPONIBLE'&&e.message.includes('08:00'));assert.equal(agente(h).motivo,'antes_hora_minima');}
 assert.equal(checkout('08:00').para,'2026-10-15T13:00:00.000Z');assert(agente('08:00').ok);
});
await caso('hora de negocio manda sobre UTC y el host; otro negocio conserva su política',()=>{
 assert.equal(checkout('08:00',{...reglas,timezone:'America/Mexico_City'}).para,'2026-10-15T14:00:00.000Z');
 assert(checkout('07:30',{...reglas,programadosDesde:null}).programado);assert(agente('07:30',{...reglas,programadosDesde:null}).ok);
});
await caso('el mínimo no amplía el cierre ni permite horarios con configuración inválida',()=>{
 assert.throws(()=>checkout('15:00'),e=>e.codigo==='FUERA_DE_HORARIO');
 assert.throws(()=>checkout('08:00',{...reglas,programadosDesde:'error'}));
 assert.equal(validarHoraMinimaProgramados('08:00','25:00').ok,false);
 assert.equal(validarHoraMinimaProgramados('08:00','').ok,true);
});
// El selector de la tienda (horasDe) pregunta la hora con new Date(): si el
// día de la prueba es «hoy», aplica la anticipación sobre la hora actual. Con
// el reloj REAL, este chequeo dependía del día en que corre el predeploy (el
// 5-nov-2026 detuvo todo despliegue: 525/630 en vez de 480). Ahora el selector
// corre con un reloj FIJO en instantes elegidos en la zona del negocio, y los
// casos cubren el día anterior, el propio día (antes de abrir, a media mañana y
// ya cerrado) y el día siguiente. America/Matamoros está en UTC-6 desde el
// 1-nov-2026 (fin del horario de verano).
const relojFijo=(iso)=>{const fijo=Date.parse(iso);return class extends Date{constructor(...a){if(a.length)super(...a);else super(fijo);}static now(){return fijo;}};};
const htmlTienda=readFileSync(new URL('../panel/tienda.html',import.meta.url),'utf8');
const bloquesTienda=(reloj,dia,extra={})=>{
 const inicio=htmlTienda.indexOf('const DIAS_TIENDA ='),fin=htmlTienda.indexOf('function diasProgramables()',inicio);
 const contexto={TIENDA:{...reglas,anticipacionMinutos:30,...extra},Intl,Date:relojFijo(reloj)};
 vm.createContext(contexto);vm.runInContext(htmlTienda.slice(inicio,fin)+'\nthis.horasPrueba=horasDe;',contexto);
 return contexto.horasPrueba(dia);
};
await caso('selector real de tienda oculta horas anteriores al mínimo (reloj fijo, zona del negocio)',()=>{
 // Día anterior: 4-nov 20:00 en Matamoros. El 5 empieza en el mínimo, no en la apertura.
 let bloques=bloquesTienda('2026-11-05T02:00:00Z','2026-11-05');assert.equal(bloques[0],480);assert(!bloques.includes(450));
 assert.equal(bloquesTienda('2026-11-05T02:00:00Z','2026-11-05',{programadosDesde:null})[0],450);
 // El mismo día, antes de abrir (06:00): con 30 min de anticipación sigue siendo 08:00.
 bloques=bloquesTienda('2026-11-05T12:00:00Z','2026-11-05');assert.equal(bloques[0],480);assert(!bloques.includes(450));
 // El mismo día a media mañana (09:10): ni antes del mínimo ni antes de ahora + 30 min, en bloques de 15 → 09:45.
 bloques=bloquesTienda('2026-11-05T15:10:00Z','2026-11-05');assert.equal(bloques[0],585);assert(bloques.every(m=>m>=580));
 // El mismo día ya cerrado (15:00): no queda ninguna hora.
 assert.equal(bloquesTienda('2026-11-05T21:00:00Z','2026-11-05').length,0);
 // Día siguiente, visto desde esa tarde: vuelve a empezar en el mínimo.
 bloques=bloquesTienda('2026-11-05T21:00:00Z','2026-11-06');assert.equal(bloques[0],480);assert(!bloques.includes(450));
});
await caso('una reserva activa conserva pago, fecha, estado visible y zona del negocio sin secretos',()=>{
 const fila={folio:'XAB-LOCAL',activado:true,estado:'en_preparacion',datos:{estado:'nuevo',programado_para:'2026-10-16T13:00:00Z',pago_confirmado:true,tienda:{tracking_token:'SECRETO'}}};
 const antes=JSON.stringify(fila),p=programadoParaConsulta(fila,{timezone:'America/Mexico_City'});
 assert.equal(p.activado,true);assert.equal(p.estado_operativo,'en_preparacion');assert.equal(p.timezone,'America/Mexico_City');assert.equal(p.estado_pago,'pagado');assert(!JSON.stringify(p).includes('SECRETO'));assert.equal(JSON.stringify(fila),antes);
});
const global={document:{hidden:false}};
vm.runInNewContext(readFileSync(new URL('../panel/programados.js',import.meta.url),'utf8'),{window:global,Intl,Date,Number,Object,Array,String});
await caso('tarjeta activa mantiene fecha y estado de preparación',()=>{
 const html=global.XaborProgramados.tarjeta({folio:'XAB-LOCAL',activado:true,estado_operativo:'en_preparacion',estado_pago:'pagado',programado_para:'2026-10-16T13:00:00Z'});
 assert(html.includes('En preparación'));assert(html.includes('PROGRAMADO'));assert(html.includes('Pagado'));
});
await caso('eventos y consultas simultáneas no duplican solicitudes; respaldo de cinco segundos',async()=>{
 let consultas=0,liberar;const timers=[];
 const c=global.XaborProgramados.crearActualizador({cargar:async()=>{consultas++;await new Promise(r=>{liberar=r;});},programar:(fn,ms)=>{timers.push(ms);return timers.length;},cancelar:()=>{}});
 c.configurar(true);const p=c.refrescar();await Promise.resolve();const q=c.alEvento('eliminar_pedido');assert.equal(p,q);assert.equal(consultas,1);liberar();await p;assert.equal(timers.at(-1),5000);c.detener();await c.refrescar();assert.equal(consultas,1);
});
await caso('fallo de consulta se informa y reintenta; negocio sin bandera conserva cinco minutos',async()=>{
 let fallos=0;const timers=[];const c=global.XaborProgramados.crearActualizador({cargar:async()=>{throw Error('local');},alError:()=>fallos++,programar:(fn,ms)=>{timers.push(ms);return 1;},cancelar:()=>{}});
 await c.refrescar();assert.equal(fallos,1);assert.equal(timers.at(-1),300000);assert.equal(c.alEvento('nuevo_pedido'),undefined);
 c.configurar(true);await c.refrescar();assert.equal(timers.at(-1),5000);global.document.hidden=true;await c.refrescar();assert.equal(timers.at(-1),300000);global.document.hidden=false;c.detener();
});
console.log(`Agenda de programados: ${n} grupos correctos.`);
