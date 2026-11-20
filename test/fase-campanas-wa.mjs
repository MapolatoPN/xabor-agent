// ─── CAMPAÑAS DE WHATSAPP CON PLANTILLA: REGLAS PURAS Y CABLEADO ─────────────
//
// Pedido de Mario (20-nov-2026, «sí, prepáralas»). Sin base ni red: lo que se
// decide en src/services/campanasWaPlantillas.js y cómo quedó conectado.
//
//   P. reglas: número para Meta, análisis de plantillas, variables, los
//      `components` que se mandan, la vista previa, qué hacer con cada rechazo
//      de Meta, horario y costo.
//   S. cableado: server.js monta las rutas de admin y el job; el panel carga
//      campanas-wa.js con su huella y ya no trae el formulario de texto libre;
//      el runner aplica la 142.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import {
  analizarPlantilla, clasificarErrorMeta, construirComponentes, costoAproximado, dentroDeHorario, explicarCodigo,
  limpiarVariable, primerNombre, segmentoValido, telefonoParaMeta, validarVariables, vistaPrevia, ErrorCampana,
} from '../src/services/campanasWaPlantillas.js';

const leer = (r) => readFileSync(new URL(`../${r}`, import.meta.url), 'utf8');
let n = 0; let fallidas = 0;
const SOLO = (process.env.CASOS || '').split(',').map((s) => s.trim()).filter(Boolean);
async function caso(nombre, fn) {
  if (SOLO.length && !SOLO.includes(nombre.split(' ')[0])) return;
  try { await fn(); console.log(`OK campanas-wa ${++n}: ${nombre}`); }
  catch (e) {
    fallidas++;
    const detalle = e?.code === 'ERR_ASSERTION' && e.generatedMessage
      ? ` · obtenido=${JSON.stringify(e.actual)?.slice(0, 220)} · esperado=${JSON.stringify(e.expected)?.slice(0, 160)}` : '';
    console.log(`FALLA ${nombre.split(' ')[0]} campanas-wa: ${nombre}\n  ${String(e?.message || e).split('\n')[0]}${detalle}`);
  }
}
function lanza(fn, codigo) {
  let e = null;
  try { fn(); } catch (x) { e = x; }
  assert.ok(e instanceof ErrorCampana, `debía rechazar con ${codigo}`);
  assert.equal(e.codigo, codigo);
  return e;
}

// Plantillas como las devuelve la Graph API (forma real, datos inventados).
const PROMO = {
  id: '111', name: 'promo_jueves', status: 'APPROVED', category: 'MARKETING', language: 'es_MX',
  components: [
    { type: 'HEADER', format: 'TEXT', text: '¡{{1}} te espera!', example: { header_text: ['Xabor'] } },
    { type: 'BODY', text: 'Hola {{1}}, este jueves hay {{2}}.', example: { body_text: [['Ana', '2x1 en chilaquiles']] } },
    { type: 'FOOTER', text: 'Responde BAJA para no recibir más' },
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quiero' }, { type: 'PHONE_NUMBER', text: 'Llamar', phone_number: '+520000000000' }] },
  ],
};
const NOMBRADA = {
  id: '222', name: 'promo_nombrada', status: 'APPROVED', category: 'MARKETING', language: 'es_MX', parameter_format: 'NAMED',
  components: [{ type: 'BODY', text: 'Hola {{nombre}}: {{promo}}. Te esperamos, {{nombre}}.',
    example: { body_text_named_params: [{ param_name: 'nombre', example: 'Ana' }, { param_name: 'promo', example: '15 %' }] } }],
};
const CUPON = {
  id: '333', name: 'cupon_foto', status: 'APPROVED', category: 'MARKETING', language: 'es_MX',
  components: [
    { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://ejemplo.invalid/x.jpg'] } },
    { type: 'BODY', text: 'Usa tu código y pide en línea.' },
    { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'DOMINGO15' }, { type: 'URL', text: 'Pedir', url: 'https://tienda.invalid/{{1}}', example: ['https://tienda.invalid/obispado'] }] },
  ],
};

// ── P. Reglas ─────────────────────────────────────────────────────────────────
await caso('P1 el número sale como lo pide Meta: 10 dígitos = México, 521 → 52, extranjero intacto, basura nunca', () => {
  assert.equal(telefonoParaMeta('8781234567'), '528781234567');
  assert.equal(telefonoParaMeta('5218781234567'), '528781234567');
  assert.equal(telefonoParaMeta('+52 878 123 4567'), '528781234567');
  assert.equal(telefonoParaMeta('18305550100'), '18305550100');
  for (const malo of ['—', 'rappi-123', '12345', '', null, '528781234', '52187812345678', '5281234567890']) {
    assert.equal(telefonoParaMeta(malo), null, String(malo));
  }
});

await caso('P2 plantilla con variables numeradas: compatible, huecos en orden y con su ejemplo', () => {
  const a = analizarPlantilla(PROMO);
  assert.equal(a.compatible, true, a.razones.join('; '));
  assert.deepEqual(a.ranuras.map((r) => [r.clave, r.ejemplo]), [['encabezado:1', 'Xabor'], ['cuerpo:1', 'Ana'], ['cuerpo:2', '2x1 en chilaquiles']]);
  assert.deepEqual(a.botones.map((b) => b.texto), ['Quiero', 'Llamar']);
  assert.equal(a.pie, 'Responde BAJA para no recibir más');
});

await caso('P3 plantilla con variables con nombre: un hueco por nombre, y se manda con parameter_name', () => {
  const a = analizarPlantilla(NOMBRADA);
  assert.equal(a.compatible, true);
  assert.deepEqual(a.ranuras.map((r) => r.clave), ['cuerpo:nombre', 'cuerpo:promo']);
  const { variables, respaldoNombre } = validarVariables(a, { 'cuerpo:nombre': { fuente: 'nombre' }, 'cuerpo:promo': { fuente: 'fijo', texto: '15 % hoy' } }, 'cliente');
  assert.deepEqual(construirComponentes(a, variables, 'ana lucía pérez', respaldoNombre), [{ type: 'body', parameters: [
    { type: 'text', parameter_name: 'nombre', text: 'Ana' }, { type: 'text', parameter_name: 'promo', text: '15 % hoy' }] }]);
  assert.equal(vistaPrevia(a, variables, 'Ana', respaldoNombre).cuerpo, 'Hola Ana: 15 % hoy. Te esperamos, Ana.');
});

await caso('P4 lo que Xabor no sabe mandar se dice con su razón y no es compatible', () => {
  const casos = [
    [{ ...PROMO, status: 'PENDING' }, /no la aprueba/],
    [{ ...PROMO, category: 'AUTHENTICATION' }, /códigos de acceso/],
    [{ ...PROMO, components: [{ type: 'HEADER', format: 'VIDEO' }, { type: 'BODY', text: 'x' }] }, /un video/],
    [{ ...PROMO, components: [{ type: 'BODY', text: 'x' }, { type: 'CAROUSEL', cards: [] }] }, /CAROUSEL/],
    [{ ...PROMO, components: [{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'FLOW', text: 'f' }] }] }, /FLOW/],
    [{ ...PROMO, components: [{ type: 'HEADER', format: 'TEXT', text: 'Solo encabezado' }] }, /cuerpo/],
  ];
  for (const [p, re] of casos) {
    const a = analizarPlantilla(p);
    assert.equal(a.compatible, false, JSON.stringify(p.components));
    assert.match(a.razones.join('; '), re);
  }
});

await caso('P5 imagen, «copiar código» y liga con variable: cada uno en su lugar de components', () => {
  const a = analizarPlantilla(CUPON);
  assert.equal(a.compatible, true, a.razones.join('; '));
  assert.deepEqual(a.ranuras.map((r) => [r.clave, r.tipo]), [['encabezado:imagen', 'imagen'], ['boton:0', 'cupon'], ['boton:1', 'url']]);
  const { variables } = validarVariables(a, { 'encabezado:imagen': { fuente: 'fijo', texto: 'https://cdn.invalid/foto.jpg' },
    'boton:0': { fuente: 'fijo', texto: 'DOMINGO15' }, 'boton:1': { fuente: 'fijo', texto: 'obispado' } }, '');
  assert.deepEqual(construirComponentes(a, variables, 'Ana', ''), [
    { type: 'header', parameters: [{ type: 'image', image: { link: 'https://cdn.invalid/foto.jpg' } }] },
    { type: 'button', sub_type: 'copy_code', index: '0', parameters: [{ type: 'coupon_code', coupon_code: 'DOMINGO15' }] },
    { type: 'button', sub_type: 'url', index: '1', parameters: [{ type: 'text', text: 'obispado' }] },
  ]);
});

await caso('P6 variables: falta, nombre donde no va, imagen sin https, código con espacio y sin respaldo se rechazan', () => {
  const a = analizarPlantilla(PROMO);
  lanza(() => validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: 'Xabor' } }, 'cliente'), 'VARIABLE_FALTA');
  lanza(() => validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: '   ' }, 'cuerpo:1': { fuente: 'nombre' },
    'cuerpo:2': { fuente: 'fijo', texto: 'x' } }, 'cliente'), 'VARIABLE_FALTA');
  lanza(() => validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: 'X' }, 'cuerpo:1': { fuente: 'nombre' },
    'cuerpo:2': { fuente: 'fijo', texto: 'x' } }, '  '), 'RESPALDO_FALTA');
  lanza(() => validarVariables(a, { 'encabezado:1': { fuente: 'otra' }, 'cuerpo:1': { fuente: 'nombre' },
    'cuerpo:2': { fuente: 'fijo', texto: 'x' } }, 'cliente'), 'VARIABLE_FALTA');
  const c = analizarPlantilla(CUPON);
  const base = { 'encabezado:imagen': { fuente: 'fijo', texto: 'https://cdn.invalid/f.jpg' }, 'boton:0': { fuente: 'fijo', texto: 'ABC1' },
    'boton:1': { fuente: 'fijo', texto: 'x' } };
  lanza(() => validarVariables(c, { ...base, 'encabezado:imagen': { fuente: 'nombre' } }, 'cliente'), 'VARIABLE_INVALIDA');
  lanza(() => validarVariables(c, { ...base, 'encabezado:imagen': { fuente: 'fijo', texto: 'http://cdn.invalid/f.jpg' } }, ''), 'VARIABLE_INVALIDA');
  lanza(() => validarVariables(c, { ...base, 'boton:0': { fuente: 'fijo', texto: 'DOMINGO 15' } }, ''), 'VARIABLE_INVALIDA');
  lanza(() => validarVariables(c, { ...base, 'boton:0': { fuente: 'fijo', texto: 'X'.repeat(16) } }, ''), 'VARIABLE_INVALIDA');
  // Solo las claves de la plantilla pasan; lo demás se tira.
  const ok = validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: 'Xabor\n\n  hoy' }, 'cuerpo:1': { fuente: 'nombre' },
    'cuerpo:2': { fuente: 'fijo', texto: '2x1' }, 'otra:9': { fuente: 'fijo', texto: 'colado' } }, ' cliente ');
  assert.deepEqual(ok, { variables: { 'encabezado:1': { fuente: 'fijo', texto: 'Xabor hoy' }, 'cuerpo:1': { fuente: 'nombre' },
    'cuerpo:2': { fuente: 'fijo', texto: '2x1' } }, respaldoNombre: 'cliente' });
});

await caso('P7 el nombre: primer nombre con mayúscula; si no hay o no es un nombre, el respaldo', () => {
  const a = analizarPlantilla(PROMO);
  const { variables, respaldoNombre } = validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: 'Xabor' },
    'cuerpo:1': { fuente: 'nombre' }, 'cuerpo:2': { fuente: 'fijo', texto: '2x1' } }, 'cliente');
  const cuerpo = (nombre) => construirComponentes(a, variables, nombre, respaldoNombre)[1].parameters[0].text;
  assert.equal(cuerpo('josé luis'), 'José');
  for (const sin of [null, '', '   ', '5218781234567', '😀😀', 'x'.repeat(31)]) assert.equal(cuerpo(sin), 'cliente', String(sin));
  assert.equal(primerNombre('  María\tFernanda '), 'María');
  assert.equal(limpiarVariable('a\r\n\tb     c'), 'a b c');
  assert.deepEqual(construirComponentes(a, variables, 'Ana', respaldoNombre)[0], { type: 'header', parameters: [{ type: 'text', text: 'Xabor' }] });
});

await caso('P8 la vista previa pone cada valor en su lugar y deja pie y botones', () => {
  const a = analizarPlantilla(PROMO);
  const { variables } = validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: 'Xabor' },
    'cuerpo:1': { fuente: 'nombre' }, 'cuerpo:2': { fuente: 'fijo', texto: '2x1 en chilaquiles' } }, 'cliente');
  assert.deepEqual(vistaPrevia(a, variables, 'ana', 'cliente'), { encabezado: '¡Xabor te espera!', imagen: null,
    cuerpo: 'Hola Ana, este jueves hay 2x1 en chilaquiles.', pie: 'Responde BAJA para no recibir más', botones: ['Quiero', 'Llamar'] });
});

await caso('P9 rechazos de Meta: cuenta/plantilla detiene, límite reintenta, red caída queda en duda, lo demás es del cliente', () => {
  const tabla = [
    [{ red: true }, 'incierto'], [{ status: 500 }, 'incierto'], [{ status: 401 }, 'detener'], [{ status: 400, codigo: 190 }, 'detener'],
    [{ status: 400, codigo: 132001 }, 'detener'], [{ status: 400, codigo: 132000 }, 'detener'], [{ status: 400, codigo: 132015 }, 'detener'],
    [{ status: 400, codigo: 131042 }, 'detener'], [{ status: 400, codigo: 131048 }, 'detener'], [{ status: 400, codigo: 131031 }, 'detener'],
    [{ status: 429 }, 'reintentar'], [{ status: 400, codigo: 130429 }, 'reintentar'], [{ status: 400, codigo: 131056 }, 'reintentar'],
    [{ status: 400, codigo: 131026 }, 'destinatario'], [{ status: 400, codigo: 100 }, 'destinatario'], [{ status: 400, codigo: 131049 }, 'destinatario'],
    [{ status: 500, codigo: 131000 }, 'destinatario'],
  ];
  for (const [entrada, esperado] of tabla) assert.equal(clasificarErrorMeta(entrada), esperado, JSON.stringify(entrada));
  assert.match(explicarCodigo(131050), /no recibir promociones/);
  assert.match(explicarCodigo(999999), /999999/);
  assert.equal(explicarCodigo(null), 'Sin respuesta de Meta');
});

await caso('P10 horario: de 9:00 a 20:59 en la hora del negocio, no en la del servidor', () => {
  const z = 'America/Matamoros'; // 20-nov: UTC-6
  assert.equal(dentroDeHorario(new Date('2026-11-20T14:59:00Z'), z), false); // 8:59
  assert.equal(dentroDeHorario(new Date('2026-11-20T15:00:00Z'), z), true); //  9:00
  assert.equal(dentroDeHorario(new Date('2026-11-21T02:59:00Z'), z), true); // 20:59
  assert.equal(dentroDeHorario(new Date('2026-11-21T03:00:00Z'), z), false); // 21:00
  assert.equal(dentroDeHorario(new Date('2026-11-21T09:00:00Z'), z), false); //  3:00
});

await caso('P11 costo aproximado por categoría y segmentos permitidos', () => {
  assert.deepEqual(costoAproximado('MARKETING', 100), { tarifaUsd: 0.045, totalUsd: 4.5 });
  assert.deepEqual(costoAproximado('UTILITY', 1000), { tarifaUsd: 0.0085, totalUsd: 8.5 });
  assert.equal(segmentoValido('todos'), true);
  assert.equal(segmentoValido('rewards_100'), true);
  for (const malo of ['', 'rewards_7', "todos'; --", undefined]) assert.equal(segmentoValido(malo), false);
});

// ── S. Cableado ───────────────────────────────────────────────────────────────
await caso('S1 server.js monta las rutas con requireAdminSeguro y requireModulo, y corre la cola fuera del webhook', () => {
  const s = leer('src/server.js');
  assert.match(s, /^import \{ registrarRutasCampanasWa \} from '\.\/services\/campanasWaRutas\.js';$/m);
  assert.match(s, /^registrarRutasCampanasWa\(app, \{ requireAdminSeguro, requireModulo \}\);$/m);
  assert.match(s, /procesarColaCampanas\(\)\s*\n\s*\.catch[\s\S]{0,120}\}, 10 \* 1000\);/);
  assert.match(s, /sincronizarEntregasCampanas\(\)\.catch[\s\S]{0,80}\}, 2 \* 60 \* 1000\);/);
  // La ruta vieja de texto libre sigue (para no romper a nadie), pero el panel ya no la usa.
  assert.match(s, /app\.post\('\/api\/admin\/campanas', requireAdminSeguro/);
});

await caso('S2 las seis rutas, todas de administrador y con el módulo de WhatsApp', () => {
  const r = leer('src/services/campanasWaRutas.js');
  const declaradas = [...r.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)', ([^,]+), ([^,]+),/g)].map((m) => `${m[1]} ${m[2]} ${m[3]} ${m[4]}`);
  assert.deepEqual(declaradas, [
    'get /api/admin/campanas-wa requireAdminSeguro wa', 'get /api/admin/campanas-wa/plantillas requireAdminSeguro wa',
    'post /api/admin/campanas-wa/vista-previa requireAdminSeguro wa', 'post /api/admin/campanas-wa/prueba requireAdminSeguro wa',
    'post /api/admin/campanas-wa requireAdminSeguro wa', 'post /api/admin/campanas-wa/:id/detener requireAdminSeguro wa',
  ]);
  assert.match(r, /const wa = requireModulo\('whatsapp'\);/);
  assert.equal((r.match(/app\.(get|post|put|patch|delete)\(/g) || []).length, 6);
});

await caso('S3 el panel carga campanas-wa.js con su huella y ya no trae el formulario de texto libre', () => {
  const panel = leer('panel/index.html');
  const js = readFileSync(new URL('../panel/campanas-wa.js', import.meta.url));
  const huella = createHash('sha256').update(js).digest('hex').slice(0, 8);
  const m = panel.match(/<script src="\/campanas-wa\.js\?v=([0-9a-f]+)"><\/script>/);
  assert.ok(m, 'el panel no carga /campanas-wa.js');
  assert.equal(m[1], huella, `panel: actualiza la etiqueta a ?v=${huella}`);
  assert.match(panel, /<div id="vista-campanas" style="display:none;">\s*<div id="campanas-wa"><\/div>\s*<\/div>/);
  assert.match(panel, /if \(tab === 'campanas'\) window\.XaborCampanasWa\?\.abrir\(document\.getElementById\('campanas-wa'\)\);/);
  for (const viejo of ['campana-modal', 'camp-mensaje', 'function enviarCampana', 'function cargarCampanas', "apiFetch('/api/admin/campanas'"]) {
    assert.ok(!panel.includes(viejo), `sigue en el panel: ${viejo}`);
  }
  const texto = js.toString('utf8');
  assert.ok(!/onclick=/i.test(texto), 'sin onclick en línea');
  assert.deepEqual([...texto.matchAll(/window\.(\w+)\s*=(?!=)/g)].map((x) => x[1]), ['XaborCampanasWa']);
  const rutas = [...new Set([...texto.matchAll(/pedir\(\s*[`']([^`'$?]+)/g)].map((x) => x[1]))];
  assert.ok(rutas.length >= 5 && rutas.every((u) => u.startsWith('/api/admin/campanas-wa')), `rutas: ${rutas.join(', ')}`);
  // La prueba al administrador no inventa un nombre de cliente: usa el respaldo.
  assert.ok(!/nombrePrueba/.test(texto), 'la prueba no debe mandar un nombre fijo');
});

await caso('S4 el runner aplica la 142 después de la 141, y el predeploy lee su migración', () => {
  const runner = leer('scripts/predeploy-run-032-033.mjs');
  const i141 = runner.indexOf("'141-temporada-preparada-en'"); const i142 = runner.indexOf("'142-campanas-whatsapp-plantilla'");
  assert.ok(i141 > 0 && i142 > i141, 'la 142 no está en SCRIPTS después de la 141');
  assert.ok(existsSync(new URL('../scripts/predeploy-142-campanas-whatsapp-plantilla.mjs', import.meta.url)));
  const pre = leer('scripts/predeploy-142-campanas-whatsapp-plantilla.mjs');
  assert.match(pre, /migrations\/142_campanas_whatsapp_plantilla\.sql/);
  assert.ok(existsSync(new URL('../migrations/142_campanas_whatsapp_plantilla_down.sql', import.meta.url)));
  const sql = leer('migrations/142_campanas_whatsapp_plantilla.sql');
  assert.ok(!/\bDROP COLUMN\b|\bDELETE\b|\bUPDATE\b|\bTRUNCATE\b/i.test(sql.replace(/^--.*$/gm, '')), 'la 142 debe ser aditiva');
});

console.log(`Campañas WA (puras y cableado): ${n} pasadas, ${fallidas} fallidas. Sin base ni red.`);
if (fallidas) process.exitCode = 1;
