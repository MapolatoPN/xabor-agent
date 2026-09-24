// Hijo de fase-agente-programados-db.mjs. El padre prepara negocio/carta y
// pide una muerte real en la frontera COMMIT(registrarPedido) -> convertir.
// No hace POST de reparación: el siguiente servidor debe descubrir la fila.
const requerido = (nombre) => {
  const valor = String(process.env[nombre] || '').trim();
  if (!valor) throw new Error(`${nombre} requerido`);
  return valor;
};

const negocioId = requerido('AGP_NEGOCIO_ID');
const producto = requerido('AGP_PRODUCTO_NOMBRE');
const telefono = requerido('AGP_TELEFONO');
const programadoPara = requerido('AGP_PROGRAMADO_PARA');

const { registrarPedido } = await import('../../src/orders/orderManager.js');
const { estadoNuevo } = await import('../../src/mesero-agente/ejecutorDeHerramientas.js');
const { confirmarYEmitir } = await import('../../src/mesero-agente/canalDelAgente.js');

const estado = estadoNuevo({ negocioId, conversacionId: `crash:${telefono}` });
estado.programacionRequerida = true;
estado.carrito.items = [{
  lid: 'agp-crash-linea', nombre: producto, cantidad: 1,
  modificadores: [], notas: '',
}];
estado.carrito.datos = {
  modalidad: 'recoger en tienda', forma_pago: 'efectivo', programado_para: programadoPara,
  cliente: { nombre: 'Cliente Crash AGP', telefono },
};

await confirmarYEmitir({
  negocioId, telefono, nombre: 'Cliente Crash AGP', canal: 'whatsapp', estado,
  pedido: { total: Number(process.env.AGP_PRODUCTO_PRECIO || 105) },
  registrar: registrarPedido,
  emitir: async () => { throw new Error('EMISION_PROHIBIDA_EN_FIXTURE_CRASH'); },
  guardar: async () => {},
  textoDelCiclo: `pedido para ${programadoPara}`,
});

throw new Error('El proceso no murió en la frontera registrar -> convertir');
