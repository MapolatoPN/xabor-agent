// Sprint de cierre — UX inmediata del bot. Cuatro defectos vistos en uso real:
//  P0 aviso de horario demasiado tarde (después de armar todo el pedido)
//  P1 preguntas dobles que vuelven ambiguo un "sí"
//  P2 Markdown escapado/doble asterisco visible para el cliente
//  P3 selector de giro cae a "Otro..." tras un PATCH
//
// PRUEBA ROJA: BOT_FUENTES_DIR=<dir con prompts.js/brain.js/server.js/
//   panel/superadmin.html previos> reproduce los defectos contra la versión
//   ANTERIOR (los contratos de fuente fallan). Sin esa variable, corre contra
//   el repo actual (deben pasar).
//
// El normalizador (P2) es una función pura y se prueba en vivo. Los flujos
// de prompt (P0/P1) y las hidrataciones (P3) se verifican por contrato sobre
// la fuente desplegable — no hay LLM en la suite, igual que el resto de las
// pruebas de prompt del repo (BRAIN_FUENTES_DIR).
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const FUENTES = process.env.BOT_FUENTES_DIR || RAIZ;
const leer = (rel) => {
  const p = join(FUENTES, rel);
  return existsSync(p) ? readFileSync(p, 'utf8') : readFileSync(join(RAIZ, rel), 'utf8');
};
const PROMPTS = leer('src/agent/prompts.js');
const BRAIN = leer('src/agent/brain.js');
const SERVER = leer('src/server.js');
const SUPERADMIN = leer('panel/superadmin.html');

// El normalizador se importa SIEMPRE del repo actual (si no existe en la
// versión previa, el contrato P2 sobre la fuente ya marca el rojo).
let normalizar = null;
try { ({ normalizarFormatoWhatsApp: normalizar } = await import('../src/utils/formatoWhatsapp.js')); } catch { /* rojo por contrato */ }
const { obtenerEstadoRestaurante, formatearHorarioTexto } = await import('../src/agent/prompts.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

// ═══ P0 — HORARIO ANTES DE ARMAR (contrato de fuente) ═══════════════════════
t('1. el prompt exige avisar el horario ANTES de armar el pedido', () => {
  assert.ok(/AVISA EL HORARIO ANTES DE ARMAR EL PEDIDO/.test(PROMPTS),
    'falta la regla de aviso temprano (esperado FALLO contra la versión previa)');
});
t('2. cerrado/pre-apertura: primera respuesta a intención de compra avisa horario', () => {
  assert.ok(/tu PRIMERA respuesta debe avisarle el horario ANTES de empezar a preguntarle/.test(PROMPTS));
  assert.ok(/puedo tomar tu pedido desde ahora/i.test(PROMPTS), 'ofrece pedido anticipado');
});
t('3. el horario se avisa UNA SOLA VEZ por conversación', () => {
  assert.ok(/UNA SOLA VEZ POR CONVERSACIÓN/.test(PROMPTS));
  assert.ok(/NO se lo repitas en cada mensaje/.test(PROMPTS));
});
t('4. tras el aviso, se toma el pedido con normalidad (no se fuerza)', () => {
  assert.ok(/si el cliente quiere continuar, arma el pedido con normalidad; si no quiere esperar, ciérralo sin fricción/.test(PROMPTS));
});
t('5. pre-apertura en el bloque de estado también obliga a avisar primero', () => {
  assert.ok(/AVÍSALE ESTO PRIMERO \(antes de preguntarle qué quiere\)/.test(PROMPTS));
});
t('6. no inventa horario: el estado sale de las reglas reales', () => {
  // obtenerEstadoRestaurante deriva todo de reglas.horarios (no hardcode).
  const estado = obtenerEstadoRestaurante({ horarios: { lunes:{abierto:false,apertura:null,cierre:null}, martes:{abierto:false}, miercoles:{abierto:false}, jueves:{abierto:false}, viernes:{abierto:false}, sabado:{abierto:false}, domingo:{abierto:false} } });
  assert.strictEqual(estado.abierto, false);
  assert.strictEqual(estado.preApertura, false, 'día sin servicio no es pre-apertura');
});
t('7. timezone del negocio: se usa America/Matamoros, no UTC', () => {
  assert.ok(/America\/Matamoros/.test(PROMPTS), 'la hora se calcula en la zona del negocio');
});
t('8. día sin horario: formatearHorarioTexto lo marca cerrado, no inventa', () => {
  const txt = formatearHorarioTexto({ lunes:{abierto:true,apertura:'11:00',cierre:'22:00'}, martes:{abierto:true,apertura:'11:00',cierre:'22:00'}, miercoles:{abierto:true,apertura:'11:00',cierre:'22:00'}, jueves:{abierto:true,apertura:'11:00',cierre:'22:00'}, viernes:{abierto:true,apertura:'11:00',cierre:'22:00'}, sabado:{abierto:true,apertura:'11:00',cierre:'22:00'}, domingo:{abierto:false} });
  assert.ok(/Domingo: cerrado/.test(txt), 'el domingo sin servicio se marca cerrado');
});
t('9. pedido anticipado soportado: el validador NO bloquea por horario', () => {
  const VAL = leer('src/orders/validadorOrden.js');
  // El validador solo usa el estado para promos, nunca para rechazar por
  // cerrado/pre-apertura -> un pedido anticipado se puede emitir.
  assert.ok(!/RESTAURANTE_CERRADO|estado\.abierto[^]*rechaz|rechaz[^]*estado\.abierto/.test(VAL),
    'el validador no debe rechazar por horario (soporta pedido anticipado)');
});
t('10. dentro de horario no cambia: sigue existiendo el estado ABIERTO', () => {
  assert.ok(/Estado del restaurante: \$\{estado\.abierto \? 'ABIERTO'/.test(PROMPTS));
});

// ═══ P1 — PREGUNTAS DOBLES (contrato de fuente) ═════════════════════════════
t('11. combo terminado → una sola pregunta (regla explícita)', () => {
  assert.ok(/UNA DECISIÓN POR PREGUNTA/.test(PROMPTS),
    'falta la regla de una decisión por pregunta (esperado FALLO contra la versión previa)');
});
t('12/13. prohíbe combinar confirmación con "algo más" (el "sí" ambiguo)', () => {
  assert.ok(/NUNCA combines una pregunta de confirmación con una de "algo más"/.test(PROMPTS));
  assert.ok(/¿Es correcto\? ¿Quieres agregar algo más\?/.test(PROMPTS), 'nombra el anti-patrón exacto');
});
t('14. recoger/domicilio separado de la hora', () => {
  assert.ok(/¿será para recoger o a domicilio\?" primero, y "¿para qué hora\?" después/.test(PROMPTS));
});
t('15. pago separado de la confirmación', () => {
  assert.ok(/la confirmación del pedido va separada de "¿pagas con tarjeta\?"/.test(PROMPTS));
});
t('16. el flujo de pedido sigue intacto (pasos numerados presentes)', () => {
  assert.ok(/## TU TRABAJO/.test(PROMPTS) && /Pide confirmación explícita al cliente/.test(PROMPTS));
});

// ═══ P2 — MARKDOWN (normalizador vivo + contrato de capa) ═══════════════════
t('17. negrita Markdown **texto** → negrita WhatsApp *texto*', () => {
  assert.ok(normalizar, 'el normalizador debe existir (esperado FALLO contra la versión previa)');
  assert.strictEqual(normalizar('**Resumen final:**'), '*Resumen final:*');
  assert.strictEqual(normalizar('- **2 La Peperoni** — $159'), '- *2 La Peperoni* — $159');
});
t('18. asteriscos escapados \\* → * (el defecto observado)', () => {
  assert.strictEqual(normalizar('\\*\\*1. ¿Cuál media focaccia?\\*\\*'), '*1. ¿Cuál media focaccia?*');
});
t('19. texto sin markdown queda intacto', () => {
  const s = 'Perfecto, tomamos nota. Tu total es $250.';
  assert.strictEqual(normalizar(s), s);
});
t('20. un solo asterisco y multiplicación literal NO se tocan', () => {
  assert.strictEqual(normalizar('precio *especial* hoy'), 'precio *especial* hoy');
  assert.strictEqual(normalizar('2 * 3 = 6'), '2 * 3 = 6');
});
t('21. no introduce HTML/entidades', () => {
  const out = normalizar('**Hola** <b>x</b> & "y"');
  assert.ok(!/&lt;|&amp;|&quot;/.test(out), 'no escapa a entidades HTML');
  assert.strictEqual(out, '*Hola* <b>x</b> & "y"');
});
t('22. encabezados Markdown se limpian; el contenido permanece', () => {
  assert.strictEqual(normalizar('### Menú del día\nFocaccia'), 'Menú del día\nFocaccia');
});
t('22b. limpiarTexto aplica el normalizador (capa correcta: antes de guardar/enviar)', () => {
  assert.ok(/import \{ normalizarFormatoWhatsApp \} from '\.\.\/utils\/formatoWhatsapp\.js'/.test(BRAIN),
    'brain.js debe importar el normalizador');
  assert.ok(/return normalizarFormatoWhatsApp\(sinTags\)/.test(BRAIN),
    'limpiarTexto debe normalizar el texto final (esperado FALLO contra la versión previa)');
});
t('22c. el prompt ya no contiene Markdown de doble asterisco propio', () => {
  // El bloque de rentas usaba **Repisas**/**Islas** que el modelo copiaba.
  assert.ok(!/\*\*Repisas\*\*|\*\*Islas\*\*/.test(PROMPTS));
  assert.ok(/FORMATO WHATSAPP, NO MARKDOWN/.test(PROMPTS), 'instrucción de formato presente');
});

// ═══ P3 — SUPERADMIN GIRO "OTRO..." (contrato de fuente) ════════════════════
t('23/24/25. el PATCH devuelve girosSugeridos (misma forma que el GET)', () => {
  // Causa raíz: la respuesta del PATCH no traía el catálogo -> pintarAsistenteIA
  // caía a "Otro..." para giros conocidos como restaurante.
  assert.ok(/res\.json\(\{ ok: true, \.\.\.estado, girosSugeridos: GIROS_SUGERIDOS \}\)/.test(SERVER),
    'el PATCH debe devolver girosSugeridos (esperado FALLO contra la versión previa)');
});
t('26/27/28. la UI recuerda el catálogo y no depende de que la respuesta lo traiga', () => {
  assert.ok(/let girosCatalogo = \[\]/.test(SUPERADMIN), 'catálogo recordado entre llamadas');
  assert.ok(/if \(Array\.isArray\(d\.girosSugeridos\) && d\.girosSugeridos\.length\) girosCatalogo = d\.girosSugeridos/.test(SUPERADMIN));
  assert.ok(/const sugeridos = girosCatalogo/.test(SUPERADMIN), 'usa el catálogo recordado, no d.girosSugeridos directo');
});
t('29. guardar no duplica configuracion (upsert por clave, sin cambios de esquema)', () => {
  const DB = leer('src/services/database.js');
  assert.ok(/ON CONFLICT \(negocio_id, clave\) DO UPDATE SET valor = EXCLUDED\.valor/.test(DB));
});
t('30. error del backend → la UI recarga el estado real (no queda mintiendo)', () => {
  assert.ok(/cargarAsistenteIA\(negocioActualId\)/.test(SUPERADMIN));
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
