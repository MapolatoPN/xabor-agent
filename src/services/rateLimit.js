// ─── Rate limit en memoria (Fase 7) ──────────────────────────────────────────
// Sin dependencia nueva -- mismo criterio que tokensRevocados en session.js
// (Map en memoria, purgado perezoso). Ventana deslizante simple: cuenta
// intentos por clave dentro de los últimos `ventanaMs`; si supera `limite`,
// rechaza. Limitación conocida y aceptada: en memoria del proceso, no
// compartida entre instancias -- suficiente hoy (un solo proceso), igual que
// la revocación de sesiones ya documentada.
const intentos = new Map(); // clave -> [timestamps]

export function permitir(clave, limite, ventanaMs) {
  const ahora = Date.now();
  const lista = (intentos.get(clave) || []).filter(t => ahora - t < ventanaMs);
  if (lista.length >= limite) {
    intentos.set(clave, lista);
    return false;
  }
  lista.push(ahora);
  intentos.set(clave, lista);
  return true;
}

// Middleware Express -- claveFn(req) decide la clave de conteo (IP, token, etc).
export function rateLimitMiddleware(claveFn, limite, ventanaMs, mensaje = 'Demasiados intentos. Espera un momento e inténtalo de nuevo.') {
  return (req, res, next) => {
    const clave = claveFn(req);
    if (!permitir(clave, limite, ventanaMs)) {
      return res.status(429).json({ error: mensaje });
    }
    next();
  };
}
