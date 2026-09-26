import { randomUUID } from 'node:crypto';
import { esConfirmacionVerbal } from '../agent/confirmacionVerbal.js';
import { mismaPalabraFlexible } from '../agent/mencionesComerciales.js';
import { respuestaDesdePedido } from './recuperacionDelTurno.js';

const normalizar = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

export function autorizaConfirmacion({ estado, mensaje, huella }) {
  const d = estado.dialogo;
  return !/[¿?]/.test(String(mensaje)) && esConfirmacionVerbal(mensaje) && d?.enviado === true
    && d.tipo === 'resumen' && d.huella === huella && d.ciclo === estado.conversacionId;
}

export function autorizaCancelacion(mensaje) {
  if (/[¿?]/.test(String(mensaje))) return false;
  const t = normalizar(mensaje).replace(/^(?:por favor|porfa) /, '').replace(/ (?:por favor|porfa|gracias)$/, '');
  return /^(?:cancela|cancelame|cancelen|cancelar|quiero cancelar|quisiera cancelar|necesito cancelar|mejor cancela)(?: (?:todo|todo el pedido|todo mi pedido|el pedido|mi pedido|la orden|mi orden))?$/.test(t)
    || /^(?:ya no quiero|no quiero) (?:el pedido|mi pedido|la orden|mi orden)$/.test(t);
}

// Solo una respuesta compuesta ENTERAMENTE por opciones conocidas permite
// omitir interpretación. Todo residuo («y agrega…», dirección, etc.) continúa.
export function soloElecciones(mensaje, acciones, candidatos = []) {
  let resto = ` ${normalizar(mensaje)} `;
  const nombres = [...new Set(acciones.flatMap(a => a.argumentos?.opciones || []).map(o => normalizar(o.opcion)))];
  for (const nombre of nombres.sort((a,b) => b.length-a.length)) resto = resto.split(` ${nombre} `).join(' ');
  const raiz = s => s.replace(/(?:os|as|es|o|a|s)$/, '');
  const grupos = acciones.flatMap(a => a.argumentos?.opciones || []).map(o => normalizar(o.grupo));
  const palabras = [...nombres, ...grupos, ...candidatos.map(normalizar)].flatMap(s => s.split(' '));
  const vocabulario = new Set(palabras.map(raiz));
  const cortesia = new Set('y con por favor porfa gracias quiero quisiera seria serian mejor los las el la de del un una sin'.split(' '));
  return (nombres.length > 0 || candidatos.length > 0) && resto.trim().split(/\s+/).filter(Boolean)
    .every(p => cortesia.has(p) || vocabulario.has(raiz(p)) || palabras.some(v => mismaPalabraFlexible(p, v)));
}

export function guardarDialogo(estado, { mensaje, texto, tipo = 'pregunta', huella = null }) {
  estado.dialogo = { id: randomUUID(), ciclo: estado.conversacionId, mensaje, texto,
    tipo, huella, foco: estado.foco || null, enviado: false };
  return estado.dialogo.id;
}

// El canal llama esto únicamente después del acuse del transporte. También
// se usa en evaluaciones con un transporte simulado explícito.
export function acusarDialogo(estado, id, texto) {
  if (estado.dialogo?.id !== id || estado.dialogo.texto !== texto) return false;
  if (estado.dialogo.enviado) return true;
  estado.dialogo.enviado = true;
  estado.historialDialogo = [...(estado.historialDialogo || []),
    { rol: 'user', texto: estado.dialogo.mensaje }, { rol: 'assistant', texto }].slice(-20);
  return true;
}

export function respuestaCanonica(contexto) {
  const { pedido } = contexto;
  const texto = respuestaDesdePedido(contexto);
  return { texto, tipo: texto.endsWith('¿Confirmas este pedido?') ? 'resumen' : 'pregunta',
    huella: texto.endsWith('¿Confirmas este pedido?') ? pedido.huella : null };
}
