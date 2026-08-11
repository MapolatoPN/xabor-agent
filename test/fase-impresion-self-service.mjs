// Impresión self-service: el restaurante configura sus propias térmicas.
//
// Lo que esta suite tiene que demostrar, más allá de que la feature funciona:
//
//   - Que `enviado` NUNCA significa "salió papel". Solo significa que Windows
//     aceptó los bytes. La frontera entre `fallido` e `incierto` es el primer
//     WritePrinter, y hay casos para las dos ramas.
//   - Que jamás se cae a la impresora predeterminada de Windows. En un local
//     con caja y cocina, "la default" manda la comanda al ticket del cliente.
//   - Que un negocio no puede ver, configurar ni probar el equipo de otro.
//   - Que 58 mm envuelve el texto y no lo recorta: una nota de cocina que
//     desaparece es peor que un ticket feo.
//
// Las llamadas a Win32 se inyectan para poder probar las tres ramas sin
// Windows. Eso NO prueba compatibilidad física con una impresora real -- ver
// LIMITACIONES en el reporte.
//
// Uso: DATABASE_URL=... PANEL_SECRET=... SESSION_SECRET=... ADMIN_PASSWORD=...
//      node test/fase-impresion-self-service.mjs
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';
import WebSocket from 'ws';
import { arrancarServidor } from './lib-servidor.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SEED = JSON.parse(readFileSync(join(__dirname, '.datos-prueba.json'), 'utf8'));
const PUERTO = process.env.TEST_PORT || '4083';

const { crearTokenSesion } = await import('../src/services/session.js');
const { pool, crearUsuarioConPassword } = await import('../src/services/database.js');
const { crearEdge: altaEdge, generarEmparejamiento, canjearEmparejamiento } = await import('../src/services/edgeService.js');
const { listarImpresoras, listarRutas, crearImpresora, crearRuta, crearTrabajosDeComanda,
        crearTrabajosDeDocumento, listarTrabajos } = await import('../src/services/impresionService.js');
const { columnasParaMm, mmParaColumnas, DESTINOS, ANCHOS_MM } = await import('../src/services/impresionSelfService.js');
const { crearTransporteWindowsSpooler, interpretarSalida, escaparNombrePs, construirScript } =
  await import('../edge/transports/windowsSpooler.js');
const { sanitizarImpresoras, normalizarEstado, listarImpresorasWindows } =
  await import('../edge/impresorasWindows.js');
const { envolver, bloque } = await import('../edge/renderers/escpos.js');
const { renderComanda } = await import('../edge/renderers/index.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
async function t(cat, nombre, fn) {
  try { await fn(); console.log(`  OK  [${cat}] ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO [${cat}] ${nombre}: ${e.message}`); fallidas++; fallos.push(`[${cat}] ${nombre}: ${e.message}`); }
}
const cookie = (usuarioId, negocioId, rol) =>
  `xabor_sesion=${encodeURIComponent(crearTokenSesion({ usuarioId, negocioId, rol }))}`;

async function api(base, path, { cookie: ck, method = 'GET', body } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (ck) headers['Cookie'] = ck;
  const r = await fetch(base + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null; try { json = await r.json(); } catch { /* sin JSON */ }
  return { status: r.status, body: json };
}

// ═══════════ 1. El transporte windows_spooler, sin Windows ═══════════
//
// El ejecutor simula lo que devuelve PowerShell en cada escenario real.

function ejecutorSimulado(guion) {
  return async ({ alVerMarca }) => {
    if (guion.escribe) alVerMarca?.();
    if (guion.expiro) return { salida: guion.salida || '', codigoSalida: -1, expiro: true };
    return { salida: guion.salida || '', codigoSalida: guion.codigoSalida ?? 0, error: guion.error || null };
  };
}
const CONFIG_OK = { config: { spoolerNombre: 'OFICHIDO OS518' } };
const BYTES = Buffer.from([0x1b, 0x40, 0x48, 0x4f, 0x4c, 0x41, 0x0a]);

await t('SPOOLER', '1. Windows acepta los bytes -> enviado', async () => {
  let escribio = false;
  const tr = crearTransporteWindowsSpooler({ ejecutor: ejecutorSimulado({ escribe: true, salida: 'ESCRIBIENDO\r\nOK:7\r\n' }) });
  const r = await tr.enviar(CONFIG_OK, BYTES, { alEscribir: () => { escribio = true; } });
  assert.strictEqual(r.resultado, 'enviado');
  assert.ok(escribio, 'alEscribir tiene que avisarse en cuanto empieza la escritura');
  assert.match(r.detalle, /no confirma que haya salido papel/,
    'el detalle no puede sugerir que salió papel');
});

await t('SPOOLER', '2. la impresora no existe -> fallido (nada salió)', async () => {
  const tr = crearTransporteWindowsSpooler({ ejecutor: ejecutorSimulado({ salida: 'ERROR:OPEN:2', codigoSalida: 1 }) });
  const r = await tr.enviar(CONFIG_OK, BYTES, {});
  assert.strictEqual(r.resultado, 'fallido', 'sin abrir la impresora no salió ni un byte: reintentar es seguro');
  assert.strictEqual(r.codigo, 'IMPRESORA_NO_DISPONIBLE');
  assert.match(r.detalle, /siga instalada/);
});

await t('SPOOLER', '3. el spooler rechaza el documento -> fallido', async () => {
  const tr = crearTransporteWindowsSpooler({ ejecutor: ejecutorSimulado({ salida: 'ERROR:STARTDOC:1722', codigoSalida: 1 }) });
  const r = await tr.enviar(CONFIG_OK, BYTES, {});
  assert.strictEqual(r.resultado, 'fallido');
  assert.match(r.detalle, /cola de impresión/);
});

await t('SPOOLER', '4. falla DESPUÉS de empezar a escribir -> incierto', async () => {
  let escribio = false;
  const tr = crearTransporteWindowsSpooler({ ejecutor: ejecutorSimulado({ escribe: true, salida: 'ESCRIBIENDO\r\nERROR:WRITE:6', codigoSalida: 1 }) });
  const r = await tr.enviar(CONFIG_OK, BYTES, { alEscribir: () => { escribio = true; } });
  assert.strictEqual(r.resultado, 'incierto', 'pudo salir medio ticket: no se reintenta solo');
  assert.ok(escribio);
});

await t('SPOOLER', '5. escritura parcial -> incierto', async () => {
  const tr = crearTransporteWindowsSpooler({ ejecutor: ejecutorSimulado({ escribe: true, salida: 'ESCRIBIENDO\r\nERROR:PARCIAL:3 de 7', codigoSalida: 1 }) });
  const r = await tr.enviar(CONFIG_OK, BYTES, {});
  assert.strictEqual(r.resultado, 'incierto');
});

await t('SPOOLER', '6. timeout ANTES de escribir -> fallido', async () => {
  const tr = crearTransporteWindowsSpooler({ ejecutor: ejecutorSimulado({ expiro: true }) });
  const r = await tr.enviar(CONFIG_OK, BYTES, {});
  assert.strictEqual(r.resultado, 'fallido');
  assert.strictEqual(r.codigo, 'SPOOLER_TIMEOUT');
});

await t('SPOOLER', '7. timeout DESPUÉS de empezar a escribir -> incierto', async () => {
  const tr = crearTransporteWindowsSpooler({ ejecutor: ejecutorSimulado({ escribe: true, expiro: true, salida: 'ESCRIBIENDO' }) });
  const r = await tr.enviar(CONFIG_OK, BYTES, {});
  assert.strictEqual(r.resultado, 'incierto',
    'matar el proceso no deshace lo que el spooler ya recibió');
});

await t('SPOOLER', '8. SIN nombre de impresora NO se cae a la default', async () => {
  let ejecutado = false;
  const tr = crearTransporteWindowsSpooler({ ejecutor: async () => { ejecutado = true; return { salida: 'OK:7', codigoSalida: 0 }; } });
  const r = await tr.enviar({ config: {} }, BYTES, {});
  assert.strictEqual(r.resultado, 'fallido');
  assert.strictEqual(r.codigo, 'SIN_IMPRESORA_ASIGNADA');
  assert.strictEqual(ejecutado, false, 'ni siquiera se intentó imprimir: no hay default silenciosa');
});

await t('SPOOLER', '9. si PowerShell no arranca, el Edge no se cae', async () => {
  const tr = crearTransporteWindowsSpooler({ ejecutor: async () => { throw new Error('spawn ENOENT'); } });
  const r = await tr.enviar(CONFIG_OK, BYTES, {});
  assert.strictEqual(r.resultado, 'fallido', 'devuelve resultado, no lanza');
  assert.match(r.detalle, /ENOENT/);
});

await t('SPOOLER', '10. el nombre de impresora se escapa y no puede inyectar', async () => {
  assert.strictEqual(escaparNombrePs("Impresora'; rm -rf /"), "Impresora''; rm -rf /");
  const script = construirScript("O'Brien HP", 'C:/tmp/x.bin');
  assert.ok(script.includes("$prn = 'O''Brien HP'"), 'la comilla se duplica dentro del literal');
  assert.ok(script.includes("pDataType = \"RAW\""), 'siempre RAW: el driver no debe reinterpretar ESC/POS');
  assert.ok(!/Out-Printer/.test(script), 'nada de Out-Printer: convertiría el ESC/POS en basura impresa');
});

await t('SPOOLER', '11. el script cierra handles pase lo que pase', () => {
  const script = construirScript('X', 'C:/tmp/x.bin');
  assert.ok(script.includes('} finally {'));
  assert.ok(script.includes('ClosePrinter'));
  assert.ok(script.includes('EndDocPrinter'));
});

await t('SPOOLER', '12. sin marca de escritura y sin respuesta -> fallido, no incierto', () => {
  const r = interpretarSalida({ salida: '', codigoSalida: 0, empezoAEscribir: false });
  assert.strictEqual(r.resultado, 'fallido');
});

// ═══════════ 2. Enumeración de impresoras ═══════════

await t('ENUM', '13. la lista se sanea: sin puertos, sin drivers, sin duplicados', () => {
  const r = sanitizarImpresoras([
    { nombre: 'OFICHIDO OS518', estado: 'Normal', predeterminada: false, puerto: 'USB002', driver: 'Generic / Text Only' },
    { nombre: 'OFICHIDO OS518', estado: 'Normal' },
    { nombre: '   ', estado: 'Normal' },
    { nombre: 'SUZWIP 58MM', estado: 'Offline', predeterminada: true },
  ]);
  assert.strictEqual(r.length, 2, 'el duplicado y el vacío se caen');
  assert.deepStrictEqual(Object.keys(r[0]).sort(), ['estado', 'nombre', 'predeterminada']);
  assert.ok(!JSON.stringify(r).includes('USB002'), 'el puerto no viaja a la nube');
  assert.ok(!JSON.stringify(r).includes('Generic'), 'el driver tampoco');
});

await t('ENUM', '14. "Normal" de Windows NO se traduce a "conectada"', () => {
  assert.strictEqual(normalizarEstado('Normal'), 'desconocido');
  assert.strictEqual(normalizarEstado('0'), 'desconocido');
  assert.strictEqual(normalizarEstado(undefined), 'desconocido');
  assert.strictEqual(normalizarEstado('Offline'), 'sin_conexion');
  assert.strictEqual(normalizarEstado('PaperOut'), 'sin_papel');
});

await t('ENUM', '15. si Windows falla, se devuelve error y NO se lanza', async () => {
  const r = await listarImpresorasWindows({ ejecutor: async () => ({ ok: false, error: 'timeout' }) });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.impresoras, []);
});

await t('ENUM', '16. un único resultado (objeto, no array) también se entiende', async () => {
  const r = await listarImpresorasWindows({
    ejecutor: async () => ({ ok: true, salida: '{"nombre":"SUZWIP","estado":"Normal","predeterminada":true}' }),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.impresoras.length, 1);
  assert.strictEqual(r.impresoras[0].nombre, 'SUZWIP');
});

// ─── El contrato de la enumeración ──────────────────────────────────────────
//
// Estos cuatro casos existen por un fallo real: el script de PowerShell salía
// con código 0 y stdout VACÍO, y el enumerador lo convertía en `[]` con
// ok:true. El panel decía tranquilamente "este equipo no tiene impresoras"
// mientras Windows tenía seis instaladas. Un fallo disfrazado de éxito no lo
// investiga nadie.

await t('ENUM', '16b. salida válida con impresoras -> ok:true', async () => {
  const r = await listarImpresorasWindows({
    ejecutor: async () => ({ ok: true, salida:
      '[{"nombre":"POS Printer 203DPI  Series 2","estado":"Normal","predeterminada":true},' +
      '{"nombre":"Microsoft Print to PDF","estado":"Normal","predeterminada":false}]' }),
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.impresoras.length, 2);
  assert.strictEqual(r.impresoras[0].nombre, 'POS Printer 203DPI  Series 2',
    'el nombre se conserva TAL CUAL, con sus dos espacios: es la clave del envío');
  assert.strictEqual(r.impresoras[0].predeterminada, true);
});

await t('ENUM', '16c. lista vacía REAL (JSON [] explícito) -> ok:true sin impresoras', async () => {
  // Un equipo sin impresoras instaladas es un caso legítimo, y se distingue
  // de "no pude preguntar" porque PowerShell sí devolvió algo.
  const r = await listarImpresorasWindows({ ejecutor: async () => ({ ok: true, salida: '[]' }) });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.impresoras, []);
  assert.strictEqual(r.error, null);
});

await t('ENUM', '16d. stdout VACÍO inesperado -> ok:false, nunca lista vacía', async () => {
  for (const salida of ['', '   ', '\r\n', null, undefined]) {
    const r = await listarImpresorasWindows({ ejecutor: async () => ({ ok: true, salida }) });
    assert.strictEqual(r.ok, false, `con salida ${JSON.stringify(salida)} NO puede reportar éxito`);
    assert.deepStrictEqual(r.impresoras, []);
    assert.match(r.error, /vacía|no devolvió/i, 'y el error tiene que ser accionable');
  }
});

await t('ENUM', '16e. error de PowerShell -> ok:false', async () => {
  const r = await listarImpresorasWindows({
    ejecutor: async () => ({ ok: false, error: 'powershell.exe no se encontró' }) });
  assert.strictEqual(r.ok, false);
  assert.match(r.error, /powershell/i);

  // Salida que no es JSON (una traza de error, por ejemplo) tampoco es éxito.
  const r2 = await listarImpresorasWindows({
    ejecutor: async () => ({ ok: true, salida: 'Get-Printer : el termino no se reconoce' }) });
  assert.strictEqual(r2.ok, false);
});

await t('ENUM', '16f. el script va en una sola línea (no vuelve el bloque que salía vacío)', () => {
  const fuente = readFileSync(join(__dirname, '..', 'edge', 'impresorasWindows.js'), 'utf8');
  const m = fuente.match(/const SCRIPT_GET_PRINTER =([\s\S]*?);\n/);
  assert.ok(m, 'no se encontró el script');
  const script = m[1];
  assert.ok(!script.includes('$ErrorActionPreference'),
    'ese ajuste, por stdin, hacía que el bloque saliera con 0 y sin salida');
  assert.ok(!/\btry\s*\{/.test(script),
    'el try/catch multilínea por stdin es justo lo que producía stdout vacío');
  assert.ok(script.includes('Get-Printer'), 'sigue usando Get-Printer');
  assert.ok(script.includes('ConvertTo-Json'), 'y devolviendo JSON');
});

// ═══════════ 3. Ancho: milímetros fuera, columnas dentro ═══════════

await t('ANCHO', '17. 58 mm -> 32 columnas, 80 mm -> 42', () => {
  assert.strictEqual(columnasParaMm(58), 32);
  assert.strictEqual(columnasParaMm(80), 42);
  assert.strictEqual(columnasParaMm(70), null, 'solo se admiten los dos anchos reales');
  assert.strictEqual(mmParaColumnas(32), 58);
  assert.strictEqual(mmParaColumnas(42), 80);
});

await t('ANCHO', '18. 58 mm: una nota larga se envuelve, JAMÁS se recorta', () => {
  const nota = 'SIN CEBOLLA SIN CILANTRO la salsa aparte por favor y la carne bien cocida';
  const lineas = envolver(nota, 32);
  assert.ok(lineas.length > 1, 'tiene que partirse en varias líneas');
  for (const l of lineas) assert.ok(l.length <= 32, `línea de ${l.length} columnas: se sale del papel`);
  const reconstruido = lineas.join(' ').replace(/\s+/g, ' ').trim();
  for (const palabra of nota.split(' ')) {
    assert.ok(reconstruido.includes(palabra), `se perdió "${palabra}" al envolver`);
  }
});

await t('ANCHO', '19. 58 mm: una palabra más larga que el papel se parte, no se pierde', () => {
  const lineas = envolver('CHILAQUILESVERDESCONPOLLOYQUESOEXTRA', 32);
  assert.ok(lineas.length >= 2);
  assert.ok(lineas.join('').includes('CHILAQUILESVERDES'));
  for (const l of lineas) assert.ok(l.length <= 32);
});

await t('ANCHO', '20. la comanda de 58 mm no excede el ancho en ninguna línea', () => {
  const payload = {
    negocio: 'Carnitas Moreno', mesa: '5', mesero: 'ANGEL', comanda: 1, emitidoAt: new Date().toISOString(),
    items: [{ cantidad: 2, producto: 'Orden de carnitas surtidas maciza y buche',
              modificadores: ['sin cebolla', 'salsa verde aparte'],
              notas: 'El cliente es alérgico al cilantro, favor de no ponerle NADA de cilantro' }],
  };
  const texto = renderComanda(payload, { ancho: 32 }).toString('latin1');
  // Se miden solo las lineas de TEXTO puro. Las que llevan comandos ESC/POS
  // intercalados no tienen un ancho visible medible desde aqui sin
  // reimplementar el parser de la propia impresora.
  const lineas32 = texto.split('\n').filter((l) => l && !/[\x00-\x1f]/.test(l));
  assert.ok(lineas32.length > 0, 'algo de texto tiene que haber');
  for (const l of lineas32) {
    assert.ok(l.length <= 32, `linea de ${l.length} columnas en 58 mm: "${l}"`);
  }
  assert.ok(texto.includes('cilantro'), 'la nota de cocina no puede desaparecer');
  assert.ok(texto.includes('CARNITAS'), 'el producto tampoco');
});

await t('ANCHO', '21. 80 mm sigue funcionando igual que antes', () => {
  const bytes = renderComanda({
    negocio: 'Nonna Maye', mesa: '3', mesero: 'ANA', comanda: 1, emitidoAt: new Date().toISOString(),
    items: [{ cantidad: 1, producto: 'Lasagna', modificadores: [], notas: null }],
  }, { ancho: 42 });
  const texto = bytes.toString('latin1');
  assert.ok(texto.includes('LASAGNA'), 'el producto sigue saliendo en 80 mm');
  const lineas42 = texto.split('\n').filter((l) => l && !/[\x00-\x1f]/.test(l));
  for (const l of lineas42) {
    assert.ok(l.length <= 42, `linea de ${l.length} columnas en 80 mm`);
  }
  assert.ok(lineas42.some((l) => /^=+$/.test(l) && l.length === 42),
    'el separador de 80 mm sigue midiendo 42 columnas');
});

// ═══════════ 4. Backend self-service, con servidor real ═══════════

const NEG_A = SEED.negocioA;
const NEG_B = SEED.negocioB;
const ADMIN_A = SEED.adminNegocioAUsuarioId;
const STAFF_A = SEED.staffNegocioAUsuarioId;

await pool.query(`DELETE FROM impresion_rutas  WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]);
await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]);
await pool.query(`DELETE FROM impresoras       WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]);

// Un Edge se instala en una sucursal: si el negocio de prueba no tiene
// ninguna activa, el alta falla con SUCURSAL_NO_ENCONTRADA.
for (const n of [NEG_A, NEG_B]) {
  await pool.query(
    `INSERT INTO sucursales (negocio_id, nombre) VALUES ($1, 'Principal')
     ON CONFLICT (negocio_id, nombre) DO UPDATE SET activo = true`, [n]);
}

// Se limpia lo que pudiera haber dejado una corrida anterior interrumpida:
// el alta de Edge exige nombre unico por sucursal y, si no, la suite no
// arranca nunca mas contra la misma base.
await pool.query(
  `DELETE FROM terminales WHERE sucursal_id IN (SELECT id FROM sucursales WHERE negocio_id IN ($1,$2))
     AND nombre IN ('PC-CAJA','PC-VECINA')`, [NEG_A, NEG_B]);

const edgeA = await altaEdge(NEG_A, { nombre: 'PC-CAJA' });
const edgeB = await altaEdge(NEG_B, { nombre: 'PC-VECINA' });
const credA = await canjearEmparejamiento((await generarEmparejamiento(NEG_A, edgeA.id)).codigo);

const adminB = await crearUsuarioConPassword({
  negocioId: NEG_B, nombre: 'Admin Impresion B', email: `admin-print-b-${Date.now()}@test.local`,
  password: 'ClavePrintB123!', rol: 'admin' });

const ckAdminA = cookie(ADMIN_A, NEG_A, 'admin');
const ckStaffA = cookie(STAFF_A, NEG_A, 'staff');
const ckMeseroA = cookie(STAFF_A, NEG_A, 'mesero');
const ckOperadorA = cookie(STAFF_A, NEG_A, 'operador');
const ckAdminB = cookie(adminB.id, NEG_B, 'admin');

const srv = await arrancarServidor({ PORT: PUERTO }, { timeoutMs: 30000 });
const BASE = srv.base;
const RUTA = '/api/impresion/self-service';
let agente = null;   // declarado fuera del try: el finally tiene que poder cerrarlo

// Un Edge de mentira que habla el protocolo real por el WebSocket real.
function agenteFalso(cred, { impresoras = [], responder = true } = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${PUERTO}/ws/print-agent`);
    const recibidos = [];
    ws.on('open', () => ws.send(JSON.stringify({
      tipo: 'autenticar_terminal', terminalId: cred.terminalId, token: cred.token, instalacionId: 'inst-prueba' })));
    ws.on('message', (crudo) => {
      const msg = JSON.parse(crudo.toString());
      recibidos.push(msg);
      if (msg.tipo === 'terminal_autenticada') resolve({ ws, recibidos, cerrar: () => ws.close() });
      if (msg.tipo === 'solicitar_impresoras' && responder) {
        ws.send(JSON.stringify({ tipo: 'impresoras_detectadas', solicitudId: msg.solicitudId, ok: true, impresoras }));
      }
    });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('el agente falso no se autenticó')), 8000);
  });
}

try {

await t('SELF', '22. sin equipo conectado, el panel lo dice claro', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.hayEquipo, true, 'el equipo existe aunque esté apagado');
  assert.strictEqual(r.body.equipos[0].conectado, false);
  assert.strictEqual(r.body.equipos[0].consultaOk, false);
  assert.match(r.body.equipos[0].errorConsulta, /no está conectado/);
});

await t('SELF', '23. con el equipo conectado se listan sus impresoras de Windows', async () => {
  agente = await agenteFalso(credA, {
    impresoras: [
      { nombre: 'OFICHIDO OS518', predeterminada: false, estado: 'desconocido' },
      { nombre: 'SUZWIP 58MM', predeterminada: true, estado: 'desconocido' },
    ],
  });
  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  assert.strictEqual(r.status, 200);
  const eq = r.body.equipos[0];
  assert.strictEqual(eq.conectado, true);
  assert.strictEqual(eq.consultaOk, true);
  assert.deepStrictEqual(eq.detectadas.map((d) => d.nombre), ['OFICHIDO OS518', 'SUZWIP 58MM']);
});

await t('SELF', '24. asignar Cocina 58 mm crea impresora y ruta comanda', async () => {
  const r = await api(BASE, RUTA + '/asignar', {
    cookie: ckAdminA, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'OFICHIDO OS518', destino: 'cocina', anchoMm: 58 },
  });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  const imps = await listarImpresoras(NEG_A);
  const imp = imps.find((i) => i.config?.spoolerNombre === 'OFICHIDO OS518');
  assert.ok(imp, 'la impresora tiene que quedar guardada');
  assert.strictEqual(imp.transporte, 'windows_spooler');
  assert.strictEqual(imp.ancho_columnas, 32, '58 mm son 32 columnas');
  const rutas = await listarRutas(NEG_A);
  assert.ok(rutas.some((x) => x.impresora_id === imp.id && x.ambito === 'documento' && x.clave === 'comanda'));
});

await t('SELF', '25. asignar Caja 58 mm a la otra impresora', async () => {
  const r = await api(BASE, RUTA + '/asignar', {
    cookie: ckAdminA, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'SUZWIP 58MM', destino: 'caja', anchoMm: 58 },
  });
  assert.strictEqual(r.status, 200);
  const rutas = await listarRutas(NEG_A);
  assert.ok(rutas.some((x) => x.ambito === 'documento' && x.clave === 'cuenta'));
});

await t('SELF', '26. reasignar la MISMA impresora no la duplica', async () => {
  const antes = (await listarImpresoras(NEG_A)).length;
  await api(BASE, RUTA + '/asignar', {
    cookie: ckAdminA, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'OFICHIDO OS518', destino: 'cocina', anchoMm: 80 },
  });
  const despues = await listarImpresoras(NEG_A);
  assert.strictEqual(despues.length, antes, 'dos clics no pueden dejar dos impresoras iguales');
  const imp = despues.find((i) => i.config?.spoolerNombre === 'OFICHIDO OS518');
  assert.strictEqual(imp.ancho_columnas, 42, 'el ancho sí se actualiza');
  const rutasComanda = (await listarRutas(NEG_A)).filter((r) => r.impresora_id === imp.id && r.ambito === 'documento');
  assert.strictEqual(rutasComanda.length, 1, 'tampoco se acumulan rutas duplicadas');
  // Se deja otra vez en 58 mm para el resto de la suite.
  await api(BASE, RUTA + '/asignar', { cookie: ckAdminA, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'OFICHIDO OS518', destino: 'cocina', anchoMm: 58 } });
});

await t('SELF', '27. un ancho que no es 58 ni 80 se rechaza', async () => {
  const r = await api(BASE, RUTA + '/asignar', {
    cookie: ckAdminA, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'OFICHIDO OS518', destino: 'cocina', anchoMm: 70 },
  });
  assert.strictEqual(r.status, 400);
});

await t('SELF', '28. impresora configurada que ya no aparece: se marca, NO se borra', async () => {
  agente.cerrar();
  await new Promise((r) => setTimeout(r, 300));
  // El equipo vuelve, pero Windows ya no reporta la OFICHIDO (apagada).
  agente = await agenteFalso(credA, { impresoras: [{ nombre: 'SUZWIP 58MM', predeterminada: true, estado: 'desconocido' }] });

  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  const eq = r.body.equipos[0];
  const ofi = eq.asignadas.find((a) => a.nombreWindows === 'OFICHIDO OS518');
  assert.ok(ofi, 'la configuración NO se borra: la impresora puede estar solo apagada');
  assert.strictEqual(ofi.presente, false, 'se marca como no encontrada');
  assert.deepStrictEqual(ofi.destinos, ['cocina'], 'conserva su asignación para cuando vuelva');
});

// ═══════════ 5. Roles ═══════════

for (const [rol, ck] of [['staff', ckStaffA], ['mesero', ckMeseroA], ['operador', ckOperadorA]]) {
  await t('ROLES', `29. ${rol} no puede ver ni configurar impresoras -> 403`, async () => {
    assert.strictEqual((await api(BASE, RUTA, { cookie: ck })).status, 403);
    const asignar = await api(BASE, RUTA + '/asignar', { cookie: ck, method: 'POST',
      body: { terminalId: edgeA.id, nombreWindows: 'X', destino: 'cocina', anchoMm: 58 } });
    assert.strictEqual(asignar.status, 403);
  });
}

await t('ROLES', '30. sin sesión, todo falla cerrado', async () => {
  assert.strictEqual((await api(BASE, RUTA)).status, 401);
  assert.strictEqual((await api(BASE, RUTA + '/asignar', { method: 'POST', body: {} })).status, 401);
});

// ═══════════ 6. Aislamiento multiempresa (P0) ═══════════

await t('AISLAMIENTO', '31. el vecino no ve el equipo ni las impresoras de A', async () => {
  const r = await api(BASE, RUTA, { cookie: ckAdminB });
  assert.strictEqual(r.status, 200);
  const nombres = r.body.equipos.map((e) => e.nombre);
  assert.ok(!nombres.includes('PC-CAJA'), 'B no puede ver el equipo de A');
  const asignadas = r.body.equipos.flatMap((e) => e.asignadas.map((a) => a.nombreWindows));
  assert.ok(!asignadas.includes('OFICHIDO OS518'), 'ni sus impresoras');
});

await t('AISLAMIENTO', '32. B no puede configurar el equipo de A aunque mande su id', async () => {
  const r = await api(BASE, RUTA + '/asignar', {
    cookie: ckAdminB, method: 'POST',
    body: { terminalId: edgeA.id, nombreWindows: 'ROBADA', destino: 'cocina', anchoMm: 58 },
  });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.error, /no es de este negocio/);
  const imps = await listarImpresoras(NEG_A);
  assert.ok(!imps.some((i) => i.config?.spoolerNombre === 'ROBADA'), 'no se creó nada en A');
});

await t('AISLAMIENTO', '33. mandar negocio_id en el cuerpo no cambia de empresa', async () => {
  const r = await api(BASE, RUTA + '/asignar', {
    cookie: ckAdminB, method: 'POST',
    body: { terminalId: edgeB.id, nombreWindows: 'DE B', destino: 'caja', anchoMm: 80,
            negocioId: NEG_A, negocio_id: NEG_A },
  });
  assert.strictEqual(r.status, 200);
  const impsA = await listarImpresoras(NEG_A);
  assert.ok(!impsA.some((i) => i.config?.spoolerNombre === 'DE B'), 'la impresora quedó en B, no en A');
  const impsB = await listarImpresoras(NEG_B);
  assert.ok(impsB.some((i) => i.config?.spoolerNombre === 'DE B'));
});

await t('AISLAMIENTO', '34. B no puede lanzar prueba en una impresora de A', async () => {
  const impA = (await listarImpresoras(NEG_A)).find((i) => i.config?.spoolerNombre === 'OFICHIDO OS518');
  const r = await api(BASE, `/api/impresion/impresoras/${impA.id}/prueba`, { cookie: ckAdminB, method: 'POST' });
  assert.ok(r.status === 404 || r.status === 403, `esperaba 404/403, llegó ${r.status}`);
});

await t('AISLAMIENTO', '35. un Edge de A no recibe trabajos de B', async () => {
  const impB = (await listarImpresoras(NEG_B)).find((i) => i.config?.spoolerNombre === 'DE B');
  await crearRuta(NEG_B, { impresoraId: impB.id, ambito: 'documento', clave: 'cuenta' }).catch(() => {});
  const antes = agente.recibidos.filter((m) => m.tipo === 'trabajo_impresion').length;
  await crearTrabajosDeDocumento({
    negocioId: NEG_B, documento: 'cuenta', origenTipo: 'prueba', origenId: `cross-${Date.now()}`,
    payload: { negocio: 'Vecino', total: 100 },
  });
  await new Promise((r) => setTimeout(r, 600));
  const despues = agente.recibidos.filter((m) => m.tipo === 'trabajo_impresion').length;
  assert.strictEqual(despues, antes, 'el Edge de A no puede recibir ni un trabajo de B');
});

// ═══════════ 7. Prueba de impresión ═══════════

await t('PRUEBA', '36. Imprimir prueba no crea pedido, venta ni comanda', async () => {
  const impA = (await listarImpresoras(NEG_A)).find((i) => i.config?.spoolerNombre === 'OFICHIDO OS518');
  const { rows: [antes] } = await pool.query(
    `SELECT (SELECT count(*) FROM pedidos WHERE negocio_id=$1)::int AS pedidos`, [NEG_A]);

  const r = await api(BASE, `/api/impresion/impresoras/${impA.id}/prueba`, { cookie: ckAdminA, method: 'POST' });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));   // 201: crea el trabajo de prueba

  const { rows: [despues] } = await pool.query(
    `SELECT (SELECT count(*) FROM pedidos WHERE negocio_id=$1)::int AS pedidos`, [NEG_A]);
  assert.strictEqual(despues.pedidos, antes.pedidos, 'una prueba de hardware no puede crear un pedido');

  const trabajos = await listarTrabajos(NEG_A, { limite: 5 });
  assert.ok(trabajos.some((t) => t.documento === 'prueba' || t.origen_tipo === 'prueba'),
    'sí tiene que quedar el trabajo de prueba');
});

// ═══════════ 8. Routing real ═══════════

await t('ROUTING', '37. la comanda va SOLO a Cocina', async () => {
  const impCocina = (await listarImpresoras(NEG_A)).find((i) => i.config?.spoolerNombre === 'OFICHIDO OS518');
  const impCaja = (await listarImpresoras(NEG_A)).find((i) => i.config?.spoolerNombre === 'SUZWIP 58MM');
  const r = await crearTrabajosDeDocumento({
    negocioId: NEG_A, documento: 'comanda', origenTipo: 'prueba', origenId: `rt-cocina-${Date.now()}`,
    payload: { negocio: 'Carnitas', items: [] },
  });
  const impresorasUsadas = new Set((r.creados || []).map((c) => c.impresora_id));
  assert.ok(impresorasUsadas.has(impCocina.id), 'la comanda tiene que llegar a Cocina');
  assert.ok(!impresorasUsadas.has(impCaja.id), 'y NO a la caja');
});

await t('ROUTING', '38. la cuenta va SOLO a Caja', async () => {
  const impCocina = (await listarImpresoras(NEG_A)).find((i) => i.config?.spoolerNombre === 'OFICHIDO OS518');
  const impCaja = (await listarImpresoras(NEG_A)).find((i) => i.config?.spoolerNombre === 'SUZWIP 58MM');
  const r = await crearTrabajosDeDocumento({
    negocioId: NEG_A, documento: 'cuenta', origenTipo: 'prueba', origenId: `rt-caja-${Date.now()}`,
    payload: { negocio: 'Carnitas', total: 250 },
  });
  const usadas = new Set((r.creados || []).map((c) => c.impresora_id));
  assert.ok(usadas.has(impCaja.id));
  assert.ok(!usadas.has(impCocina.id));
});

await t('ROUTING', '39. un documento sin destino configurado NO va a ninguna impresora', async () => {
  const r = await crearTrabajosDeDocumento({
    negocioId: NEG_A, documento: 'cancelacion', origenTipo: 'prueba', origenId: `rt-sin-${Date.now()}`,
    payload: { negocio: 'Carnitas' },
  });
  assert.strictEqual((r.creados || []).length, 0,
    'sin ruta no se elige una impresora "cualquiera": eso sería imprimir en la caja por accidente');
  assert.ok((r.sinRuta || []).length > 0 || (r.avisos || []).length > 0,
    'y el problema tiene que quedar registrado, no en silencio');
});

await t('ROUTING', '40. el mismo documento dos veces no duplica el trabajo', async () => {
  const origenId = `idem-${Date.now()}`;
  const uno = await crearTrabajosDeDocumento({
    negocioId: NEG_A, documento: 'cuenta', origenTipo: 'prueba', origenId, payload: { total: 1 } });
  const dos = await crearTrabajosDeDocumento({
    negocioId: NEG_A, documento: 'cuenta', origenTipo: 'prueba', origenId, payload: { total: 1 } });
  assert.ok((uno.creados || []).length > 0);
  assert.strictEqual((dos.creados || []).length, 0, 'el segundo intento no crea nada nuevo');
  assert.ok((dos.duplicados || []).length > 0, 'se reconoce como duplicado');
});

// ═══════════ 9. Protocolo cerrado ═══════════

await t('PROTOCOLO', '41. el agente ignora cualquier mensaje que no sea del contrato', async () => {
  const fuente = readFileSync(join(__dirname, '..', 'edge', 'connection.js'), 'utf8');
  assert.ok(!/eval\(|new Function|exec\(|spawn\(/.test(fuente),
    'la conexión no puede ejecutar nada que venga de la nube');
  assert.ok(fuente.includes("msg.tipo === 'solicitar_impresoras'"));
  // `solicitar_impresoras` no lleva parámetros: no hay nada que la nube pueda
  // inyectar en el cómo.
  const bloqueSolicitud = fuente.slice(fuente.indexOf("msg.tipo === 'solicitar_impresoras'"));
  assert.ok(!/msg\.(comando|script|ruta|cmd|powershell)/i.test(bloqueSolicitud.slice(0, 900)),
    'ningún campo ejecutable del mensaje se usa');
});

await t('PROTOCOLO', '42. el Edge no puede contestar por otra terminal', async () => {
  // Se responde una solicitud inventada: la nube tiene que ignorarla porque
  // el solicitudId no está pendiente para esta terminal.
  agente.ws.send(JSON.stringify({
    tipo: 'impresoras_detectadas', solicitudId: '00000000-0000-0000-0000-000000000000',
    ok: true, impresoras: [{ nombre: 'INYECTADA' }] }));
  await new Promise((r) => setTimeout(r, 300));
  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  const nombres = r.body.equipos.flatMap((e) => e.detectadas.map((d) => d.nombre));
  assert.ok(!nombres.includes('INYECTADA'));
});

await t('PROTOCOLO', '43. si el equipo no responde, el panel no se queda colgado', async () => {
  agente.cerrar();
  await new Promise((r) => setTimeout(r, 300));
  const mudo = await agenteFalso(credA, { responder: false });
  const t0 = Date.now();
  const r = await api(BASE, RUTA, { cookie: ckAdminA });
  const tardo = Date.now() - t0;
  assert.strictEqual(r.status, 200);
  assert.ok(tardo < 15000, `tardó ${tardo}ms: el panel tiene que rendirse pronto`);
  assert.strictEqual(r.body.equipos[0].consultaOk, false);
  assert.match(r.body.equipos[0].errorConsulta, /no respondió/);
  mudo.cerrar();
  agente = null;
});

} finally {
  if (agente) agente.cerrar();
  srv.detener();
  await new Promise((r) => { srv.proc.once('exit', r); setTimeout(r, 3000); });
  await pool.query(`DELETE FROM impresion_rutas WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]).catch(() => {});
  await pool.query(`DELETE FROM impresion_trabajos WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]).catch(() => {});
  await pool.query(`DELETE FROM impresoras WHERE negocio_id IN ($1,$2)`, [NEG_A, NEG_B]).catch(() => {});
  await pool.query(`DELETE FROM terminales WHERE id IN ($1,$2)`, [edgeA.id, edgeB.id]).catch(() => {});
}

console.log(`\nRESULTADO: ${pasadas} pasadas, ${fallidas} fallidas de ${pasadas + fallidas}`);
if (fallos.length) for (const f of fallos) console.log(`  - ${f}`);
await pool.end();
process.exit(fallidas ? 1 : 0);
