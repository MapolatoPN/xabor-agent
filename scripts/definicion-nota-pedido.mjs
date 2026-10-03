// «Nota del pedido» en la pantalla ENTREGA («Entrega y pago») de los
// formularios con dirección (contrato nota_v1, src/mesero-agente/notaDelPedido.js).
// Artefacto local: no crea, publica ni activa nada en Meta.
// Límites de Meta (Flow JSON 7.x): label ≤ 20 y helper-text ≤ 80; TextArea usa
// max-length (ver definicion-pantalla-direccion.mjs).
import { LIMITE_NOTA_PEDIDO } from '../src/mesero-agente/notaDelPedido.js';
const dato = (k) => '${data.' + k + '}', campo = (k) => '${form.' + k + '}';

/** La misma pantalla ENTREGA, con la nota opcional antes del aviso y en el payload de «Revisar pedido». */
export function entregaConNota(entrega) {
  const p = structuredClone(entrega), form = p.layout.children[0];
  p.data.nota_inicial = { type: 'string', __example__: '' };
  form['init-values'].nota = dato('nota_inicial');
  const aviso = form.children.findIndex((c) => c.type === 'TextCaption');
  form.children.splice(aviso, 0, { type: 'TextArea', name: 'nota', label: 'Nota del pedido', required: false,
    'max-length': LIMITE_NOTA_PEDIDO, 'helper-text': 'Dedicatoria o indicaciones. Sale en la comanda.' });
  form.children.find((c) => c.type === 'Footer')['on-click-action'].payload.nota = campo('nota');
  return p;
}
