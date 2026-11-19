// ¿Este proceso es el de producción?
//
// La imagen de Docker fija NODE_ENV=production (ver Dockerfile) y Railway
// inyecta sus propias variables RAILWAY_* en cada servicio. Cualquiera de las
// dos basta: así un arranque en Railway que por error perdiera NODE_ENV sigue
// contando como producción.
//
// Recibe el entorno como argumento para poder probarlo con un objeto propio,
// sin tocar process.env (los chequeos del predeploy corren intercalados).
export function esEntornoProductivo(env = process.env) {
  return env.NODE_ENV === 'production'
    || !!env.RAILWAY_ENVIRONMENT_ID
    || !!env.RAILWAY_PROJECT_ID;
}
