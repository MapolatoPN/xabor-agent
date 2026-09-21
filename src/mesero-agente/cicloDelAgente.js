// La fila de conversacion_estado sigue identificada por teléfono, pero cada
// pedido nuevo usa otra identidad en el libro de operaciones. Así la
// confirmación de ayer no bloquea un pedido legítimo de hoy.
import { estadoNuevo } from './ejecutorDeHerramientas.js';

const normalizar = (s) => String(s || '').toLowerCase().normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();

const pideNuevoPedido = (mensaje) => {
  const t = normalizar(mensaje);
  return /\b(?:nuevo|otro|otra)\s+(?:pedido|orden)\b/.test(t)
    || /\b(?:quiero|quisiera|voy a)\s+(?:hacer\s+)?(?:un\s+)?(?:pedido|orden|pedir|ordenar)\b/.test(t);
};

export function cicloParaTurno(estado, mensaje) {
  // Una confirmación sin resultado conocido requiere conciliación humana.
  // No se puede abrir otro ciclo solo porque el cliente vuelva a pedir.
  if (estado?.confirmacionIncierta) return estado;
  const hechos = estado?.hechos || {};
  const terminado = hechos.confirmado || hechos.cancelado || hechos.escalado || hechos.fallido;
  if (!terminado || !pideNuevoPedido(mensaje)) return estado;

  const ciclo = Number(estado.ciclo || 0) + 1;
  const base = String(estado.conversacionId || '').replace(/:c\d+$/, '');
  const nuevo = estadoNuevo({ negocioId: estado.negocioId, conversacionId: `${base}:c${ciclo}` });
  nuevo.ciclo = ciclo;
  return nuevo;
}
