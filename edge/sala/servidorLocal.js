// EL EDGE ATENDIENDO A LA SALA POR LA RED LOCAL.
//
// Esta es la pieza que convierte el motor offline en algo usable. Sin ella,
// `operacionLocal.js` es una biblioteca que nadie puede llamar: las
// computadoras de meseros y la caja hablan HTTP con la nube, y cuando la nube
// no responde no tienen con quién hablar.
//
// El Edge ya está en la misma red que ellas y ya sobrevive al corte. Aquí
// levanta un servidor HTTP en la LAN con la MISMA forma que `/api/restaurante/*`
// para que el panel solo tenga que cambiar de dirección, no de lógica.
//
// ── Decisiones ─────────────────────────────────────────────────────────────
// · Sin dependencias. `node:http` pelado, igual que el resto del Edge: esa PC
//   no tiene que poder instalar nada.
// · La sesión es por PIN, verificada contra la foto del catálogo con
//   `verifyPin` de `src/services/password.js` -- la MISMA función que la nube.
//   Reimplementar scrypt aquí crearía dos criptografías que pueden divergir.
// · El `pin_hash` NUNCA sale en una respuesta. Entra en el proceso con la foto
//   del catálogo y ahí se queda.
// · Cada mutación persiste ANTES de responder. Si esta PC se apaga justo
//   después de cobrar, ese cobro tiene que estar en disco: responder "ok" sobre
//   algo que solo vive en memoria es mentirle a la cajera.
// · Escucha en la LAN, y eso es deliberado -- si solo escuchara en localhost
//   no serviría a las otras computadoras. La puerta es el PIN.
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyPin } from '../../src/services/password.js';
import { ErrorSala } from './operacionLocal.js';

// El Edge sirve TAMBIÉN el panel, y no es un extra: es lo que hace posible que
// las otras computadoras operen durante un corte.
//
// Una página servida por https no puede hacer `fetch` a http — el navegador lo
// bloquea como contenido mixto y no hay forma de pedirle permiso desde el
// código. La única excepción del estándar es `localhost`. Así que la caja, si
// corre el Edge, llega por localhost; pero las dos PCs de meseros y la de para
// llevar NO pueden alcanzar `http://192.168.x.x:7071` desde `https://xabor.mx`.
//
// Sirviendo el panel desde aquí, esas estaciones lo abren en
// `http://<edge>:7071/` y entonces TODO es del mismo origen: no hay contenido
// mixto que bloquear. Es la diferencia entre que el modo offline funcione en
// una computadora o en las cuatro.
const RAIZ_PANEL = fileURLToPath(new URL('../../panel/', import.meta.url));
const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.ico': 'image/x-icon', '.svg': 'image/svg+xml',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json',
};

export const PUERTO_POR_DEFECTO = 7071;
const SESION_VIGENCIA_MS = 12 * 60 * 60 * 1000;   // un turno largo

// Un error de negocio es 4xx con su código; cualquier otra cosa es 500 y se
// registra. Nunca se le devuelve al cliente el detalle de un fallo interno.
// Quién puede cobrar. En Obispado TODOS los cobros pasan por la caja
// principal: un mesero captura y manda a cocina, pero no cobra ni cierra.
//
// OJO -- esto es MÁS ESTRICTO que la nube hoy: `/api/restaurante/cuentas/:id/pagos`
// solo exige estar autenticado. Se implementa así porque es la operación real
// del local, pero la divergencia hay que cerrarla: que un mesero pueda cobrar
// con enlace y no sin él es exactamente el tipo de diferencia que confunde a
// quien está trabajando. Queda anotado en el informe.
const ROLES_QUE_COBRAN = new Set(['admin', 'cajero', 'caja', 'staff', 'superadmin']);
// Cancelar un item ya capturado sí coincide con la nube: allá la ruta exige
// `requireAdminSeguro`.
const ROLES_QUE_CANCELAN = new Set(['admin', 'superadmin']);

const HTTP_POR_CODIGO = {
  MESA_INVALIDA: 400, PERSONAS_INVALIDAS: 400, MESERO_INVALIDO: 400,
  ITEM_INVALIDO: 400, SIN_ITEMS: 400, METODO_INVALIDO: 400,
  MONTO_INVALIDO: 400, PROPINA_INVALIDA: 400, MOTIVO_REQUERIDO: 400,
  CUENTA_NO_ENCONTRADA: 404, ITEM_NO_CANCELABLE: 404,
  MESA_OCUPADA: 409, CUENTA_NO_ABIERTA: 409,
  SIN_ITEMS_PENDIENTES: 409, SALDO_PENDIENTE: 409,
};

export function crearServidorLocal({
  sala, obtenerCatalogo, alCambiar = () => {}, logger = null,
  puerto = PUERTO_POR_DEFECTO, host = '0.0.0.0', raizPanel = RAIZ_PANEL,
} = {}) {
  if (!sala) throw new Error('crearServidorLocal: hace falta la sala local');
  if (typeof obtenerCatalogo !== 'function') throw new Error('crearServidorLocal: hace falta obtenerCatalogo');

  const sesiones = new Map();   // token -> { meseroId, nombre, rol, expira }

  const log = (evento, datos) => { try { logger?.info?.(evento, datos); } catch { /* el log nunca rompe */ } };

  function sesionDe(req) {
    const cab = req.headers.authorization || '';
    const token = cab.startsWith('Bearer ') ? cab.slice(7) : null;
    if (!token) return null;
    const s = sesiones.get(token);
    if (!s) return null;
    if (s.expira < Date.now()) { sesiones.delete(token); return null; }
    return s;
  }

  // El mensaje dice QUÉ no se puede y con qué rol, para que el mesero sepa a
  // quién llamar en vez de pensar que el sistema se rompió.
  function exigirRol(sesion, permitidos, accion) {
    if (permitidos.has(String(sesion?.rol || '').toLowerCase())) return null;
    return { estado: 403, cuerpo: {
      error: `Tu usuario no puede ${accion}. Pídeselo a la caja.`,
      codigo: 'ROL_NO_AUTORIZADO', rol: sesion?.rol || null,
    } };
  }

  // Se guarda ANTES de contestar. Ver la nota de arriba: un "ok" sobre algo que
  // no está en disco es una promesa que un apagón desmiente.
  async function persistir() {
    try { await alCambiar(sala.serializar()); }
    catch (e) { log('sala.persistencia.fallo', { error: e.message }); throw e; }
  }

  const RUTAS = [
    // Diagnóstico: es lo que el panel consulta para saber si hay un Edge vivo
    // en la red antes de decidir que va a operar sin nube. No pide sesión a
    // propósito -- si exigiera PIN, el panel no podría descubrirlo.
    ['GET', /^\/local\/salud$/, async () => {
      const cat = obtenerCatalogo();
      return { estado: 200, cuerpo: {
        ok: true, modo: 'offline_disponible',
        negocioId: cat?.negocioId || null,
        catalogoAt: cat?.generadoAt || null,
        numMesas: cat?.numMesas ?? null,
        mesasAbiertas: sala.listarMesasOcupadas().length,
        pendientesDeSincronizar: sala.pendientesDeSincronizar(),
      } };
    }],

    ['POST', /^\/local\/sesion$/, async (_m, cuerpo) => {
      const cat = obtenerCatalogo();
      const mesero = (cat?.meseros || []).find((u) => u.id === cuerpo.meseroId);
      // Un mesero inexistente y un PIN equivocado se ven IGUAL desde fuera:
      // decir cuál de los dos falló es decirle a un extraño qué ids existen.
      if (!mesero || !mesero.pin_hash || !verifyPin(String(cuerpo.pin || ''), mesero.pin_hash)) {
        log('sala.sesion.rechazada', {});
        return { estado: 401, cuerpo: { error: 'PIN incorrecto', codigo: 'PIN_INVALIDO' } };
      }
      const token = randomUUID();
      sesiones.set(token, {
        meseroId: mesero.id, nombre: mesero.nombre, rol: mesero.rol,
        expira: Date.now() + SESION_VIGENCIA_MS,
      });
      log('sala.sesion.abierta', { mesero: mesero.nombre });
      return { estado: 200, cuerpo: { token, mesero: { id: mesero.id, nombre: mesero.nombre, rol: mesero.rol } } };
    }],

    // El menú para pintar la pantalla de captura. Sin `pin_hash`: la foto lo
    // tiene, pero no sale de este proceso.
    ['GET', /^\/local\/catalogo$/, async () => {
      const cat = obtenerCatalogo();
      if (!cat) return { estado: 503, cuerpo: { error: 'Sin catálogo local', codigo: 'SIN_CATALOGO' } };
      return { estado: 200, cuerpo: {
        version: cat.version, generadoAt: cat.generadoAt, numMesas: cat.numMesas,
        metodosPago: cat.metodosPago, menu: cat.menu,
        meseros: (cat.meseros || []).map((m) => ({ id: m.id, nombre: m.nombre, rol: m.rol })),
      } };
    }],

    ['GET', /^\/local\/mesas$/, async () => ({
      estado: 200,
      cuerpo: { numMesas: obtenerCatalogo()?.numMesas ?? null, ocupadas: sala.listarMesasOcupadas() },
    }), true],

    ['POST', /^\/local\/mesas\/abrir$/, async (_m, cuerpo, sesion) => {
      const cuenta = sala.abrirMesa({
        mesaNumero: cuerpo.mesa ?? cuerpo.mesaNumero,
        personas: cuerpo.personas,
        meseroUsuarioId: cuerpo.meseroUsuarioId || sesion.meseroId,
        meseroNombre: cuerpo.meseroNombre || sesion.nombre,
        abiertaPor: sesion.meseroId,
      });
      await persistir();
      return { estado: 201, cuerpo: { cuenta } };
    }, true],

    ['GET', /^\/local\/cuentas\/([^/]+)$/, async (m) => {
      const cuenta = sala.obtenerCuenta(m[1]);
      if (!cuenta) return { estado: 404, cuerpo: { error: 'Cuenta no encontrada', codigo: 'CUENTA_NO_ENCONTRADA' } };
      return { estado: 200, cuerpo: { cuenta } };
    }, true],

    ['POST', /^\/local\/cuentas\/([^/]+)\/items$/, async (m, cuerpo, sesion) => {
      const items = (cuerpo.items || []).map((i) => ({ ...i, agregadoPor: sesion.meseroId }));
      const agregados = sala.agregarItems(m[1], items);
      await persistir();
      return { estado: 200, cuerpo: { items: agregados, cuenta: sala.obtenerCuenta(m[1]) } };
    }, true],

    // Devuelve SOLO los items de esta comanda: es el contrato de impresión.
    // Quien reciba esto es quien manda el papel a la estación que toque.
    ['POST', /^\/local\/cuentas\/([^/]+)\/comanda$/, async (m) => {
      const comanda = sala.enviarComanda(m[1]);
      await persistir();
      return { estado: 200, cuerpo: { comanda } };
    }, true],

    ['POST', /^\/local\/cuentas\/([^/]+)\/items\/([^/]+)\/cancelar$/, async (m, cuerpo, sesion) => {
      const veto = exigirRol(sesion, ROLES_QUE_CANCELAN, 'cancelar un producto ya capturado');
      if (veto) return veto;
      const r = sala.cancelarItem(m[1], m[2], { motivo: cuerpo.motivo, usuarioId: sesion.meseroId });
      await persistir();
      return { estado: 200, cuerpo: { item: r, cuenta: sala.obtenerCuenta(m[1]) } };
    }, true],

    ['POST', /^\/local\/cuentas\/([^/]+)\/pagos$/, async (m, cuerpo, sesion) => {
      const veto = exigirRol(sesion, ROLES_QUE_COBRAN, 'cobrar');
      if (veto) return veto;
      const pago = sala.registrarPago(m[1], { ...cuerpo, usuarioId: sesion.meseroId });
      await persistir();
      return { estado: 200, cuerpo: { pago, cuenta: sala.obtenerCuenta(m[1]) } };
    }, true],

    ['POST', /^\/local\/cuentas\/([^/]+)\/cerrar$/, async (m, _cuerpo, sesion) => {
      const veto = exigirRol(sesion, ROLES_QUE_COBRAN, 'cerrar una cuenta');
      if (veto) return veto;
      const r = sala.cerrarCuenta(m[1], { usuarioId: sesion.meseroId });
      await persistir();
      return { estado: 200, cuerpo: r };
    }, true],
  ];

  const servidor = createServer((req, res) => {
    const responder = (estado, cuerpo) => {
      const json = JSON.stringify(cuerpo);
      res.writeHead(estado, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(json),
        // El panel se sirve desde la nube pero, sin enlace, tiene que poder
        // llamar a esta dirección. Sin CORS el navegador lo bloquea.
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      });
      res.end(json);
    };

    if (req.method === 'OPTIONS') return responder(204, {});

    const ruta = (req.url || '').split('?')[0];
    const entrada = RUTAS.find(([metodo, patron]) => metodo === req.method && patron.test(ruta));
    if (!entrada) {
      if (req.method === 'GET' && !ruta.startsWith('/local/')) return servirPanel(ruta, res);
      return responder(404, { error: 'Ruta no encontrada' });
    }
    const [, patron, manejador, exigeSesion] = entrada;

    let sesion = null;
    if (exigeSesion) {
      sesion = sesionDe(req);
      if (!sesion) return responder(401, { error: 'Sesión requerida', codigo: 'SESION_REQUERIDA' });
    }

    let crudo = '';
    req.on('data', (c) => {
      crudo += c;
      // Un cuerpo enorme no puede tumbar la caja del restaurante.
      if (crudo.length > 1_000_000) { req.destroy(); }
    });
    req.on('end', async () => {
      let cuerpo = {};
      if (crudo) {
        try { cuerpo = JSON.parse(crudo); }
        catch { return responder(400, { error: 'JSON inválido' }); }
      }
      try {
        const r = await manejador(patron.exec(ruta), cuerpo, sesion);
        responder(r.estado, r.cuerpo);
      } catch (e) {
        if (e instanceof ErrorSala) {
          return responder(HTTP_POR_CODIGO[e.codigo] || 400, { error: e.message, codigo: e.codigo });
        }
        log('sala.error', { ruta, error: e.message });
        responder(500, { error: 'Error interno del Edge' });
      }
    });
  });

  // Estático mínimo. `normalize` + la comprobación de prefijo son la defensa
  // contra `../../`: esta PC tiene la carpeta de datos del Edge y el token de
  // la terminal, y nadie en la red del local puede pedirle un archivo de
  // fuera del panel.
  async function servirPanel(ruta, res) {
    const rel = ruta === '/' || ruta === '/app' ? 'index.html' : ruta.replace(/^\/+/, '');
    const destino = normalize(join(raizPanel, rel));
    if (!destino.startsWith(normalize(raizPanel))) {
      res.writeHead(403).end('Prohibido');
      return;
    }
    try {
      const info = await stat(destino);
      if (!info.isFile()) throw new Error('no es archivo');
      const cuerpo = await readFile(destino);
      res.writeHead(200, {
        'Content-Type': TIPOS[extname(destino).toLowerCase()] || 'application/octet-stream',
        'Content-Length': cuerpo.length,
        // El panel local no se cachea: si el Edge se actualiza, la estación
        // tiene que ver la versión nueva sin que nadie limpie nada.
        'Cache-Control': 'no-cache',
      });
      res.end(cuerpo);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('No encontrado');
    }
  }

  return {
    async iniciar() {
      await new Promise((resolve, reject) => {
        servidor.once('error', reject);
        servidor.listen(puerto, host, () => { servidor.removeListener('error', reject); resolve(); });
      });
      log('sala.servidor.arriba', { puerto: servidor.address().port, host });
      return servidor.address().port;
    },
    async detener() {
      sesiones.clear();
      await new Promise((resolve) => servidor.close(resolve));
    },
    get puerto() { return servidor.address()?.port ?? null; },
  };
}
