// ─── Rutas de la cuenta del cliente en la tienda ──────────────────────────
//
// Se montan desde tiendaRutasCore.js, bajo /api/tienda/:slug/cuenta/*. El
// negocio sale SIEMPRE del slug de la URL, y la sesión del cliente solo vale
// para ese negocio (clienteDeRequest la filtra por negocio_id). Ningún
// endpoint acepta un cliente_id ni un negocio_id del navegador: el cliente
// es el de la cookie, y lo que toca es lo que le pertenece.
//
// Todo va detrás de dos puertas: la tienda existe y está publicada
// (resolverTienda), y tiene las cuentas ENCENDIDAS (tienda_config.
// cuentas_clientes). Con cuentas apagadas, estas rutas responden 404,
// indistinguibles de una ruta que no existe.
import { resolverTienda, TiendaError, reglasDelNegocio } from './tiendaOnline.js';
import {
  solicitarCodigo, verificarCodigo, cerrarSesion, clienteDeRequest,
  leerCookieCliente, setCookieCliente, limpiarCookieCliente,
} from './clienteAuth.js';
import {
  clientePublico, actualizarPerfil, listarDirecciones, guardarDireccion, eliminarDireccion,
  marcarPredeterminada, direccionPublica, consentimientosVigentes, registrarConsentimiento,
  rewardsDelCliente, pedidosDelCliente, CANALES_CONSENTIMIENTO,
} from './clientesNegocio.js';

const uuidValido = (v) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(v || ''));

export function registrarRutasCuentasCliente(app, { limitePublico, limiteCheckout, responderError }) {
  async function tiendaConCuentas(req) {
    const tienda = await resolverTienda(req.params.slug);
    if (!tienda.cuentasClientes) throw new TiendaError('No disponible', 'CUENTAS_NO_DISPONIBLES', 404);
    return tienda;
  }

  // Envuelve un handler que exige sesión del cliente EN ESTA tienda.
  const conSesion = (contexto, fn) => async (req, res) => {
    try {
      const tienda = await tiendaConCuentas(req);
      const sesion = await clienteDeRequest(req, tienda.negocioId);
      if (!sesion) return res.status(401).json({ error: 'Inicia sesión para continuar', codigo: 'NO_AUTENTICADO' });
      await fn({ req, res, tienda, cliente: sesion.cliente });
    } catch (e) { responderError(res, e, contexto); }
  };

  // La zona de reparto se valida contra las reglas del negocio, igual que en
  // el checkout: si el negocio tiene zonas, la dirección debe traer una
  // válida (y la colonia hereda el nombre de la zona si viene vacía); si no
  // tiene, la colonia es obligatoria porque el repartidor la necesita.
  async function validarZona(negocioId, datos = {}) {
    const reglas = await reglasDelNegocio(negocioId);
    const zonas = reglas.zonas || [];
    const d = { ...datos };
    if (zonas.length) {
      const z = zonas.find(x => String(x.nombre || '').toLowerCase() === String(d.zona || '').trim().toLowerCase());
      if (!z) throw new TiendaError('Elige tu zona de entrega', 'ZONA_INVALIDA');
      d.zona = z.nombre;
      if (!String(d.colonia || '').trim()) d.colonia = z.nombre;
    } else {
      d.zona = null;
      if (!String(d.colonia || '').trim()) throw new TiendaError('Escribe tu colonia', 'COLONIA_REQUERIDA');
    }
    return d;
  }

  // El resumen que viaja con "Mi cuenta": sin el historial de movimientos,
  // que tiene su propia ruta.
  const resumenRewards = (rw) => { const { movimientos, ...resto } = rw || {}; return resto; };

  // ── Acceso ──
  app.post('/api/tienda/:slug/cuenta/otp', limiteCheckout, async (req, res) => {
    try {
      const tienda = await tiendaConCuentas(req);
      res.json(await solicitarCodigo({
        negocioId: tienda.negocioId, nombreNegocio: tienda.branding.titular,
        telefono: req.body?.telefono, ip: req.ip,
      }));
    } catch (e) { responderError(res, e, 'POST cuenta/otp'); }
  });

  app.post('/api/tienda/:slug/cuenta/otp/verificar', limiteCheckout, async (req, res) => {
    try {
      const tienda = await tiendaConCuentas(req);
      const { telefono, codigo, nombre } = req.body || {};
      const r = await verificarCodigo({
        negocioId: tienda.negocioId, telefono, codigo, nombre, ip: req.ip, userAgent: req.headers['user-agent'],
      });
      setCookieCliente(res, r.token);
      res.json({ ok: true, nuevo: r.nuevo, cliente: clientePublico(r.cliente) });
    } catch (e) { responderError(res, e, 'POST cuenta/otp/verificar'); }
  });

  app.post('/api/tienda/:slug/cuenta/logout', limitePublico, async (req, res) => {
    try {
      await cerrarSesion(leerCookieCliente(req));
      limpiarCookieCliente(res);
      res.json({ ok: true });
    } catch (e) { responderError(res, e, 'POST cuenta/logout'); }
  });

  // ── Mi cuenta ──
  app.get('/api/tienda/:slug/cuenta', limitePublico, conSesion('GET cuenta', async ({ res, tienda, cliente }) => {
    const [direcciones, consentimientos, rewards] = await Promise.all([
      listarDirecciones(tienda.negocioId, cliente.id),
      consentimientosVigentes(tienda.negocioId, cliente.id),
      rewardsDelCliente(tienda.negocioId, cliente),
    ]);
    res.json({
      cliente: clientePublico(cliente),
      direcciones: direcciones.map(direccionPublica),
      consentimientos,
      rewards: resumenRewards(rewards),
    });
  }));

  app.patch('/api/tienda/:slug/cuenta', limitePublico, conSesion('PATCH cuenta', async ({ req, res, tienda, cliente }) => {
    const { nombre, email } = req.body || {};
    const c = await actualizarPerfil(tienda.negocioId, cliente.id, { nombre, email });
    res.json({ ok: true, cliente: clientePublico(c) });
  }));

  app.put('/api/tienda/:slug/cuenta/consentimientos', limitePublico, conSesion('PUT consentimientos', async ({ req, res, tienda, cliente }) => {
    const body = req.body || {};
    const vigentes = await consentimientosVigentes(tienda.negocioId, cliente.id);
    for (const canal of CANALES_CONSENTIMIENTO) {
      // Solo se escribe una fila cuando el cliente CAMBIA algo: la bitácora
      // registra decisiones, no repeticiones.
      if (typeof body[canal] === 'boolean' && body[canal] !== vigentes[canal].otorgado) {
        await registrarConsentimiento(tienda.negocioId, cliente.id, { canal, otorgado: body[canal], fuente: 'mi_cuenta' });
      }
    }
    res.json({ ok: true, consentimientos: await consentimientosVigentes(tienda.negocioId, cliente.id) });
  }));

  // ── Direcciones ──
  app.get('/api/tienda/:slug/cuenta/direcciones', limitePublico, conSesion('GET direcciones', async ({ res, tienda, cliente }) => {
    res.json({ direcciones: (await listarDirecciones(tienda.negocioId, cliente.id)).map(direccionPublica) });
  }));

  app.post('/api/tienda/:slug/cuenta/direcciones', limitePublico, conSesion('POST direccion', async ({ req, res, tienda, cliente }) => {
    const datos = await validarZona(tienda.negocioId, req.body || {});
    const d = await guardarDireccion(tienda.negocioId, cliente.id, datos);
    res.json({ ok: true, direccion: direccionPublica(d) });
  }));

  app.put('/api/tienda/:slug/cuenta/direcciones/:id', limitePublico, conSesion('PUT direccion', async ({ req, res, tienda, cliente }) => {
    if (!uuidValido(req.params.id)) throw new TiendaError('Dirección no encontrada', 'DIRECCION_NO_EXISTE', 404);
    const datos = await validarZona(tienda.negocioId, req.body || {});
    const d = await guardarDireccion(tienda.negocioId, cliente.id, datos, req.params.id);
    res.json({ ok: true, direccion: direccionPublica(d) });
  }));

  app.delete('/api/tienda/:slug/cuenta/direcciones/:id', limitePublico, conSesion('DELETE direccion', async ({ req, res, tienda, cliente }) => {
    if (!uuidValido(req.params.id)) throw new TiendaError('Dirección no encontrada', 'DIRECCION_NO_EXISTE', 404);
    await eliminarDireccion(tienda.negocioId, cliente.id, req.params.id);
    res.json({ ok: true, direcciones: (await listarDirecciones(tienda.negocioId, cliente.id)).map(direccionPublica) });
  }));

  app.post('/api/tienda/:slug/cuenta/direcciones/:id/predeterminada', limitePublico, conSesion('POST predeterminada', async ({ req, res, tienda, cliente }) => {
    if (!uuidValido(req.params.id)) throw new TiendaError('Dirección no encontrada', 'DIRECCION_NO_EXISTE', 404);
    const d = await marcarPredeterminada(tienda.negocioId, cliente.id, req.params.id);
    res.json({ ok: true, direccion: direccionPublica(d) });
  }));

  // ── Rewards y pedidos ──
  app.get('/api/tienda/:slug/cuenta/rewards', limitePublico, conSesion('GET cuenta/rewards', async ({ res, tienda, cliente }) => {
    res.json(await rewardsDelCliente(tienda.negocioId, cliente));
  }));

  app.get('/api/tienda/:slug/cuenta/pedidos', limitePublico, conSesion('GET cuenta/pedidos', async ({ res, tienda, cliente }) => {
    res.json({ pedidos: await pedidosDelCliente(tienda.negocioId, cliente) });
  }));
}
