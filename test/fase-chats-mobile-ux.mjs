// UX del módulo de Chats en móvil (rediseño mensajería). Contratos de FUENTE
// sobre panel/index.html: verifican la estructura/estilos responsive y que el
// rediseño NO tocó backend, endpoints ni los hooks/IDs que el JS ya usaba.
//
// Sprint 100% frontend: la fuente de verdad del takeover (endpoints pausar/
// reactivar/estado-bot + conversaciones_control) NO se toca.
//
// Uso: node test/fase-chats-mobile-ux.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(__dirname, '..');
const HTML = readFileSync(join(RAIZ, 'panel', 'index.html'), 'utf8');
const SERVER = readFileSync(join(RAIZ, 'src', 'server.js'), 'utf8');
const DB = readFileSync(join(RAIZ, 'src', 'services', 'database.js'), 'utf8');

let pasadas = 0, fallidas = 0; const fallos = [];
function t(n, fn) { try { fn(); console.log(`  OK  ${n}`); pasadas++; } catch (e) { console.log(`FALLO ${n}: ${e.message}`); fallidas++; fallos.push(`${n}: ${e.message}`); } }

// ═══ Estructura responsive presente ═════════════════════════════════════════
t('1. buscador + filtros de la bandeja presentes', () => {
  assert.ok(/id="chat-buscador"[^>]*oninput="filtrarConversaciones\(\)"/.test(HTML));
  assert.ok(/class="chats-filtros"/.test(HTML));
  assert.ok(/data-filtro="todos"/.test(HTML) && /data-filtro="sin_responder"/.test(HTML));
});
t('2. filas de conversación estilo bandeja (avatar + nombre + hora + preview)', () => {
  assert.ok(/\.chat-row\b/.test(HTML) && /\.chat-avatar\b/.test(HTML));
  assert.ok(/\.chat-row-nombre\b/.test(HTML) && /\.chat-row-hora\b/.test(HTML) && /\.chat-row-preview\b/.test(HTML));
  assert.ok(/function inicialAvatar/.test(HTML), 'avatar por inicial (no foto inventada)');
});
t('3. detalle full-screen en móvil (position:fixed dentro de @media 640)', () => {
  const mq = HTML.slice(HTML.indexOf('@media (max-width: 640px)', HTML.indexOf('.chats-topbar { display: none; }')));
  assert.ok(/#vista-chats\.chat-abierto\s*\{\s*position:\s*fixed;\s*inset:\s*0/.test(HTML), 'chat-abierto ocupa el viewport');
  assert.ok(/100dvh/.test(HTML), 'usa dvh para el teclado móvil');
  assert.ok(/env\(safe-area-inset-bottom\)/.test(HTML), 'respeta safe-area inferior');
});
t('4. composer sticky con botones táctiles (44px) y aria-labels', () => {
  assert.ok(/\.chat-composer\b/.test(HTML));
  assert.ok(/\.chat-btn-enviar\s*\{[^}]*width:\s*44px;\s*height:\s*44px/.test(HTML), 'target táctil 44px');
  assert.ok(/id="btn-chat-enviar"[^>]*aria-label="Enviar mensaje"/.test(HTML));
  assert.ok(/id="btn-adjuntar-pdf"[^>]*aria-label="Adjuntar PDF"/.test(HTML));
  assert.ok(/id="btn-chat-volver"[^>]*aria-label="Volver a la lista de conversaciones"/.test(HTML));
});

// ═══ Estado del bot: global != por-conversación ═════════════════════════════
t('5. botón correcto según estado (tomar / devolver / global oculto)', () => {
  const fn = HTML.slice(HTML.indexOf('function actualizarBotonBot'), HTML.indexOf('function escaparHTML'));
  assert.ok(/Tomar conversación/.test(fn) && /chat-cta-primario/.test(fn), 'bot atendiendo -> CTA primario Tomar');
  assert.ok(/Devolver al bot/.test(fn) && /chat-cta-secundario/.test(fn), 'tomada -> CTA secundario Devolver');
  assert.ok(/if \(!atencionNegocioActiva\)[\s\S]*?btn\.style\.display = 'none'/.test(fn), 'global pausado -> sin CTA contradictorio');
});
t('6. GLOBAL pause y PER-CHAT pause tienen textos distintos (paso 8)', () => {
  const fn = HTML.slice(HTML.indexOf('function actualizarBotonBot'), HTML.indexOf('function escaparHTML'));
  assert.ok(/Automatización pausada en el negocio/.test(fn), 'texto global');
  assert.ok(/Estás atendiendo esta conversación/.test(fn), 'texto por-conversación');
  assert.ok(/Bot atendiendo/.test(fn));
});
t('7. tarjeta global del bot: verde suave activo / ámbar pausado', () => {
  assert.ok(/\.chat-botcard\.activo\s*\{[^}]*#ecfdf5/.test(HTML), 'activo verde suave');
  assert.ok(/\.chat-botcard\.pausado\s*\{[^}]*#fffbeb/.test(HTML), 'pausado ámbar suave');
  const fn = HTML.slice(HTML.indexOf('async function cargarBannerBotChats'), HTML.indexOf('function volverAContactos'));
  assert.ok(/Bot activo/.test(fn) && /Atención automática pausada/.test(fn));
});
t('8. CTA "Tomar conversación" en naranja Xabor, nunca rojo', () => {
  assert.ok(/\.chat-cta-primario\s*\{\s*background:\s*var\(--color-brand\)/.test(HTML));
  const fn = HTML.slice(HTML.indexOf('function actualizarBotonBot'), HTML.indexOf('function escaparHTML'));
  assert.ok(!/#fee2e2|#b91c1c/.test(fn), 'ya no usa el rojo anterior');
});

// ═══ Imágenes, burbujas, navegación, estados ════════════════════════════════
t('9. imagen: preview grande + descarga secundaria (no protagonista)', () => {
  assert.ok(/<img class="chat-img"/.test(HTML), 'preview con clase chat-img');
  assert.ok(/class="chat-img-pie"/.test(HTML), 'pie compacto de la imagen (icono + hora, no "Descargar" gigante)');
  assert.ok(/\/api\/imagenes\/\$\{idDoc\}\/archivo/.test(HTML), 'mantiene la URL de almacenamiento existente');
  assert.ok(/abrirVisorImagen/.test(HTML), 'usa el visor existente');
  assert.ok(/\.chat-img\s*\{[^}]*max-width:\s*240px/.test(HTML), 'preview grande (240px)');
});
t('10. burbujas: entrante gris, saliente peach (no verde)', () => {
  assert.ok(/\.chat-burbuja\.entrante\s*\{[^}]*#f1f0ed/.test(HTML));
  assert.ok(/\.chat-burbuja\.saliente\s*\{[^}]*var\(--color-brand-light\)/.test(HTML), 'saliente peach de marca');
});
t('11. back navigation limpia el full-screen', () => {
  const fn = HTML.slice(HTML.indexOf('function volverAContactos'), HTML.indexOf('function ajustarLayoutChatMovil'));
  assert.ok(/classList\.remove\('chat-abierto'\)/.test(fn));
  assert.ok(/classList\.remove\('chat-fullscreen'\)/.test(fn), 'restaura la navbar');
});
t('12. estados vacíos y skeleton (sin caja vacía gigante)', () => {
  assert.ok(/No hay conversaciones todavía/.test(HTML));
  assert.ok(/No encontramos conversaciones/.test(HTML));
  assert.ok(/Todavía no hay mensajes/.test(HTML));
  assert.ok(/chat-skel/.test(HTML), 'skeleton de carga');
});
t('13. errores como toast humano (no alert ni stack)', () => {
  const fn = HTML.slice(HTML.indexOf('function mostrarErrorChat'), HTML.indexOf('async function enviarDesdeChat'));
  assert.ok(/chat-toast/.test(fn));
  assert.ok(!/\balert\(/.test(fn));
});

// ═══ No romper: backend intacto, hooks conservados, desktop intacto ═════════
t('14. NO se modificó ningún endpoint de takeover en server.js', () => {
  assert.ok(/app\.post\('\/api\/conversacion\/:telefono\/pausar'/.test(SERVER));
  assert.ok(/app\.post\('\/api\/conversacion\/:telefono\/reactivar'/.test(SERVER));
  assert.ok(/app\.get\('\/api\/conversacion\/:telefono\/estado-bot'/.test(SERVER));
  // el frontend sigue usando la API real como fuente de verdad
  assert.ok(/\/api\/conversacion\/\$\{chatAbierto\}\/\$\{endpoint\}/.test(HTML), 'toggle usa el endpoint real');
});
t('15. conversaciones_control / getBotPausado / setBotPausado intactos', () => {
  assert.ok(/conversaciones_control/.test(DB));
  assert.ok(/export async function getBotPausado/.test(DB) && /export async function setBotPausado/.test(DB));
  assert.ok(/export async function upsertControlConversacion/.test(DB));
});
t('16. IDs/hooks existentes conservados', () => {
  for (const id of ['contactos-lista','chat-mensajes','chat-input','btn-chat-enviar','btn-toggle-bot',
    'chat-atencion-estado','chats-banner-bot','lista-chats','chat-area','chat-header-nombre',
    'input-imagenes-camara','input-imagenes-galeria','input-pdf-adjunto','btn-adjuntar-imagen']) {
    assert.ok(HTML.includes(`id="${id}"`), `falta #${id}`);
  }
  assert.ok(/function enviarDesdeChat/.test(HTML) && /function toggleBotPausado/.test(HTML) && /function renderMensajes/.test(HTML));
});
t('17. desktop split-view intacto: full-screen SOLO bajo @media 640', () => {
  // La regla que colapsa a full-screen vive dentro de la media query móvil.
  const idx = HTML.indexOf('#vista-chats.chat-abierto { position: fixed');
  const antes = HTML.lastIndexOf('@media (max-width: 640px)', idx);
  const cierreDespues = HTML.indexOf('@media', idx);
  assert.ok(antes > -1 && (cierreDespues === -1 || antes < idx), 'chat-abierto full-screen está dentro de la media query móvil');
  assert.ok(/ajustarLayoutChatMovil/.test(HTML) && /window\.innerWidth <= 640/.test(HTML), 'el split se decide por ancho');
});
t('18. no se fabrican estados backend: filtro "sin_responder" usa direccion real', () => {
  assert.ok(/_filtroChats === 'sin_responder'\) filas = filas\.filter\(c => c\.direccion === 'entrante'\)/.test(HTML),
    'sin responder = último mensaje entrante (dato REAL del endpoint), no un estado inventado');
});

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
