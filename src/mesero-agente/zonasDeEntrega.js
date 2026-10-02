// Zonas de envío del negocio (reglas_atencion.pedidos.zonas_entrega): una sola
// regla de coincidencia para el ejecutor, el formulario de dirección y su
// endpoint. Si cada uno decidiera distinto qué zona menciona un texto, la
// tarifa que ve el cliente y la que se cobra podrían no ser la misma.
const norm = (s) => String(s || '')
  .toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9ñ ]/g, ' ').replace(/\s+/g, ' ').trim();

const nombresDeZona = (z) => [z?.nombre, ...String(z?.nombre || '').split('/')].map(norm).filter(Boolean);

/** Una zona con nombre y costo usable (finito, no negativo). */
export const zonaUsable = (z) => nombresDeZona(z).length > 0
  && z.costo != null && z.costo !== '' && Number.isFinite(Number(z.costo)) && Number(z.costo) >= 0;

/**
 * Las zonas configuradas que se pueden ofrecer y cobrar, con su costo como
 * número. Un nombre repetido (igual al normalizar) se ofrece una sola vez: el
 * ejecutor cobra la PRIMERA zona con ese nombre, y ofrecer la segunda mostraría
 * una tarifa que no se cobra.
 */
export function zonasDelNegocio(reglas) {
  const vistos = new Set();
  return (Array.isArray(reglas?.pedidos?.zonas_entrega) ? reglas.pedidos.zonas_entrega : [])
    .filter((z) => zonaUsable(z) && !vistos.has(norm(z.nombre)) && vistos.add(norm(z.nombre)))
    .map((z) => ({ nombre: String(z.nombre), costo: Number(z.costo) }));
}

/** Las zonas que un texto nombra (con alias separados por «/»). */
export function zonasEnDireccion(reglas, direccion) {
  const destino = norm(direccion);
  if (!destino) return [];
  return (Array.isArray(reglas?.pedidos?.zonas_entrega) ? reglas.pedidos.zonas_entrega : [])
    .filter(z => zonaUsable(z)
      // La normalización solo contiene letras/dígitos/espacios. Límites de
      // palabra evitan UTNCita; espacios opcionales aceptan Coca-Cola/Cocacola.
      && nombresDeZona(z).some(nombre => new RegExp(`(?:^| )${nombre.split(' ').join(' *')}(?: |$)`).test(destino)));
}
