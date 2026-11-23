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
  nombreUsable, esBotonDeBaja, validarTandas, rebasaUmbral, TANDAS,
  RESPALDO_NOMBRE, PROGRAMAR, fechaLocal, localAUtc, validarProgramacion, textoProgramada,
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
    { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Detener promociones' }, { type: 'PHONE_NUMBER', text: 'Llamar', phone_number: '+520000000000' }] },
  ],
};
const NOMBRADA = {
  id: '222', name: 'promo_nombrada', status: 'APPROVED', category: 'MARKETING', language: 'es_MX', parameter_format: 'NAMED',
  components: [{ type: 'BODY', text: 'Hola {{nombre}}: {{promo}}. Te esperamos, {{nombre}}.',
    example: { body_text_named_params: [{ param_name: 'nombre', example: 'Ana' }, { param_name: 'promo', example: '15 %' }] } },
  { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Stop promotions' }] }],
};
const CUPON = {
  id: '333', name: 'cupon_foto', status: 'APPROVED', category: 'MARKETING', language: 'es_MX',
  components: [
    { type: 'HEADER', format: 'IMAGE', example: { header_handle: ['https://ejemplo.invalid/x.jpg'] } },
    { type: 'BODY', text: 'Usa tu código y pide en línea.' },
    { type: 'BUTTONS', buttons: [{ type: 'COPY_CODE', example: 'DOMINGO15' }, { type: 'URL', text: 'Pedir', url: 'https://tienda.invalid/{{1}}', example: ['https://tienda.invalid/obispado'] },
      { type: 'QUICK_REPLY', text: 'Ya no quiero recibir promociones' }] },
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
  assert.deepEqual(a.botones.map((b) => [b.texto, b.baja]), [['Detener promociones', true], ['Llamar', false]]);
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
    // Saneamiento (21-nov-2026): una promoción sin botón de baja no se manda, y
    // una respuesta rápida que el bot no contesta tampoco.
    [{ ...PROMO, components: [{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Pedir', url: 'https://t.invalid' }] }] }, /darse de baja/],
    [{ ...PROMO, components: [{ type: 'BODY', text: 'x' }] }, /darse de baja/],
    [{ ...PROMO, components: [{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Quiero pedir' },
      { type: 'QUICK_REPLY', text: 'Detener promociones' }] }] }, /«Quiero pedir» es de respuesta rápida/],
    [{ ...PROMO, category: 'UTILITY', components: [{ type: 'BODY', text: 'x' }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Sí' }] }] }, /respuesta rápida/],
  ];
  for (const [p, re] of casos) {
    const a = analizarPlantilla(p);
    assert.equal(a.compatible, false, JSON.stringify(p.components));
    assert.match(a.razones.join('; '), re);
  }
  // De utilidad, sin botón de baja, sí se puede: la regla es de las promociones.
  const util = analizarPlantilla({ ...PROMO, category: 'UTILITY', components: [{ type: 'BODY', text: 'Tu pedido va en camino' }] });
  assert.equal(util.compatible, true, util.razones.join('; '));
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
  // Fase 0.1 (23-nov): un salto de línea o un tabulador se rechazan con su
  // campo; antes se aplanaban sin avisar y el mensaje salía distinto.
  for (const raro of ['Xabor\n\n  hoy', 'Xabor\r\nhoy', 'Xabor\thoy']) {
    const e = lanza(() => validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: raro }, 'cuerpo:1': { fuente: 'nombre' },
      'cuerpo:2': { fuente: 'fijo', texto: 'x' } }, 'cliente'), 'VARIABLE_INVALIDA');
    assert.equal(e.clave, 'encabezado:1');
    assert.match(e.message, /saltos de línea/);
  }
  lanza(() => validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: 'X' }, 'cuerpo:1': { fuente: 'nombre' },
    'cuerpo:2': { fuente: 'fijo', texto: 'x' } }, 'buen\ndía'), 'RESPALDO_FALTA');
  // Solo las claves de la plantilla pasan; lo demás se tira. Los espacios de más sí se juntan.
  const ok = validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: 'Xabor     hoy' }, 'cuerpo:1': { fuente: 'nombre' },
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
  // Lo que la caja escribe cuando no sabe el nombre no se usa para saludar.
  for (const sin of ['RAPPI 3259', 'LLEVAR', 'Cliente', 'Mesa 4', 'SRA VALDES', 'x', 'Sr. Pérez', 'Para llevar']) {
    assert.equal(cuerpo(sin), 'cliente', sin);
  }
  assert.equal(cuerpo('ROSSY'), 'Rossy');
  assert.equal(cuerpo('ARMIN CERVECERA'), 'Armin');
  assert.equal(nombreUsable('María José'), 'María');
  assert.equal(primerNombre('  María\tFernanda '), 'María');
  assert.equal(limpiarVariable('a\r\n\tb     c'), 'a b c');
  assert.deepEqual(construirComponentes(a, variables, 'Ana', respaldoNombre)[0], { type: 'header', parameters: [{ type: 'text', text: 'Xabor' }] });
});

await caso('P8 la vista previa pone cada valor en su lugar y deja pie y botones', () => {
  const a = analizarPlantilla(PROMO);
  const { variables } = validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: 'Xabor' },
    'cuerpo:1': { fuente: 'nombre' }, 'cuerpo:2': { fuente: 'fijo', texto: '2x1 en chilaquiles' } }, 'cliente');
  assert.deepEqual(vistaPrevia(a, variables, 'ana', 'cliente'), { encabezado: '¡Xabor te espera!', imagen: null,
    cuerpo: 'Hola Ana, este jueves hay 2x1 en chilaquiles.', pie: 'Responde BAJA para no recibir más', botones: ['Detener promociones', 'Llamar'] });
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

await caso('P12 tandas: tope y umbral con sus límites; el umbral solo cuenta con suficientes intentos', () => {
  assert.deepEqual(validarTandas(undefined, undefined), { tope24h: TANDAS.tope24h, umbralRechazoPct: TANDAS.umbralPct });
  assert.deepEqual(validarTandas('300', '15'), { tope24h: 300, umbralRechazoPct: 15 });
  for (const [t, u] of [[9, 10], [100001, 10], [1.5, 10], ['abc', 10], [250, 1], [250, 51], [250, 'x']]) {
    lanza(() => validarTandas(t, u), 'TANDA_INVALIDA');
  }
  assert.equal(rebasaUmbral({ intentos: 19, rechazos: 19 }, 10), false, 'con pocos intentos no se pausa');
  assert.equal(rebasaUmbral({ intentos: 20, rechazos: 2 }, 10), false, '10 % justo no rebasa');
  assert.equal(rebasaUmbral({ intentos: 20, rechazos: 3 }, 10), true);
  assert.equal(rebasaUmbral({ intentos: 500, rechazos: 400 }, null), false, 'sin umbral no se pausa');
});

await caso('P13 botón de baja y texto de respaldo legible', () => {
  for (const si of ['Detener promociones', 'Stop promotions', 'Darme de baja', 'No me interesa', 'Ya no quiero recibir promociones', 'BAJA']) {
    assert.equal(esBotonDeBaja(si), true, si);
  }
  for (const no of ['Quiero pedir', 'Ver menú', 'Sí', '', null]) assert.equal(esBotonDeBaja(no), false, String(no));
  const a = analizarPlantilla(PROMO);
  const vars = { 'encabezado:1': { fuente: 'fijo', texto: 'X' }, 'cuerpo:1': { fuente: 'nombre' }, 'cuerpo:2': { fuente: 'fijo', texto: 'x' } };
  for (const malo of ['123', '{{1}}', '<b>']) lanza(() => validarVariables(a, vars, malo), 'RESPALDO_FALTA');
  assert.equal(validarVariables(a, vars, 'amig@').respaldoNombre, 'amig@');
});

// ── Fase 0.1 (23-nov-2026) ────────────────────────────────────────────────────
await caso('P14 el hueco del nombre: el que se llama «nombre» o el {{1}} del cuerpo; ninguno más', () => {
  const marcadas = (p) => analizarPlantilla(p).ranuras.filter((r) => r.esNombre).map((r) => r.clave);
  assert.deepEqual(marcadas(PROMO), ['cuerpo:1'], 'numerada: el {{1}} del cuerpo, no el del encabezado');
  assert.deepEqual(marcadas(NOMBRADA), ['cuerpo:nombre']);
  const conNombre = (texto, extra = {}) => ({ id: '9', name: 'x', status: 'APPROVED', category: 'MARKETING', language: 'es_MX',
    components: [{ type: 'BODY', text: texto }, { type: 'BUTTONS', buttons: [{ type: 'QUICK_REPLY', text: 'Detener promociones' }] }], ...extra });
  assert.deepEqual(marcadas(conNombre('Hoy {{promo}} y {{extra}}', { parameter_format: 'NAMED' })), [], 'con nombre pero sin «nombre»: ninguna');
  assert.deepEqual(marcadas(conNombre('{{Nombre}}: {{promo}}', { parameter_format: 'NAMED' })), [], 'en Meta el nombre va en minúsculas');
  assert.deepEqual(marcadas(conNombre('Hola {{name}}, {{promo}}', { parameter_format: 'NAMED' })), ['cuerpo:name']);
  assert.deepEqual(marcadas(conNombre('Sin variables')), []);
  assert.deepEqual(marcadas(conNombre('Promo: {{2}} y {{3}}')), [], 'numerada sin {{1}}: ninguna');
  // Lo que se guarda y se manda no cambia por la marca.
  const a = analizarPlantilla(PROMO);
  const { variables } = validarVariables(a, { 'encabezado:1': { fuente: 'fijo', texto: 'Xabor' }, 'cuerpo:1': { fuente: 'nombre' },
    'cuerpo:2': { fuente: 'fijo', texto: '2x1' } }, RESPALDO_NOMBRE);
  assert.deepEqual(construirComponentes(a, variables, null, RESPALDO_NOMBRE)[1].parameters.map((x) => x.text), ['buen día', '2x1']);
});

await caso('P15 sin nombre del cliente se pone «buen día», y los avisos lo proponen', () => {
  assert.equal(RESPALDO_NOMBRE, 'buen día');
  const a = analizarPlantilla(PROMO);
  const vars = { 'encabezado:1': { fuente: 'fijo', texto: 'Xabor' }, 'cuerpo:1': { fuente: 'nombre' }, 'cuerpo:2': { fuente: 'fijo', texto: '2x1' } };
  const { respaldoNombre } = validarVariables(a, vars, RESPALDO_NOMBRE);
  assert.equal(vistaPrevia(a, vars, 'RAPPI 3259', respaldoNombre).cuerpo, 'Hola buen día, este jueves hay 2x1.');
  assert.match(lanza(() => validarVariables(a, vars, ''), 'RESPALDO_FALTA').message, /«buen día»/);
  assert.match(lanza(() => validarVariables(a, vars, '123'), 'RESPALDO_FALTA').message, /«buen día»/);
});

await caso('P16 programar: la hora es la del negocio, de 9:00 a 20:59, entre 10 min y 30 días; la hora que no existe se rechaza', () => {
  const MTY = 'America/Matamoros';
  const ahora = new Date('2026-11-23T15:40:00Z'); // lunes 9:40 en Matamoros (CST)
  assert.equal(fechaLocal(ahora, MTY), '2026-11-23T09:40');
  assert.equal(localAUtc('2026-11-25T10:00', MTY).toISOString(), '2026-11-25T16:00:00.000Z');
  assert.equal(localAUtc('2026-07-01T10:00', MTY).toISOString(), '2026-07-01T15:00:00.000Z', 'en verano es UTC-5');
  assert.equal(localAUtc('2026-11-25T10:00', 'America/Tijuana').toISOString(), '2026-11-25T18:00:00.000Z', 'otra zona, otro instante');
  for (const malo of ['2026-03-08T02:30', '2026-02-30T10:00', '2026-13-01T10:00', '2026-11-25T24:00', '2026-11-25 10:00', '', null, 1764086400000]) {
    assert.equal(localAUtc(malo, MTY), null, String(malo));
  }
  assert.equal(validarProgramacion('', MTY, ahora), null, 'sin fecha = mandar ahora');
  assert.equal(validarProgramacion(undefined, MTY, ahora), null);
  assert.equal(validarProgramacion('2026-11-23T09:50', MTY, ahora).toISOString(), '2026-11-23T15:50:00.000Z', 'justo 10 min');
  assert.equal(validarProgramacion('2026-11-23T20:59', MTY, ahora).toISOString(), '2026-11-24T02:59:00.000Z');
  assert.equal(validarProgramacion('2026-12-23T09:00', MTY, ahora).toISOString(), '2026-12-23T15:00:00.000Z', '30 días menos 40 min');
  for (const malo of ['2026-11-23T09:49', '2026-11-23T21:00', '2026-11-24T08:59', '2026-12-23T09:41', '2026-03-08T02:30', 'hoy']) {
    lanza(() => validarProgramacion(malo, MTY, ahora), 'PROGRAMACION_INVALIDA');
  }
  assert.equal(textoProgramada(new Date('2026-11-25T16:00:00Z'), MTY), 'miércoles 25 nov, 10:00');
  assert.equal(textoProgramada(new Date('2026-11-24T02:59:00Z'), MTY), 'lunes 23 nov, 20:59');
  assert.deepEqual([PROGRAMAR.minimoMin, PROGRAMAR.maximoDias, PROGRAMAR.toleranciaHoras], [10, 30, 6]);
});

// ── S. Cableado ───────────────────────────────────────────────────────────────
await caso('S1 server.js monta las rutas con requireAdminSeguro y requireModulo, y corre la cola fuera del webhook', () => {
  const s = leer('src/server.js');
  assert.match(s, /^import \{ registrarRutasCampanasWa \} from '\.\/services\/campanasWaRutas\.js';$/m);
  assert.match(s, /^registrarRutasCampanasWa\(app, \{ requireAdminSeguro, requireModulo \}\);$/m);
  assert.match(s, /procesarColaCampanas\(\)\s*\n\s*\.catch[\s\S]{0,120}\}, 10 \* 1000\);/);
  // Después de los acuses, las bajas: las dos en el mismo trabajo, cada 2 min.
  assert.match(s, /sincronizarEntregasCampanas\(\)\s*\n\s*\.then\(\(\) => registrarBajasCampanas\(\)\)\s*\n\s*\.catch[\s\S]{0,80}\}, 2 \* 60 \* 1000\);/);
  // Teléfonos del negocio e internos: rutas de admin en su módulo, y el
  // número de WhatsApp de la sucursal se registra ANTES de reconciliar.
  assert.match(s, /^import \{ registrarRutasClientesSaneamiento \} from '\.\/services\/clientesSaneamientoRutas\.js';$/m);
  assert.match(s, /^registrarRutasClientesSaneamiento\(app, \{ requireAdminSeguro \}\);$/m);
  assert.match(s, /m\.asegurarTelefonosWhatsapp\(\)\)\s*\n\s*\.then\(\(\) => import\('\.\/services\/clientesCrm\.js'\)\)\s*\n\s*\.then\(m => m\.reconciliarClientesDesdePedidos\(\)\)/);
  // La ruta vieja de texto libre sigue (para no romper a nadie), pero el panel ya no la usa.
  assert.match(s, /app\.post\('\/api\/admin\/campanas', requireAdminSeguro/);
});

await caso('S2 las ocho rutas, todas de administrador y con el módulo de WhatsApp', () => {
  const r = leer('src/services/campanasWaRutas.js');
  const declaradas = [...r.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)', ([^,]+), ([^,]+),/g)].map((m) => `${m[1]} ${m[2]} ${m[3]} ${m[4]}`);
  assert.deepEqual(declaradas, [
    'get /api/admin/campanas-wa requireAdminSeguro wa', 'get /api/admin/campanas-wa/plantillas requireAdminSeguro wa',
    'post /api/admin/campanas-wa/vista-previa requireAdminSeguro wa', 'post /api/admin/campanas-wa/prueba requireAdminSeguro wa',
    'post /api/admin/campanas-wa requireAdminSeguro wa', 'post /api/admin/campanas-wa/:id/detener requireAdminSeguro wa',
    'post /api/admin/campanas-wa/:id/pausar requireAdminSeguro wa', 'post /api/admin/campanas-wa/:id/reanudar requireAdminSeguro wa',
  ]);
  assert.match(r, /const wa = requireModulo\('whatsapp'\);/);
  assert.equal((r.match(/app\.(get|post|put|patch|delete)\(/g) || []).length, 8);
  // Las de Clientes: todas de administrador, el negocio de la sesión.
  const c = leer('src/services/clientesSaneamientoRutas.js');
  const deClientes = [...c.matchAll(/app\.(get|post|put|patch|delete)\('([^']+)', ([^,]+),/g)].map((m) => `${m[1]} ${m[2]} ${m[3]}`);
  assert.deepEqual(deClientes, [
    'get /api/admin/clientes/telefonos-negocio requireAdminSeguro', 'post /api/admin/clientes/telefonos-negocio requireAdminSeguro',
    'patch /api/admin/clientes/telefonos-negocio/:id requireAdminSeguro', 'patch /api/admin/clientes/v2/:id/interno requireAdminSeguro',
    'get /api/admin/clientes/v2/:id/bitacora requireAdminSeguro',
  ]);
  assert.equal((c.match(/app\.(get|post|put|patch|delete)\(/g) || []).length, 5);
  for (const x of [c, r]) assert.ok(!/req\.(body|query|params)\??\.negocio/i.test(x), 'el negocio sale de la sesión');
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
  // La línea de a quién se manda, sin tener que revisar primero.
  assert.match(texto, /menos quienes se dieron de baja, los teléfonos\s+del negocio y los internos/);
});

await caso('S5 el panel carga clientes-saneamiento.js con su huella, y la ficha y la lista lo usan', () => {
  const panel = leer('panel/index.html');
  const js = readFileSync(new URL('../panel/clientes-saneamiento.js', import.meta.url));
  const huella = createHash('sha256').update(js).digest('hex').slice(0, 8);
  const m = panel.match(/<script src="\/clientes-saneamiento\.js\?v=([0-9a-f]+)"><\/script>/);
  assert.ok(m, 'el panel no carga /clientes-saneamiento.js');
  assert.equal(m[1], huella, `panel: actualiza la etiqueta a ?v=${huella}`);
  const texto = js.toString('utf8');
  assert.ok(!/onclick=/i.test(texto), 'sin onclick en línea');
  assert.deepEqual([...texto.matchAll(/window\.(\w+)\s*=(?!=)/g)].map((x) => x[1]), ['XaborClientesSaneamiento']);
  const rutas = [...new Set([...texto.matchAll(/pedir\(\s*[`']([^`'$?]+)/g)].map((x) => x[1]))];
  assert.ok(rutas.length >= 3 && rutas.every((u) => u.startsWith('/api/admin/clientes/')), `rutas: ${rutas.join(', ')}`);
  // Enganches mínimos en index.html: filtro, botón, chip y la sección de la ficha (solo admin).
  assert.match(panel, /<option value="internos">Internos y teléfonos del negocio<\/option>/);
  assert.match(panel, /internos:'tipo=internos'/);
  assert.match(panel, /data-cls-acc="telefonos"/);
  assert.match(panel, /ROL === 'admin' && window\.XaborClientesSaneamiento \? window\.XaborClientesSaneamiento\.seccionFicha\(c\) : ''/);
  assert.equal((panel.match(/chipSegmento\(c\.esDelNegocio \? 'del_negocio' : c\.segmento\)/g) || []).length, 2);
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
  // 143 (saneamiento de Clientes) va después de la 142, también aditiva.
  const i143 = runner.indexOf("'143-clientes-saneamiento'");
  assert.ok(i143 > i142, 'la 143 no está en SCRIPTS después de la 142');
  assert.match(leer('scripts/predeploy-143-clientes-saneamiento.mjs'), /migrations\/143_clientes_saneamiento\.sql/);
  assert.ok(existsSync(new URL('../migrations/143_clientes_saneamiento_down.sql', import.meta.url)));
  const sql143 = leer('migrations/143_clientes_saneamiento.sql').replace(/^\s*--.*$/gm, '');
  // «ON DELETE RESTRICT» de una llave y «DROP CONSTRAINT IF EXISTS» antes de
  // volver a poner la misma regla no tocan datos; una sentencia sí.
  const sentencias = sql143.replace(/\bON DELETE\b/gi, '');
  assert.ok(!/\bDROP (COLUMN|TABLE|INDEX)\b|(^|;)\s*(DELETE|UPDATE|TRUNCATE|INSERT)\b/im.test(sentencias), 'la 143 debe ser aditiva');
  assert.ok(/\bDROP (COLUMN|TABLE)\b/i.test('ALTER TABLE x DROP COLUMN y') && /(^|;)\s*(DELETE|UPDATE|TRUNCATE|INSERT)\b/im.test('x;\nUPDATE t SET a=1'), 'el regex muerde');
  // 150 (Fase 0.1, campañas programadas): después de la 146, aditiva, con reversa.
  const i146 = runner.indexOf("'146-aviso-promociones'"); const i150 = runner.indexOf("'150-campanas-programadas'");
  assert.ok(i146 > i143 && i150 > i146, 'la 150 no está en SCRIPTS después de la 146');
  assert.match(leer('scripts/predeploy-150-campanas-programadas.mjs'), /migrations\/150_campanas_programadas\.sql/);
  assert.ok(existsSync(new URL('../migrations/150_campanas_programadas_down.sql', import.meta.url)));
  const sql150 = leer('migrations/150_campanas_programadas.sql').replace(/^\s*--.*$/gm, '');
  assert.ok(!/\bDROP (COLUMN|TABLE|INDEX)\b|(^|;)\s*(DELETE|UPDATE|TRUNCATE|INSERT)\b/im.test(sql150), 'la 150 debe ser aditiva');
  assert.match(sql150, /ADD COLUMN IF NOT EXISTS programada_para timestamptz;/);
});

await caso('S6 el formulario: solo el nombre arranca como nombre, «Texto fijo» con su caja, «buen día» y los textos nuevos', () => {
  const js = leer('panel/campanas-wa.js');
  assert.match(js, /<option value="fijo"\$\{esNombre \? '' : ' selected'\}>Texto fijo<\/option>/);
  assert.match(js, /<option value="nombre"\$\{esNombre \? ' selected' : ''\}>El nombre del cliente<\/option>/);
  assert.match(js, /const esNombre = puedeNombre && r\.esNombre === true;/);
  assert.match(js, /style="\$\{esNombre \? 'display:none;' : ''\}"/, 'la caja se ve salvo en el hueco del nombre');
  assert.match(js, /E\.meta\?\.respaldoNombre \|\| 'buen día'/);
  assert.ok(!/value="cliente"/.test(js), 'el respaldo ya no es «cliente»');
  assert.match(js, /Pausar si fallan más del \(%\) de los envíos/);
  assert.equal((js.match(/fallan más del \$\{esc\([^)]*\)\}% de los envíos/g) || []).length, 2, 'historial y resumen con las mismas palabras');
  assert.ok(!/no llegan más del/.test(js), 'queda un «no llegan más del»');
  // Programar: solo con la bandera, la fecha va al crear y cancelar usa «detener».
  assert.match(js, /const pr = E\.meta\?\.programar;\s*\n\s*if \(!pr\) \{ caja\.innerHTML = ''; return; \}/);
  assert.match(js, /post\(\{ \.\.\.rv\.datos, totalVisto: rv\.total, programadaPara \}\)/);
  assert.match(js, /if \(acc === 'cancelar-programada'\) await detener\(b\.dataset\.id, true\);/);
});

console.log(`Campañas WA (puras y cableado): ${n} pasadas, ${fallidas} fallidas. Sin base ni red.`);
if (fallidas) process.exitCode = 1;
