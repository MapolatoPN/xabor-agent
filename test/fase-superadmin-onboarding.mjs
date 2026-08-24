// Alta de negocios: combinaciones imposibles rechazadas, no aceptadas.
//
// El problema: la pantalla dejaba crear Restaurante sin Menú, o Cotizaciones
// sin su generador. El negocio quedaba creado y el hueco aparecía días
// después, en operación, como una pantalla vacía o un 409 sin explicación.
//
// Lo que esta suite fija:
//   - Las dependencias son las DEMOSTRADAS por el código, no supuestas.
//   - La UI previene; el BACKEND garantiza. Un alta por API con la pantalla
//     desactualizada tampoco puede crear un negocio roto.
//   - Los presets son atajos, no restricciones.
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import assert from 'assert';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVIDOR = readFileSync(join(__dirname, '..', 'src', 'server.js'), 'utf8');
const PANEL = readFileSync(join(__dirname, '..', 'panel', 'superadmin.html'), 'utf8');

const {
  DEPENDENCIAS, GRUPOS, PRESETS,
  validarCombinacion, expandirDependencias, describirDependencias,
  dependientesDe, checklistOnboarding,
} = await import('../src/services/modulosDependencias.js');
const { listarModulosDisponibles } = await import('../src/services/database.js');

let pasadas = 0, fallidas = 0;
const fallos = [];
function t(nombre, fn) {
  try { fn(); console.log(`  OK  ${nombre}`); pasadas++; }
  catch (e) { console.log(`FALLO ${nombre}: ${e.message}`); fallidas++; fallos.push(`${nombre}: ${e.message}`); }
}

const CLAVES = listarModulosDisponibles().map(m => m.clave);
const NOMBRES = Object.fromEntries(listarModulosDisponibles().map(m => [m.clave, m.nombre]));

t('1. toda dependencia declarada apunta a módulos que existen de verdad', () => {
  for (const [modulo, deps] of Object.entries(DEPENDENCIAS)) {
    assert.ok(CLAVES.includes(modulo), `dependencia declarada para un módulo inexistente: ${modulo}`);
    for (const d of deps) {
      assert.ok(CLAVES.includes(d), `${modulo} declara depender de ${d}, que no existe`);
      assert.notStrictEqual(d, modulo, `${modulo} depende de sí mismo`);
    }
  }
});

t('2. las dependencias son las que el CÓDIGO demuestra, no suposiciones', () => {
  // Restaurante: restauranteService toca pedidos_activos (POS) y el alta de
  // items resuelve producto_id contra el menú.
  assert.deepStrictEqual([...DEPENDENCIAS.restaurante].sort(), ['menu', 'pos']);
  // Caja: el corte se calcula desde pedidos_activos.
  assert.deepStrictEqual(DEPENDENCIAS.caja, ['pos']);
  // Tienda y Rappi arman su catálogo desde menu_productos.
  assert.deepStrictEqual(DEPENDENCIAS.tienda_online, ['menu']);
  assert.deepStrictEqual(DEPENDENCIAS.rappi, ['menu']);
  // Cotizaciones: hay rutas con DOBLE requireModulo en el servidor.
  assert.ok(SERVIDOR.includes("requireModulo('cotizaciones'), requireModulo('generador_cotizaciones')"),
    'si esa ruta cambió, la dependencia declarada ya no está demostrada');
  assert.ok(SERVIDOR.includes("requireModulo('cotizaciones'), requireModulo('chat_documentos_pdf')"));
  assert.deepStrictEqual([...DEPENDENCIAS.cotizaciones].sort(), ['chat_documentos_pdf', 'generador_cotizaciones']);
  // Chat multimedia: responde 409 sin credenciales de WhatsApp.
  assert.deepStrictEqual(DEPENDENCIAS.chat_imagenes, ['whatsapp']);
  assert.deepStrictEqual(DEPENDENCIAS.chat_documentos_pdf, ['whatsapp']);
});

t('3. NO se inventaron dependencias que el código no sostiene', () => {
  // Hipótesis razonables que resultaron NO demostradas: obligarlas encarecería
  // el alta sin motivo.
  assert.ok(!(DEPENDENCIAS.restaurante || []).includes('caja'), 'restaurante opera sin el módulo de caja');
  assert.ok(!(DEPENDENCIAS.restaurante || []).includes('impresion'), 'la impresión degrada sola (sinRuta), no bloquea');
  assert.ok(!(DEPENDENCIAS.restaurante || []).includes('usuarios'));
  assert.ok(!(DEPENDENCIAS.asistente_comercial_cotizaciones || []).includes('menu'));
  assert.ok(!(DEPENDENCIAS.rewards || []).includes('whatsapp'),
    'rewards notifica por WhatsApp pero omite el aviso sin integración: no es dependencia');
});

t('4. restaurante sin menú se RECHAZA, con el motivo', () => {
  const r = validarCombinacion(['restaurante', 'pos'], { nombresUI: NOMBRES });
  assert.strictEqual(r.ok, false);
  assert.deepStrictEqual(r.faltantes, [{ modulo: 'restaurante', requiere: 'menu' }]);
  assert.match(r.error, /Menú/);
  // Y con menú sí pasa.
  assert.strictEqual(validarCombinacion(['restaurante', 'pos', 'menu']).ok, true);
});

t('5. tienda y rappi exigen menú; cotizaciones exige sus dos compañeros', () => {
  assert.strictEqual(validarCombinacion(['tienda_online']).ok, false);
  assert.strictEqual(validarCombinacion(['tienda_online', 'menu']).ok, true);
  assert.strictEqual(validarCombinacion(['rappi']).ok, false);
  assert.strictEqual(validarCombinacion(['rappi', 'menu']).ok, true);
  assert.strictEqual(validarCombinacion(['cotizaciones', 'generador_cotizaciones']).ok, false);
  assert.strictEqual(validarCombinacion(['cotizaciones', 'generador_cotizaciones', 'chat_documentos_pdf', 'whatsapp']).ok, true);
});

t('6. chat multimedia exige WhatsApp', () => {
  assert.strictEqual(validarCombinacion(['chat_imagenes']).ok, false);
  assert.strictEqual(validarCombinacion(['chat_imagenes', 'whatsapp']).ok, true);
  const r = validarCombinacion(['chat_documentos_pdf'], { nombresUI: NOMBRES });
  assert.match(r.error, /WhatsApp/);
});

t('7. una combinación vacía o mínima es válida (no se obliga a contratar de más)', () => {
  assert.strictEqual(validarCombinacion([]).ok, true);
  assert.strictEqual(validarCombinacion(['pos']).ok, true);
  assert.strictEqual(validarCombinacion(['usuarios', 'whatsapp']).ok, true, 'un negocio de servicios no necesita POS');
});

t('8. expandir dependencias funciona en cascada y dice qué agregó', () => {
  const r = expandirDependencias(['restaurante']);
  assert.deepStrictEqual([...r.modulos].sort(), ['menu', 'pos', 'restaurante']);
  assert.deepStrictEqual([...r.agregados].sort(), ['menu', 'pos']);
  // Cascada de dos niveles: cotizaciones -> chat_documentos_pdf -> whatsapp.
  const c = expandirDependencias(['cotizaciones']);
  assert.ok(c.modulos.includes('whatsapp'), 'no siguió la cascada de segundo nivel');
  assert.strictEqual(validarCombinacion(c.modulos).ok, true, 'lo expandido debe quedar siempre válido');
  // Y expandir es idempotente.
  assert.deepStrictEqual(expandirDependencias(c.modulos).agregados, []);
});

t('9. se sabe qué módulos impiden quitar otro', () => {
  assert.deepStrictEqual(dependientesDe('menu', ['restaurante', 'pos', 'menu']), ['restaurante']);
  assert.deepStrictEqual(dependientesDe('pos', ['caja', 'pos']), ['caja']);
  assert.deepStrictEqual(dependientesDe('rewards', ['pos', 'rewards']), [], 'nadie depende de rewards');
});

t('10. EL BACKEND GARANTIZA: el alta valida la combinación antes de crear', () => {
  const alta = SERVIDOR.slice(SERVIDOR.indexOf("app.post('/api/superadmin/negocios'"),
    SERVIDOR.indexOf("app.post('/api/superadmin/negocios/:negocioId/reenviar-invitacion'"));
  const posValidacion = alta.indexOf('validarCombinacion(');
  const posCreacion = alta.indexOf('crearNegocioCompleto(');
  assert.ok(posValidacion > -1, 'el alta no valida dependencias');
  assert.ok(posValidacion < posCreacion, 'se valida DESPUÉS de crear: el negocio roto ya existiría');
  assert.match(alta, /return res\.status\(400\)\.json\(\{ error: combinacion\.error/);
});

t('11. EL BACKEND GARANTIZA también al editar los módulos de un negocio', () => {
  const patch = SERVIDOR.slice(SERVIDOR.indexOf("app.patch('/api/superadmin/negocios/:negocioId/modulos'"),
    SERVIDOR.indexOf('// Fuente única de módulos para la UI'));
  assert.match(patch, /validarCombinacion\(/, 'quitar un módulo puede romper otro y no se valida');
  // Se valida el ESTADO FINAL, no solo el parche: si no, quitar 'menu' a un
  // negocio con restaurante pasaría porque el parche no menciona restaurante.
  assert.match(patch, /negocio_modulos WHERE negocio_id/);
  assert.match(patch, /finales/);
});

t('12. la pantalla NO duplica las dependencias: las recibe del backend', () => {
  assert.match(SERVIDOR, /res\.json\(\{ modulos, grupos: GRUPOS_MODULOS, presets: PRESETS_MODULOS, dependencias: DEPENDENCIAS_MODULOS \}\)/,
    'el catálogo debe servir dependencias, grupos y presets');
  assert.match(PANEL, /if \(dependencias && typeof dependencias === 'object'\) DEPENDENCIAS_MOD = dependencias;/);
  // Y no hay una tabla de dependencias escrita a mano en el panel.
  assert.ok(!/DEPENDENCIAS_MOD\s*=\s*\{\s*restaurante/.test(PANEL),
    'quedó una copia hardcodeada de las dependencias en la pantalla');
});

t('13. la pantalla activa dependencias al marcar y explica al intentar quitar', () => {
  const fn = PANEL.slice(PANEL.indexOf('function alCambiarModulo'), PANEL.indexOf('function aplicarPresetNegocio'));
  assert.match(fn, /Se activó también/, 'marcar un módulo debe activar sus dependencias Y decirlo');
  assert.match(fn, /es necesario mientras/, 'quitar una dependencia debe explicarse');
  assert.match(fn, /input\.checked = true;/, 'debe revertir el desmarcado que rompería otro módulo');
});

t('14. los presets son atajos, no restricciones', () => {
  const claves = PRESETS.map(p => p.clave);
  assert.deepStrictEqual(claves, ['restaurante', 'retail', 'servicios', 'personalizado']);
  for (const p of PRESETS) {
    for (const m of p.modulos) assert.ok(CLAVES.includes(m), `preset ${p.clave} activa un módulo inexistente: ${m}`);
    // Ningún preset puede dejar una combinación inválida.
    assert.strictEqual(validarCombinacion(p.modulos).ok, true, `el preset ${p.clave} produce una combinación inválida`);
  }
  // "Personalizado" arranca de cero.
  assert.deepStrictEqual(PRESETS.find(p => p.clave === 'personalizado').modulos, []);
  // Y no sobreconfiguran: servicios no lleva POS ni restaurante.
  const servicios = PRESETS.find(p => p.clave === 'servicios').modulos;
  assert.ok(!servicios.includes('pos') && !servicios.includes('restaurante'),
    'un negocio de servicios no necesita mostrador');
  // Después de aplicar un preset se puede personalizar: la pantalla no
  // bloquea los checkboxes.
  const fnPreset = PANEL.slice(PANEL.indexOf('function aplicarPresetNegocio'), PANEL.indexOf('function pintarPresetsNegocio'));
  assert.ok(!/disabled/.test(fnPreset), 'un preset no puede dejar los módulos bloqueados');
});

t('15. ningún módulo desaparece de la pantalla al agruparlos', () => {
  const enGrupos = new Set(GRUPOS.flatMap(g => g.modulos));
  const fuera = CLAVES.filter(c => !enGrupos.has(c));
  // Los que no están en un grupo deben caer en la sección "Otros" que arma
  // la pantalla: agrupar no puede esconder un módulo contratable.
  assert.match(PANEL, /const sueltos = MODULOS\.filter\(m => !enGrupos\.has\(m\)\);/,
    'la pantalla debe recoger los módulos que no estén en ningún grupo');
  for (const g of GRUPOS) {
    for (const m of g.modulos) assert.ok(CLAVES.includes(m), `el grupo ${g.clave} lista un módulo inexistente: ${m}`);
  }
  assert.ok(fuera.length <= 2, `demasiados módulos sin grupo: ${fuera.join(', ')}`);
});

t('16. la checklist de puesta en marcha solo lista lo contratado', () => {
  const conTodo = checklistOnboarding(['pos', 'menu', 'usuarios', 'caja', 'impresion', 'restaurante', 'whatsapp', 'pagos', 'tienda_online', 'rappi']);
  const titulos = conTodo.map(p => p.titulo);
  assert.ok(titulos.includes('Cargar el menú') && titulos.includes('Conectar WhatsApp'));
  assert.ok(titulos.includes('Configurar mesas y meseros'));

  const minimo = checklistOnboarding(['usuarios']);
  const tMin = minimo.map(p => p.titulo);
  assert.ok(!tMin.includes('Conectar WhatsApp'), 'no se puede pedir configurar lo que no se contrató');
  assert.ok(!tMin.includes('Cargar el menú'));
  // Los dos primeros pasos siempre están.
  assert.strictEqual(minimo[0].titulo, 'Negocio creado');
  assert.strictEqual(minimo[1].titulo, 'Administrador con contraseña');
  // Y la pantalla la pinta después de crear.
  assert.match(PANEL, /pintarChecklistOnboarding\(modulosIniciales, nombre\)/);
});

t('17. el estado inicial sigue siendo Pendiente por defecto', () => {
  // Ya era la semántica del sistema: no se cambia, se verifica que sigue.
  assert.match(PANEL, /document\.getElementById\('ng-estado-nuevo'\)\.value = 'pendiente';/);
  assert.match(PANEL, /<option value="pendiente">Pendiente \(onboarding en curso\)<\/option>/);
  assert.match(SERVIDOR, /\['pendiente', 'activo'\]\.includes\(estadoInicial\)/,
    'el backend debe seguir aceptando solo pendiente o activo');
});

t('18. describir dependencias produce texto legible para la UI', () => {
  assert.strictEqual(describirDependencias('restaurante', NOMBRES), 'requiere POS y Menú');
  assert.strictEqual(describirDependencias('caja', NOMBRES), 'requiere POS');
  assert.strictEqual(describirDependencias('pos', NOMBRES), null, 'un módulo sin dependencias no debe inventar texto');
});

console.log(`\n${pasadas} pasadas, ${fallidas} fallidas`);
if (fallos.length) { console.log('FALLOS:'); fallos.forEach(f => console.log(' - ' + f)); }
process.exit(fallidas ? 1 : 0);
