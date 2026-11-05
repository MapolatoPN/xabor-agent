// Precarga SOLO para pruebas (node --import ./test/lib-reloj-fijo.mjs): fija
// el reloj de JavaScript del proceso en RELOJ_FIJO_PRUEBA (ISO 8601). Desde
// ese instante el reloj avanza normal, para que los tiempos de espera sigan
// funcionando. Sin la variable no hace nada. No afecta a Postgres (su now()).
const iso = process.env.RELOJ_FIJO_PRUEBA;
if (iso) {
  const Real = globalThis.Date;
  const fijo = Real.parse(iso);
  if (Number.isNaN(fijo)) throw new Error(`RELOJ_FIJO_PRUEBA inválido: ${iso}`);
  const inicioReal = Real.now();
  const ahora = () => fijo + (Real.now() - inicioReal);
  globalThis.Date = class extends Real {
    constructor(...a) { if (a.length) super(...a); else super(ahora()); }
    static now() { return ahora(); }
  };
}
