import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';

const html=readFileSync(new URL('../panel/index.html',import.meta.url),'utf8');
const politica=readFileSync(new URL('../panel/plan-basico-panel.js',import.meta.url),'utf8');
const ventana={};vm.runInNewContext(politica,{window:ventana});
const panel=ventana.XaborPlanBasicoPanel;
const extraer=(inicio,fin)=>html.slice(html.indexOf(inicio),html.indexOf(fin,html.indexOf(inicio)));
const bloqueNav=html.slice(html.indexOf('<div id="tabs-nav">'),html.indexOf('<main style="display:none;">'));
function entorno(){
  const botones=[...bloqueNav.matchAll(/<button\b([^>]*\bid="tab-[^"]+"[^>]*)>/g)].map(m=>({
    id:m[1].match(/\bid="([^"]+)"/)[1],style:{display:/display\s*:\s*none/.test(m[1])?'none':''},
    dataset:{...(m[1].match(/data-modulo="([^"]+)"/)?{modulo:m[1].match(/data-modulo="([^"]+)"/)[1]}:{}),
      ...(m[1].match(/data-modulo-any="([^"]+)"/)?{moduloAny:m[1].match(/data-modulo-any="([^"]+)"/)[1]}:{})},
  }));
  const ids=new Map(botones.map(b=>[b.id,b]));
  const document={body:{classList:{add(){}}},getElementById:id=>ids.get(id)||null,
    querySelectorAll:sel=>sel==='#tabs-nav .tab-btn'?botones:sel==='[data-modulo]'?botones.filter(b=>b.dataset.modulo):sel==='[data-modulo-any]'?botones.filter(b=>b.dataset.moduloAny):[]};
  const contexto={document,MODULOS:['pos','menu','restaurante'],ES_BASICO:true,window:{XaborPlanBasicoPanel:panel}};
  vm.runInNewContext(extraer('function aplicarModulosUI() {','\nfunction primerTabVisible'),contexto);
  vm.runInNewContext(extraer('function navTabDisponible(tab) {','\n// Pantalla que nombra'),{...contexto,NAV_PADRE_DE_TAB:{},NAV_ENTRADA_DE_TAB:{}});
  return{botones,ids,document,contexto};
}

test('el menú real del panel comparte Inicio, Pedidos, Menú, Reportes, Configuración y Suscripción',()=>{
  const e=entorno();e.contexto.aplicarModulosUI();
  assert.deepEqual(e.botones.filter(b=>b.style.display!=='none').map(b=>b.id).sort(),
    ['tab-inicio','tab-comandas','tab-restaurante','tab-menu','tab-ventas','tab-config','tab-suscripcion'].sort());
});
test('un destino premium o desconocido se rechaza aunque se manipule su visibilidad',()=>{
  const e=entorno();
  const contexto={...e.contexto,NAV_PADRE_DE_TAB:{},NAV_ENTRADA_DE_TAB:{}};
  vm.runInNewContext(extraer('function navTabDisponible(tab) {','\n// Pantalla que nombra'),contexto);
  for(const destino of ['chats','tienda','temporada','compras','repartidores','usuarios','nuevo-premium']){
    assert.equal(contexto.navTabDisponible(destino),false,destino);
  }
  assert.equal(contexto.navTabDisponible('menu'),true);
});
test('un negocio anterior conserva su navegación y no recibe la suscripción del Básico',()=>{
  const e=entorno();e.contexto.ES_BASICO=false;e.contexto.aplicarModulosUI();
  assert.equal(e.ids.get('tab-suscripcion').style.display,'none');
  assert.notEqual(e.ids.get('tab-temporada').style.display,'none');
  assert.notEqual(e.ids.get('tab-compras').style.display,'none');
});
test('el HTML compartido y sus scripts inline siguen siendo sintácticamente válidos',()=>{
  for(const m of html.replace(/<!--[\s\S]*?-->/g,'').matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
    if(!/\bsrc\s*=/.test(m[1])&&m[2].trim())new vm.Script(m[2]);
  }
});

test('el arranque carga los permisos antes de consultar avisos; Básico y operadores no los consultan',async()=>{
  const fuente=extraer('function iniciarAvisosPanel() {','\nfunction irALogin()');
  const inicio="fetch('/api/auth/me', { credentials: 'same-origin' }).then(async r => {";
  const desde=html.indexOf(inicio)+inicio.length;
  const arranque=html.slice(desde,html.indexOf('  // Barra de sesión de soporte',desde));
  for(const [rol,modulos,esperados] of [
    ['admin',['pos','menu','restaurante'],0],
    ['staff',['pos','whatsapp'],0],
    ['admin',['pos','whatsapp'],1],
  ]){
    let consultas=0;
    const ctx={ROL:null,MODULOS:[],_conversaciones:[],dataSesion:{rol,modulos,negocioId:'qa-negocio'},apiFetch:()=>{consultas++;},
      window:{XaborAvisosPanel:{iniciar:opciones=>opciones.apiFetch('/api/admin/avisos-panel')}}};
    await vm.runInNewContext(fuente+'\n(async function(r){'+arranque+'})({status:200,ok:true,json:async()=>dataSesion})',ctx);
    assert.equal(consultas,esperados,rol+':'+modulos.join(','));
  }
});
