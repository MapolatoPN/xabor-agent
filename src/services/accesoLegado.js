// Acceso del panel con la contraseña global (PANEL_PASSWORD / ADMIN_PASSWORD).
//
// Es el mecanismo anterior al inicio de sesión por correo: una sola contraseña
// para toda la instalación, sin usuario y sin negocio. El panel ya entra por
// /login con correo y contraseña (sesión firmada + membresía), así que en
// producción este acceso queda APAGADO: POST /api/auth/login responde 410 y
// los tokens que emitía dejan de valer en todas las rutas.
//
// Sigue encendido fuera de producción, porque algunas suites lo usan.
//
// Palanca de reversa sin tocar código (variable en Railway):
//   XABOR_ACCESO_LEGADO=permitir  → lo vuelve a encender en producción.
//   XABOR_ACCESO_LEGADO=bloquear  → lo apaga también en local (para probar).
import { esEntornoProductivo } from './entornoProductivo.js';

export function accesoLegadoPermitido(env = process.env) {
  const valor = String(env.XABOR_ACCESO_LEGADO || '').trim().toLowerCase();
  if (valor === 'permitir') return true;
  if (valor === 'bloquear') return false;
  return !esEntornoProductivo(env);
}

export const CODIGO_ACCESO_LEGADO_APAGADO = 'ACCESO_LEGADO_DESACTIVADO';
export const MENSAJE_ACCESO_LEGADO_APAGADO =
  'Este acceso ya no está disponible: entra en /login con tu correo y contraseña';
