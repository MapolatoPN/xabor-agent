// Capacidad local, no serializable. Solo el adaptador determinista la crea
// después de validar la asociación persistida o una elección textual exacta.
const capacidades = new WeakMap();
export function accionInteractiva(herramienta, argumentos, estado) {
  const autorizacion = {};
  capacidades.set(autorizacion, {estado,ciclo:estado.conversacionId,comando:JSON.stringify([herramienta, argumentos])});
  return { herramienta, argumentos, autorizacion, motivo: 'eleccion_estructurada_validada' };
}
export function esAccionInteractiva(autorizacion, herramienta, argumentos, estado) {
  const c=capacidades.get(autorizacion);
  return !!c && c.estado === estado && c.ciclo === estado.conversacionId && c.comando === JSON.stringify([herramienta, argumentos]);
}
