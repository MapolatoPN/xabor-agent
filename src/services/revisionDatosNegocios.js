// Señales de procedencia, NO una autorización para borrar ni cambiar cuentas.
// Se exige coincidencia exacta de nombre Y slug. El plan comercial "prueba",
// la ausencia de ventas y palabras como "demo" nunca bastan para clasificar.
export const FIXTURES_NEGOCIOS_CONOCIDOS = [
  ...['a', 'b', 'c', 'd'].map((letra, i) => ({
    slug: `faseb-negocio-${letra}`,
    nombre: `Fase B Negocio ${letra.toUpperCase()} (whatsapp ${['activo', 'activo', 'no contratado', 'suspendido'][i]})`,
    fuente: 'test/seed-datos-prueba.mjs',
  })),
  ...[
    ['cond', 'Cond', 'fase-promo-condiciones-modificadores.mjs'],
    ['guiado', 'Guiado', 'fase-promo-guiado-preview.mjs'],
    ['info', 'Info', 'fase-promo-informativa.mjs'],
    ['prod', 'Prod', 'fase-promo-productos.mjs'],
    ['eng', 'Demo', 'fase-promociones.mjs'],
  ].flatMap(([slug, nombre, fuente]) => ['a', 'b'].map(letra => ({
    slug: `promo-${slug}-${letra}`, nombre: `Promo ${nombre} ${letra.toUpperCase()}`, fuente: `test/${fuente}`,
  }))),
  ...['a', 'b'].map(letra => ({
    slug: `fase3a-neg-${letra}`, nombre: `Fase3A Demo ${letra.toUpperCase()}`,
    fuente: 'test/fase3a-registro-usos-promociones.mjs (commit 452dfe5)',
  })),
];

export function revisionDatosNegocio({ nombre, slug } = {}) {
  const fixture = FIXTURES_NEGOCIOS_CONOCIDOS.find(f => f.slug === slug && f.nombre === nombre);
  if (fixture) return { tipo: 'prueba_tecnica', etiqueta: 'Prueba técnica', evidencia: `Nombre y clave coinciden con ${fixture.fuente}. Revisar antes de retirar.` };
  if (nombre === 'Xabor Piloto Mario' && /^xabor-piloto-mario-[a-f0-9]{12}$/.test(slug || '')) {
    return { tipo: 'piloto', etiqueta: 'Piloto', evidencia: 'Cuenta del piloto comercial de Xabor. Puede contener contrataciones; revisar antes de retirar.' };
  }
  return { tipo: 'sin_senales', etiqueta: 'Sin señales de prueba', evidencia: 'Sin coincidencia con las pruebas conocidas. Esto no confirma que sea un cliente comercial.' };
}

// Solo alias internos y literales del catálogo anterior, jamás entrada HTTP.
export function revisionDatosSql(alias = 'n') {
  if (!/^[a-z][a-z0-9_]*$/.test(alias)) throw new Error('Alias SQL inválido');
  const literal = valor => `'${valor.replaceAll("'", "''")}'`;
  const conocidos = FIXTURES_NEGOCIOS_CONOCIDOS.map(f => `(${alias}.slug = ${literal(f.slug)} AND ${alias}.nombre = ${literal(f.nombre)})`).join(' OR ');
  return `(CASE WHEN ${conocidos} THEN 'prueba_tecnica'
    WHEN ${alias}.nombre = 'Xabor Piloto Mario' AND ${alias}.slug ~ '^xabor-piloto-mario-[a-f0-9]{12}$' THEN 'piloto'
    ELSE 'sin_senales' END)`;
}
