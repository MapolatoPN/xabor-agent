// ─── Lanzador de Xabor Edge ─────────────────────────────────────────────────
//
// Es lo que arranca el servicio de Windows (XaborEdgeService.xml), en lugar
// de edge/index.js. Como actualizador.mjs, lo pone el instalador y una
// actualización automática NUNCA lo cambia: el paquete firmado solo trae la
// carpeta edge/. Así, aunque una versión nueva venga rota, lo que la revierte
// sigue siendo el código que se instaló a mano.
//
// En cada arranque, antes de cargar el Edge:
//
//   1. Si hay una versión verificada esperando en edge.nueva, la aplica:
//      edge → edge.anterior, edge.nueva → edge. La deja «a prueba».
//   2. Una versión a prueba tiene que conectarse con la nube para quedar
//      confirmada. Si se cae al arrancar más de MAX_INTENTOS_PRUEBA veces, o
//      no se confirma en PRUEBA_MS, se regresa a edge.anterior y esa versión
//      queda rechazada en este equipo: no se vuelve a instalar sola.
//   3. Si el Edge ni siquiera se puede cargar (un archivo roto), se revierte
//      en ese mismo momento.
//
// El Edge pide reiniciarse saliendo con CODIGO_ACTUALIZAR. Cualquier salida
// distinta de 0 hace que Windows reinicie el servicio (las mismas reglas de
// recuperación que ya levantan al Edge si se cae), y el reinicio pasa otra
// vez por aquí, que es donde se aplica la versión nueva.
import { existsSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as verificador from './actualizador.mjs';

const { AQUI, leerEstado, escribirEstado } = verificador;

export const CODIGO_ACTUALIZAR = 75;
export const MAX_INTENTOS_PRUEBA = 3;
export const PRUEBA_MS = 10 * 60 * 1000;
export const MAX_FALLOS_APLICAR = 3;

const registrar = (nivel, evento, datos = {}) => {
  const partes = Object.entries(datos).filter(([, v]) => v != null).map(([k, v]) => `${k}=${String(v).slice(0, 200)}`);
  const linea = `${new Date().toISOString()} [${nivel}] ${evento}${partes.length ? ' ' + partes.join(' ') : ''}`;
  (nivel === 'ERROR' ? console.error : nivel === 'WARN' ? console.warn : console.log)(linea);
};

// Un antivirus revisando un archivo recién escrito puede tener la carpeta
// abierta unos milisegundos, y Windows no deja renombrarla mientras tanto.
function renombrar(desde, hacia) {
  let ultimo;
  for (let i = 0; i < 20; i++) {
    try { renameSync(desde, hacia); return; } catch (e) {
      ultimo = e;
      const hasta = Date.now() + 250;
      while (Date.now() < hasta) { /* espera corta, síncrona: todavía no hay Edge */ }
    }
  }
  throw ultimo;
}

const sinRepetir = (lista) => [...new Set(lista)];

// Regresa a edge.anterior. La versión que falló se guarda en
// edge.fallida-<v> para poder revisarla, y queda rechazada.
export function revertir(raiz, motivo) {
  const estado = leerEstado(raiz);
  const v = estado.probando;
  const edge = join(raiz, 'edge'), anterior = join(raiz, 'edge.anterior');
  if (!existsSync(anterior)) {
    registrar('ERROR', 'lanzador.reversion.sin_anterior', { version: v, motivo });
    escribirEstado(raiz, { ...estado, probando: null, intentos: 0, desde: null, vencida: false,
      rechazadas: sinRepetir([...estado.rechazadas, v].filter(Boolean)) });
    return false;
  }
  const fallida = join(raiz, `edge.fallida-${v}`);
  rmSync(fallida, { recursive: true, force: true });
  if (existsSync(edge)) renombrar(edge, fallida);
  renombrar(anterior, edge);
  escribirEstado(raiz, {
    ...estado, probando: null, intentos: 0, desde: null, vencida: false,
    rechazadas: sinRepetir([...estado.rechazadas, v].filter(Boolean)),
    ultimaReversion: { version: v, motivo, en: new Date().toISOString() },
  });
  registrar('WARN', 'lanzador.revertida', { version: v, motivo });
  return true;
}

// Decide qué versión arranca. Nunca lanza: si algo sale mal aquí, se arranca
// lo que haya en edge/, que es lo mismo que pasaba antes de existir esto.
export function prepararArranque(raiz, { ahora = Date.now() } = {}) {
  const edge = join(raiz, 'edge'), nueva = join(raiz, 'edge.nueva'), anterior = join(raiz, 'edge.anterior');
  try {
    // Un corte de luz entre dos renombres puede dejar sin edge/. Lo que
    // estaba antes sigue en edge.anterior.
    if (!existsSync(edge) && existsSync(anterior)) {
      renombrar(anterior, edge);
      registrar('WARN', 'lanzador.rescate', { motivo: 'faltaba edge/: se recuperó edge.anterior' });
    }

    let estado = leerEstado(raiz);

    if (estado.probando) {
      const intentos = (Number(estado.intentos) || 0) + 1;
      if (estado.vencida) {
        revertir(raiz, 'no se conectó con la nube a tiempo');
        return { accion: 'revertida' };
      }
      if (intentos > MAX_INTENTOS_PRUEBA) {
        revertir(raiz, `se cayó ${MAX_INTENTOS_PRUEBA} veces al arrancar`);
        return { accion: 'revertida' };
      }
      escribirEstado(raiz, { ...estado, intentos });
      registrar('INFO', 'lanzador.a_prueba', { version: estado.probando, intento: intentos });
      return { accion: 'a_prueba', probando: estado.probando, desde: estado.desde ?? ahora };
    }

    if (estado.pendiente) {
      const v = estado.pendiente;
      let enNueva = null;
      try { enNueva = readFileSync(join(nueva, '.version'), 'utf8').trim(); } catch {}
      if (enNueva !== v) {
        escribirEstado(raiz, { ...estado, pendiente: null });
        registrar('WARN', 'lanzador.pendiente.descartada', { version: v, motivo: 'edge.nueva no trae esa versión' });
        return { accion: 'normal' };
      }
      try {
        rmSync(anterior, { recursive: true, force: true });
        renombrar(edge, anterior);
        try { renombrar(nueva, edge); }
        catch (e) { renombrar(anterior, edge); throw e; }
      } catch (e) {
        const fallos = (Number(estado.fallosAplicar) || 0) + 1;
        const rechazar = fallos >= MAX_FALLOS_APLICAR;
        estado = leerEstado(raiz);
        escribirEstado(raiz, {
          ...estado,
          pendiente: rechazar ? null : v,
          fallosAplicar: rechazar ? 0 : fallos,
          rechazadas: rechazar ? sinRepetir([...estado.rechazadas, v]) : estado.rechazadas,
        });
        registrar('ERROR', 'lanzador.aplicar.fallo', { version: v, intento: fallos, error: e.message });
        return { accion: 'normal' };
      }
      escribirEstado(raiz, { ...estado, pendiente: null, fallosAplicar: 0, probando: v, intentos: 1, desde: ahora, vencida: false });
      registrar('INFO', 'lanzador.aplicada', { version: v });
      return { accion: 'aplicada', probando: v, desde: ahora };
    }
  } catch (e) {
    registrar('ERROR', 'lanzador.preparacion.fallo', { error: e.message });
  }
  return { accion: 'normal' };
}

// Carga el Edge y lo arranca. Devuelve el módulo cargado (para pruebas).
export async function lanzar({ raiz = AQUI, pruebaMs = PRUEBA_MS, salir = (c) => process.exit(c) } = {}) {
  const arranque = prepararArranque(raiz);
  const probando = arranque.probando ?? null;

  let modulo;
  try {
    modulo = await import(pathToFileURL(join(raiz, 'edge', 'index.js')).href);
    if (typeof modulo.arrancarProceso !== 'function') throw new Error('edge/index.js no exporta arrancarProceso');
  } catch (e) {
    registrar('ERROR', 'lanzador.carga.fallo', { version: probando, error: e.message });
    if (probando) {
      try { revertir(raiz, `no se pudo cargar: ${e.message}`); }
      catch (e2) { registrar('ERROR', 'lanzador.reversion.fallo', { error: e2.message }); }
    }
    return salir(1);
  }

  // En cada arranque, la versión a prueba tiene PRUEBA_MS para conectarse
  // con la nube. Si no, se marca vencida y se sale con error: Windows
  // reinicia el servicio y prepararArranque la revierte. No se renombra nada
  // con el Edge corriendo. El plazo se cuenta desde ESTE arranque, no desde
  // que se aplicó: una PC que se apagó justo después de actualizarse no
  // puede amanecer con la versión nueva vencida.
  if (probando) {
    const vigia = setTimeout(() => {
      const estado = leerEstado(raiz);
      if (estado.probando !== probando) return;
      escribirEstado(raiz, { ...estado, vencida: true });
      registrar('ERROR', 'lanzador.prueba.vencida', { version: probando });
      salir(1);
    }, pruebaMs);
    vigia.unref?.();
  }

  await modulo.arrancarProceso({ actualizacion: { raiz, verificador } });
  return modulo;
}

const esEjecucionDirecta = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (esEjecucionDirecta) {
  lanzar().catch((e) => {
    registrar('ERROR', 'lanzador.fallo', { error: e?.message || String(e) });
    process.exit(1);
  });
}
