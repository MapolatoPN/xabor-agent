// Pantalla DIRECCION de los formularios de pedido (contrato direccion_v1).
// Artefacto local: no crea, publica ni activa nada en Meta.
// Límites de Meta (Flow JSON 7.x): label ≤ 20, helper-text ≤ 80, título de
// opción ≤ 30, metadata ≤ 20; TextInput usa max-chars y TextArea max-length.
import { LIMITES_DIRECCION } from '../src/mesero-agente/direccionFormulario.js';
const dato = (k) => '${data.' + k + '}', campo = (k) => '${form.' + k + '}';
const str = (v = '') => ({ type: 'string', __example__: v }), bool = (v) => ({ type: 'boolean', __example__: v });
const opciones = { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, title: { type: 'string' },
  description: { type: 'string' }, metadata: { type: 'string' } } },
__example__: [{ id: 'zn', title: 'En la ciudad', description: 'Ninguna de las zonas de la lista', metadata: 'Envío $60' }] };

export function pantallaDireccion() {
  return {
    id: 'DIRECCION', title: 'Dirección de entrega', terminal: true, refresh_on_back: true,
    data: { revision: str('0'), resumen: str('Tu pedido'), error: str(), error_visible: bool(false),
      hay_zonas: bool(true), zonas: opciones, zona_inicial: str('zn'), calle_inicial: str(), colonia_inicial: str(),
      referencias_inicial: str() },
    layout: { type: 'SingleColumnLayout', children: [{ type: 'Form', name: 'form',
      'init-values': { zona: dato('zona_inicial'), calle: dato('calle_inicial'), colonia: dato('colonia_inicial'),
        referencias: dato('referencias_inicial') },
      children: [
        { type: 'TextSubheading', text: dato('resumen') },
        { type: 'TextBody', text: dato('error'), visible: dato('error_visible') },
        { type: 'Dropdown', name: 'zona', label: 'Zona de entrega', required: dato('hay_zonas'), visible: dato('hay_zonas'),
          'data-source': dato('zonas') },
        { type: 'TextInput', name: 'calle', label: 'Calle y número', 'input-type': 'text', required: true,
          'min-chars': 3, 'max-chars': LIMITES_DIRECCION.calle, 'helper-text': 'En planta o escuela: edificio o puerta.' },
        { type: 'TextInput', name: 'colonia', label: 'Colonia', 'input-type': 'text', required: false,
          'max-chars': LIMITES_DIRECCION.colonia },
        { type: 'TextArea', name: 'referencias', label: 'Referencias', required: false,
          'max-length': LIMITES_DIRECCION.referencias, 'helper-text': 'Ej. casa blanca, portón negro.' },
        { type: 'TextCaption', text: 'Esto prepara el resumen. No confirma ni cobra tu pedido.' },
        { type: 'Footer', label: 'Revisar pedido', 'on-click-action': { name: 'data_exchange', payload: {
          revision: dato('revision'), operacion: 'direccion', zona: campo('zona'), calle: campo('calle'),
          colonia: campo('colonia'), referencias: campo('referencias') } } },
      ] }] },
  };
}
