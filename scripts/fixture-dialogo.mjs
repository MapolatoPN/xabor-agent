// Transporte simulado EXPLÍCITO para fixtures que empiezan después del resumen.
// No forma parte del servidor ni evita la autorización de las herramientas.
import { guardarDialogo, acusarDialogo } from '../src/mesero-agente/contratoConversacional.js';
export function resumenEnviadoParaPrueba(estado, pedido) {
  const texto = JSON.stringify(pedido.resumen);
  const id = guardarDialogo(estado, { mensaje: 'Revisar pedido', texto, tipo: 'resumen', huella: pedido.huella });
  acusarDialogo(estado, id, texto);
}
