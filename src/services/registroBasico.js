// Alta pública verificable de negocios de alimentos. Aislada del alta de
// Superadmin: no utiliza privilegios de plataforma ni crea invitaciones.
// Deshabilitada por defecto en HTTP (ver registroBasicoRutas.js).
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { pool, listarModulosDisponibles } from './database.js';
import { hashPassword } from './password.js';
import { enviarCorreoVerificacionBasico, correoVerificacionBasicoDisponible } from './email.js';
import { ErrorRegistroBasico, validarRegistroBasico,correoRegistroBasicoPermitido } from './registroBasicoValidacion.js';
import { precioBasicoMxn, MODULOS_PLAN_BASICO } from './planBasico.js';
export { ErrorRegistroBasico, validarRegistroBasico } from './registroBasicoValidacion.js';

export const MODULOS_BASICO = MODULOS_PLAN_BASICO;
const DURACION_TOKEN_MIN = 30;
const PRIVACIDAD_SHA256=createHash('sha256').update(readFileSync(new URL('../../public/landing/aviso-privacidad.html',import.meta.url))).digest('hex');

export const hashTokenRegistro = token => createHash('sha256').update(token).digest('hex');

function slugBasico(nombre) {
  const base = nombre.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 38) || 'alimentos';
  return `${base}-${randomBytes(6).toString('hex')}`;
}

const respuestaSolicitud = () => ({
  ok: true,
  mensaje: 'Si el correo puede registrarse, recibirás un enlace para verificarlo.',
});

// El primer paso NO crea un negocio ni una cuenta con acceso.
// El correo es el único canal para demostrar control del buzón.
export async function solicitarRegistroBasico(body, { enviarCorreo = enviarCorreoVerificacionBasico } = {}) {
  const datos = validarRegistroBasico(body);
  if(!correoRegistroBasicoPermitido(datos.email))return respuestaSolicitud();
  if (!correoVerificacionBasicoDisponible()) {
    throw new ErrorRegistroBasico('CORREO_NO_DISPONIBLE', 'El registro está temporalmente fuera de servicio', 503);
  }
  const passwordHash = hashPassword(datos.password);
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashTokenRegistro(token);
  // No vinculamos silenciosamente cuentas existentes a otra empresa.
  const existente = await pool.query('SELECT 1 FROM usuarios WHERE lower(email) = $1', [datos.email]);
  if (existente.rows.length) return respuestaSolicitud();
  await pool.query(
    `INSERT INTO solicitudes_registro_basico
       (email, token_hash, password_hash, nombre_propietario, nombre_negocio, telefono, ciudad, expires_at,privacidad_aceptada_at,privacidad_sha256)
     VALUES ($1,$2,$3,$4,$5,$6,$7,NOW() + INTERVAL '30 minutes',NOW(),$8)
     ON CONFLICT (email) DO UPDATE SET
       token_hash = EXCLUDED.token_hash, password_hash = EXCLUDED.password_hash,
       nombre_propietario = EXCLUDED.nombre_propietario, nombre_negocio = EXCLUDED.nombre_negocio,
       telefono = EXCLUDED.telefono, ciudad = EXCLUDED.ciudad,
       expires_at = EXCLUDED.expires_at, created_at = NOW(), used_at = NULL, negocio_id = NULL,
       privacidad_aceptada_at=NOW(),privacidad_sha256=EXCLUDED.privacidad_sha256`,
    [datos.email, tokenHash, passwordHash, datos.nombrePropietario, datos.nombreNegocio, datos.telefono, datos.ciudad,PRIVACIDAD_SHA256]);
  const publicUrl = (process.env.PUBLIC_URL || 'https://xabor.mx').replace(/\/$/, '');
  // No se devuelve el token en respuesta ni se imprime en logs.
  const resultado = await enviarCorreo({
    to: datos.email, nombre: datos.nombrePropietario, negocioNombre: datos.nombreNegocio,
    enlace: `${publicUrl}/activar-basico?token=${token}`, minutos: DURACION_TOKEN_MIN,
  });
  if (!resultado?.enviado) {
    // Si el correo no salió, revocar solo NUESTRO token; nunca uno más reciente.
    await pool.query('DELETE FROM solicitudes_registro_basico WHERE email = $1 AND token_hash = $2 AND used_at IS NULL',
      [datos.email, tokenHash]);
    throw new ErrorRegistroBasico('CORREO_NO_ENVIADO', 'No pudimos enviar el enlace. Intenta más tarde.', 503);
  }
  return respuestaSolicitud();
}

// La confirmación valida un token de un solo uso, con bloqueo de fila.
// Todas las inserciones de negocio/usuario/módulos se ejecutan en una
// misma transacción: no hay negocio huérfano si algo falla.
export async function confirmarRegistroBasico(token) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    throw new ErrorRegistroBasico('ENLACE_INVALIDO', 'El enlace no es válido o ya venció', 410);
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: [solicitud] } = await client.query(
      `SELECT * FROM solicitudes_registro_basico
        WHERE token_hash = $1 FOR UPDATE`, [hashTokenRegistro(token)]);
    if (!solicitud || solicitud.used_at || Date.parse(solicitud.expires_at) <= Date.now()||!correoRegistroBasicoPermitido(solicitud.email)) {
      throw new ErrorRegistroBasico('ENLACE_INVALIDO', 'El enlace no es válido o ya venció', 410);
    }
    const { rows: usuarios } = await client.query('SELECT 1 FROM usuarios WHERE lower(email) = $1', [solicitud.email]);
    if (usuarios.length) {
      throw new ErrorRegistroBasico('CUENTA_EXISTENTE', 'Este correo ya tiene una cuenta. Inicia sesión.', 409);
    }
    const { rows: [negocio] } = await client.query(
      `INSERT INTO negocios (nombre, slug, activo, estado, plan, checklist)
       VALUES ($1,$2,TRUE,'activo','prueba',$3::jsonb)
       RETURNING id,nombre,slug`,
      [solicitud.nombre_negocio, slugBasico(solicitud.nombre_negocio),
       JSON.stringify({negocio_creado:true,administrador_creado:true,sucursal_creada:true,
         datos_generales_completos:false,menu_cargado:false,usuarios_creados:false,
         terminal_creada:false,impresion_probada:false,whatsapp_configurado:false,
         rappi_configurado:false,pedido_prueba:false,listo_para_operar:false})]);
    await client.query('INSERT INTO sucursales (negocio_id, nombre) VALUES ($1,$2)',
      [negocio.id, 'Sucursal principal']);
    const { rows: [usuario] } = await client.query(
      `INSERT INTO usuarios (negocio_id,nombre,email,password_hash)
       VALUES ($1,$2,$3,$4) RETURNING id`,
      [negocio.id, solicitud.nombre_propietario, solicitud.email, solicitud.password_hash]);
    await client.query(
      `INSERT INTO usuario_negocios (usuario_id,negocio_id,rol,activo) VALUES ($1,$2,'admin',TRUE)`,
      [usuario.id, negocio.id]);
    for (const [clave, valor] of [
      ['nombre', negocio.nombre], ['nombre_corto', negocio.nombre.slice(0,20)],
      ['ciudad', solicitud.ciudad], ['telefono', solicitud.telefono],
    ]) {
      await client.query('INSERT INTO configuracion (negocio_id,clave,valor) VALUES ($1,$2,$3)',
        [negocio.id, clave, valor]);
    }
    const disponibles = listarModulosDisponibles().map(m => m.clave);
    for (const modulo of MODULOS_BASICO) {
      if (!disponibles.includes(modulo)) {
        throw new ErrorRegistroBasico('MODULO_INVALIDO', 'No se pudo preparar el negocio', 503);
      }
    }
    for (const modulo of disponibles) {
      await client.query('INSERT INTO negocio_modulos (negocio_id,modulo,estado) VALUES ($1,$2,$3)',
        [negocio.id, modulo, MODULOS_BASICO.includes(modulo) ? 'activo' : 'no_configurado']);
    }
    for (const [tipo, habilitado, orden] of [
      ['efectivo',true,0], ['terminal',true,1], ['enlace_pago',false,2], ['transferencia',false,3],
    ]) {
      await client.query(
        'INSERT INTO metodos_pago (negocio_id,tipo,habilitado,orden) VALUES ($1,$2,$3,$4)',
        [negocio.id,tipo,habilitado,orden]);
    }
    // Precio fijado al contratar: cambiar la configuración no altera clientes existentes.
    await client.query(
      `INSERT INTO negocio_plan_comercial
       (negocio_id,plan,mensualidad,costo_instalacion,instalacion_pagada,fecha_inicio,proxima_fecha_pago,estado,notas)
       VALUES ($1,'basico',$2,0,TRUE,CURRENT_DATE,CURRENT_DATE + INTERVAL '7 days','prueba',
         'Alta autoservicio verificada. Prueba de siete días; acceso sujeto a facturación SaaS.')`,
      [negocio.id, precioBasicoMxn()]);
    await client.query(
      `UPDATE solicitudes_registro_basico SET used_at = NOW(), negocio_id = $2,
        password_hash = '[consumido]' WHERE id = $1`, [solicitud.id, negocio.id]);
    await client.query('COMMIT');
    return { ok:true, negocio:{ nombre:negocio.nombre, slug:negocio.slug }, login:'/login' };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    if (e.code === '23505') {
      throw new ErrorRegistroBasico('REGISTRO_CONFLICTO', 'No se pudo completar el registro. Solicita un enlace nuevo.', 409);
    }
    throw e;
  } finally { client.release(); }
}
