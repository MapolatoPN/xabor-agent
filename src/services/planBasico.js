// Única configuración comercial para nuevas altas. Los contratos guardan su precio.
export function precioBasicoMxn(env = process.env) {
  const texto = env.XABOR_BASICO_MENSUALIDAD_MXN ?? '150';
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(String(texto)) || Number(texto) <= 0) {
    throw new Error('XABOR_BASICO_MENSUALIDAD_MXN inválida');
  }
  return Number(texto);
}
export function diasGraciaBasico(env = process.env) {
  // No se promete gracia comercial hasta configurar su duración explícitamente.
  const valor = env.XABOR_BASICO_GRACIA_DIAS ?? '0';
  if (!/^\d{1,2}$/.test(String(valor)) || Number(valor) > 30) {
    throw new Error('XABOR_BASICO_GRACIA_DIAS inválida');
  }
  return Number(valor);
}
export const MODULOS_PLAN_BASICO = Object.freeze(['pos','menu','restaurante']);
