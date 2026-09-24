// Catálogos SAT (CFDI 4.0) que Xabor necesita para capturar datos fiscales:
// c_RegimenFiscal y c_UsoCFDI, con la aplicabilidad oficial por tipo de
// persona (columnas "Física" / "Moral" del propio catálogo del SAT).
//
// ÚNICA fuente de verdad en el backend: facturapi.js re-exporta de aquí y el
// portal público los recibe por API (GET /api/autofactura/<token>), nunca los
// duplica.
//
// Compatibilidad régimen <-> uso: el catálogo c_UsoCFDI del SAT trae, por
// cada uso, la columna "Régimen Fiscal Receptor" con los regímenes que lo
// admiten. Se representa tal cual (uso -> regímenes permitidos) en
// `regimenes` de cada uso; `usoCompatibleConRegimen` la consulta y el portal
// filtra con ella. Facturapi vuelve a validarla al timbrar (fase 4).
export const REGIMENES_SAT = Object.freeze([
  { clave: '601', nombre: 'General de Ley Personas Morales', fisica: false, moral: true },
  { clave: '603', nombre: 'Personas Morales con Fines no Lucrativos', fisica: false, moral: true },
  { clave: '605', nombre: 'Sueldos y Salarios e Ingresos Asimilados a Salarios', fisica: true, moral: false },
  { clave: '606', nombre: 'Arrendamiento', fisica: true, moral: false },
  { clave: '607', nombre: 'Régimen de Enajenación o Adquisición de Bienes', fisica: true, moral: false },
  { clave: '608', nombre: 'Demás ingresos', fisica: true, moral: false },
  { clave: '610', nombre: 'Residentes en el Extranjero sin Establecimiento Permanente en México', fisica: true, moral: true },
  { clave: '611', nombre: 'Ingresos por Dividendos (socios y accionistas)', fisica: true, moral: false },
  { clave: '612', nombre: 'Personas Físicas con Actividades Empresariales y Profesionales', fisica: true, moral: false },
  { clave: '614', nombre: 'Ingresos por intereses', fisica: true, moral: false },
  { clave: '615', nombre: 'Régimen de los ingresos por obtención de premios', fisica: true, moral: false },
  { clave: '616', nombre: 'Sin obligaciones fiscales', fisica: true, moral: false },
  { clave: '620', nombre: 'Sociedades Cooperativas de Producción que optan por diferir sus ingresos', fisica: false, moral: true },
  { clave: '621', nombre: 'Incorporación Fiscal', fisica: true, moral: false },
  { clave: '622', nombre: 'Actividades Agrícolas, Ganaderas, Silvícolas y Pesqueras', fisica: false, moral: true },
  { clave: '623', nombre: 'Opcional para Grupos de Sociedades', fisica: false, moral: true },
  { clave: '624', nombre: 'Coordinados', fisica: false, moral: true },
  { clave: '625', nombre: 'Régimen de las Actividades Empresariales con ingresos a través de Plataformas Tecnológicas', fisica: true, moral: false },
  { clave: '626', nombre: 'Régimen Simplificado de Confianza', fisica: true, moral: true },
]);

// Columna "Régimen Fiscal Receptor" de c_UsoCFDI (CFDI 4.0), por grupo de usos.
const REG_ADQUISICIONES = Object.freeze(['601', '603', '606', '612', '620', '621', '622', '623', '624', '625', '626']);
const REG_GASTOS_GENERAL = Object.freeze(['601', '603', '605', '606', '608', '612', '620', '621', '622', '623', '624', '625', '626']);
const REG_DEDUCCIONES = Object.freeze(['605', '606', '607', '608', '611', '612', '614', '615', '625']);
const REG_SIN_EFECTOS = Object.freeze(['601', '603', '605', '606', '608', '610', '611', '612', '614', '616', '620', '621', '622', '623', '624', '625', '626']);
const REG_NOMINA = Object.freeze(['605']);

export const USOS_CFDI_SAT = Object.freeze([
  { clave: 'G01', nombre: 'Adquisición de mercancías', fisica: true, moral: true, regimenes: REG_ADQUISICIONES },
  { clave: 'G02', nombre: 'Devoluciones, descuentos o bonificaciones', fisica: true, moral: true, regimenes: REG_ADQUISICIONES },
  { clave: 'G03', nombre: 'Gastos en general', fisica: true, moral: true, regimenes: REG_GASTOS_GENERAL },
  { clave: 'I01', nombre: 'Construcciones', fisica: true, moral: true, regimenes: REG_ADQUISICIONES },
  { clave: 'I02', nombre: 'Mobiliario y equipo de oficina por inversiones', fisica: true, moral: true, regimenes: REG_ADQUISICIONES },
  { clave: 'I03', nombre: 'Equipo de transporte', fisica: true, moral: true, regimenes: REG_ADQUISICIONES },
  { clave: 'I04', nombre: 'Equipo de cómputo y accesorios', fisica: true, moral: true, regimenes: REG_ADQUISICIONES },
  { clave: 'I05', nombre: 'Dados, troqueles, moldes, matrices y herramental', fisica: true, moral: true, regimenes: REG_ADQUISICIONES },
  { clave: 'I06', nombre: 'Comunicaciones telefónicas', fisica: true, moral: true, regimenes: REG_ADQUISICIONES },
  { clave: 'I07', nombre: 'Comunicaciones satelitales', fisica: true, moral: true, regimenes: REG_ADQUISICIONES },
  { clave: 'I08', nombre: 'Otra maquinaria y equipo', fisica: true, moral: true, regimenes: REG_ADQUISICIONES },
  { clave: 'D01', nombre: 'Honorarios médicos, dentales y gastos hospitalarios', fisica: true, moral: false, regimenes: REG_DEDUCCIONES },
  { clave: 'D02', nombre: 'Gastos médicos por incapacidad o discapacidad', fisica: true, moral: false, regimenes: REG_DEDUCCIONES },
  { clave: 'D03', nombre: 'Gastos funerales', fisica: true, moral: false, regimenes: REG_DEDUCCIONES },
  { clave: 'D04', nombre: 'Donativos', fisica: true, moral: false, regimenes: REG_DEDUCCIONES },
  { clave: 'D05', nombre: 'Intereses reales efectivamente pagados por créditos hipotecarios (casa habitación)', fisica: true, moral: false, regimenes: REG_DEDUCCIONES },
  { clave: 'D06', nombre: 'Aportaciones voluntarias al SAR', fisica: true, moral: false, regimenes: REG_DEDUCCIONES },
  { clave: 'D07', nombre: 'Primas por seguros de gastos médicos', fisica: true, moral: false, regimenes: REG_DEDUCCIONES },
  { clave: 'D08', nombre: 'Gastos de transportación escolar obligatoria', fisica: true, moral: false, regimenes: REG_DEDUCCIONES },
  { clave: 'D09', nombre: 'Depósitos en cuentas para el ahorro, primas que tengan como base planes de pensiones', fisica: true, moral: false, regimenes: REG_DEDUCCIONES },
  { clave: 'D10', nombre: 'Pagos por servicios educativos (colegiaturas)', fisica: true, moral: false, regimenes: REG_DEDUCCIONES },
  { clave: 'S01', nombre: 'Sin efectos fiscales', fisica: true, moral: true, regimenes: REG_SIN_EFECTOS },
  { clave: 'CP01', nombre: 'Pagos', fisica: true, moral: true, regimenes: REG_SIN_EFECTOS },
  { clave: 'CN01', nombre: 'Nómina', fisica: true, moral: false, regimenes: REG_NOMINA },
]);

/** true si el catálogo SAT admite ese uso de CFDI para ese régimen del receptor. */
export function usoCompatibleConRegimen(usoClave, regimenClave) {
  const uso = buscarUsoCfdi(usoClave);
  const regimen = buscarRegimen(regimenClave);
  return !!(uso && regimen && uso.regimenes.includes(regimen.clave));
}

export function buscarRegimen(clave) {
  const c = String(clave || '').trim();
  return REGIMENES_SAT.find((r) => r.clave === c) || null;
}

export function buscarUsoCfdi(clave) {
  const c = String(clave || '').trim().toUpperCase();
  return USOS_CFDI_SAT.find((u) => u.clave === c) || null;
}

/**
 * Lo que el portal público recibe: clave, nombre, aplicabilidad por persona
 * y, en los usos, los regímenes que los admiten (para filtrar en pantalla;
 * el backend vuelve a validarlo).
 */
export function catalogosPublicos() {
  return {
    regimenes: REGIMENES_SAT.map(({ clave, nombre, fisica, moral }) => ({ clave, nombre, fisica, moral })),
    usos_cfdi: USOS_CFDI_SAT.map(({ clave, nombre, fisica, moral, regimenes }) => ({ clave, nombre, fisica, moral, regimenes: [...regimenes] })),
  };
}
