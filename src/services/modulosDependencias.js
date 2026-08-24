/**
 * modulosDependencias.js — Qué módulos necesita cada módulo para funcionar.
 *
 * El alta de negocios permitía combinaciones imposibles: Restaurante sin
 * Menú, Cotizaciones sin su generador, Chat con imágenes sin WhatsApp. El
 * negocio quedaba creado y el problema aparecía días después, en operación,
 * como una pantalla vacía o un 409 sin explicación.
 *
 * REGLA DE ESTE ARCHIVO: aquí SOLO viven dependencias demostradas por el
 * código, con la evidencia anotada. Una dependencia inventada es peor que
 * ninguna: obliga a contratar módulos que no hacen falta y encarece el alta
 * sin motivo. Lo que no está probado va como RECOMENDACIÓN (presets), que el
 * superadmin puede quitar.
 *
 * Es la fuente ÚNICA: el panel la consume por /api/superadmin/modulos-disponibles
 * y el backend valida con las mismas funciones. La UI previene; el backend
 * garantiza.
 */

/**
 * Dependencias OBLIGATORIAS. Cada una con la evidencia que la sostiene.
 */
export const DEPENDENCIAS = Object.freeze({
  // src/services/restauranteService.js lee y escribe pedidos_activos (la
  // cuenta de la mesa termina siendo un pedido) y el alta de items resuelve
  // producto_id contra el menú ("idéntico a POS, sin implementación
  // divergente" -- server.js, ruta /api/restaurante/cuentas/:id/items).
  restaurante: ['pos', 'menu'],

  // El corte se calcula desde pedidos_activos: sin POS no hay nada que
  // arquear (src/services/cortesCaja.js).
  caja: ['pos'],

  // tiendaOnline.js arma el catálogo desde menu_productos/menu_categorias.
  tienda_online: ['menu'],

  // construirCatalogoRappi() lee menu_productos/menu_categorias.
  rappi: ['menu'],

  // rewardsService.acumularPuntos se dispara desde el hook de entrega de
  // pedidos (orderManager.js): sin POS nunca se acredita nada.
  rewards: ['pos'],

  // Rutas con doble requireModulo en server.js: cotizaciones +
  // generador_cotizaciones, y cotizaciones + chat_documentos_pdf para el
  // envío del PDF.
  cotizaciones: ['generador_cotizaciones', 'chat_documentos_pdf'],

  // Ambos responden 409 "WhatsApp no configurado para este negocio" sin
  // credenciales propias: mandan el archivo POR WhatsApp.
  chat_imagenes: ['whatsapp'],
  chat_documentos_pdf: ['whatsapp'],
});

/**
 * Secciones para la UI. Una lista plana de 19 casillas obliga a leerlas
 * todas; agrupadas se decide por área de trabajo.
 */
export const GRUPOS = Object.freeze([
  { clave: 'esenciales', nombre: 'Esenciales', modulos: ['pos', 'menu', 'usuarios'] },
  { clave: 'operacion', nombre: 'Operación', modulos: ['caja', 'impresion', 'restaurante', 'repartidores'] },
  { clave: 'ventas', nombre: 'Ventas y clientes', modulos: ['rewards', 'pagos', 'facturacion'] },
  { clave: 'automatizacion', nombre: 'Automatización', modulos: ['whatsapp', 'voz', 'asistente_comercial_cotizaciones'] },
  { clave: 'canales', nombre: 'Canales', modulos: ['tienda_online', 'rappi'] },
  { clave: 'avanzado', nombre: 'Avanzado', modulos: ['cotizaciones', 'generador_cotizaciones', 'chat_imagenes', 'chat_documentos_pdf'] },
]);

/**
 * Presets por tipo de negocio. Son ATAJOS, no restricciones: después de
 * aplicarlos el superadmin puede agregar o quitar lo que quiera mientras no
 * rompa una dependencia obligatoria.
 *
 * Deliberadamente cortos: un negocio de servicios no necesita POS de
 * restaurante, y activar todo "por si acaso" es lo que produce negocios mal
 * configurados y facturas infladas.
 */
export const PRESETS = Object.freeze([
  {
    clave: 'restaurante', nombre: 'Restaurante',
    descripcion: 'Mesas, comandas, caja e impresión.',
    modulos: ['pos', 'menu', 'usuarios', 'caja', 'impresion', 'restaurante'],
  },
  {
    clave: 'retail', nombre: 'Retail / mostrador',
    descripcion: 'Venta de mostrador con catálogo y caja.',
    modulos: ['pos', 'menu', 'usuarios', 'caja', 'impresion'],
  },
  {
    clave: 'servicios', nombre: 'Servicios',
    descripcion: 'Atención por WhatsApp y cotizaciones, sin mostrador.',
    modulos: ['usuarios', 'whatsapp', 'cotizaciones', 'generador_cotizaciones', 'chat_documentos_pdf'],
  },
  {
    clave: 'personalizado', nombre: 'Personalizado',
    descripcion: 'Empezar de cero y elegir módulo por módulo.',
    modulos: [],
  },
]);

/** Módulos que dependen de `modulo` (para explicar por qué no se puede quitar). */
export function dependientesDe(modulo, seleccionados) {
  return (seleccionados || []).filter(m => (DEPENDENCIAS[m] || []).includes(modulo));
}

/**
 * Agrega las dependencias que falten, en cascada (una dependencia puede
 * traer las suyas). Devuelve la lista completa y qué se agregó, para poder
 * decírselo al superadmin en vez de activarle módulos en silencio.
 */
export function expandirDependencias(modulos) {
  const pedidos = [...new Set((modulos || []).filter(m => typeof m === 'string'))];
  const completos = new Set(pedidos);
  let cambio = true;
  // Cascada acotada: DEPENDENCIAS no tiene ciclos, pero el bucle termina por
  // punto fijo y no por confiar en eso.
  let vueltas = 0;
  while (cambio && vueltas++ < 10) {
    cambio = false;
    for (const m of [...completos]) {
      for (const dep of (DEPENDENCIAS[m] || [])) {
        if (!completos.has(dep)) { completos.add(dep); cambio = true; }
      }
    }
  }
  const agregados = [...completos].filter(m => !pedidos.includes(m));
  return { modulos: [...completos], agregados };
}

/**
 * Valida una combinación. FAIL CLOSED: devuelve los faltantes con un mensaje
 * entendible en vez de aceptar el alta y dejar que el negocio descubra el
 * hueco operando.
 */
export function validarCombinacion(modulos, { nombresUI = {} } = {}) {
  const seleccion = [...new Set((modulos || []).filter(m => typeof m === 'string'))];
  const faltantes = [];
  for (const m of seleccion) {
    for (const dep of (DEPENDENCIAS[m] || [])) {
      if (!seleccion.includes(dep)) faltantes.push({ modulo: m, requiere: dep });
    }
  }
  if (!faltantes.length) return { ok: true, faltantes: [] };
  const nombre = (c) => nombresUI[c] || c;
  const detalle = faltantes
    .map(f => `${nombre(f.modulo)} necesita ${nombre(f.requiere)}`)
    .join('; ');
  return { ok: false, faltantes, error: `Combinación de módulos inválida: ${detalle}.` };
}

/** Explicación corta para la UI: "requiere POS y Menú". */
export function describirDependencias(modulo, nombresUI = {}) {
  const deps = DEPENDENCIAS[modulo] || [];
  if (!deps.length) return null;
  const nombres = deps.map(d => nombresUI[d] || d);
  const ultimo = nombres.pop();
  return nombres.length ? `requiere ${nombres.join(', ')} y ${ultimo}` : `requiere ${ultimo}`;
}

/**
 * Checklist de puesta en marcha, acotada a lo que el negocio contrató. Sirve
 * para que después del alta se sepa qué falta sin volver a Superadmin ni
 * entrar a la base.
 */
export function checklistOnboarding(modulos) {
  const m = new Set(modulos || []);
  const pasos = [
    { clave: 'negocio', titulo: 'Negocio creado', siempre: true },
    { clave: 'admin', titulo: 'Administrador con contraseña', siempre: true },
  ];
  if (m.has('menu')) pasos.push({ clave: 'menu', titulo: 'Cargar el menú' });
  if (m.has('usuarios')) pasos.push({ clave: 'usuarios', titulo: 'Dar de alta al equipo' });
  if (m.has('whatsapp')) pasos.push({ clave: 'whatsapp', titulo: 'Conectar WhatsApp' });
  if (m.has('pagos')) pasos.push({ clave: 'pagos', titulo: 'Configurar cobros en línea' });
  if (m.has('impresion')) pasos.push({ clave: 'impresion', titulo: 'Instalar Xabor Edge y asignar impresoras' });
  if (m.has('caja')) pasos.push({ clave: 'caja', titulo: 'Registrar el fondo inicial de caja' });
  if (m.has('restaurante')) pasos.push({ clave: 'restaurante', titulo: 'Configurar mesas y meseros' });
  if (m.has('tienda_online')) pasos.push({ clave: 'tienda_online', titulo: 'Publicar la tienda en línea' });
  if (m.has('rappi')) pasos.push({ clave: 'rappi', titulo: 'Vincular la tienda de Rappi y publicar el menú' });
  return pasos;
}
