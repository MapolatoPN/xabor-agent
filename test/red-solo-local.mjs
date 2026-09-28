// Preload heredado por los servidores hijos. Nunca usa credenciales reales.
import net from 'node:net';
const local = h => ['localhost', '127.0.0.1', '::1'].includes(String(h));
const conectar = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const [opciones] = net._normalizeArgs(args);
  if (opciones.path || !local(opciones.host || 'localhost')) throw Error('RED_EXTERNA_BLOQUEADA');
  return conectar.apply(this, args);
};
const solicitar = globalThis.fetch;
globalThis.fetch = (url, ...args) => {
  if (!local(new URL(typeof url === 'object' && 'url' in url ? url.url : url).hostname)) throw Error('RED_EXTERNA_BLOQUEADA');
  return solicitar(url, ...args);
};
