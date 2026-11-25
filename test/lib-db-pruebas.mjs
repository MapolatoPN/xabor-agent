// Las semillas históricas dejaban negocios sintéticos si DATABASE_URL apuntaba
// al servicio real. Fallar ANTES de importar/conectar a pg, sin imprimir URL.
export function exigirBaseLocalPruebas(valor = process.env.DATABASE_URL) {
  let url;
  try { url = new URL(valor); } catch { throw new Error('PRUEBAS_DB_RECHAZADA: se requiere una base local test_*'); }
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
      || !['localhost', '127.0.0.1', '[::1]', '::1'].includes(url.hostname)
      || !/^test_[a-z0-9_]+$/i.test(url.pathname.slice(1))) {
    throw new Error('PRUEBAS_DB_RECHAZADA: las semillas solo admiten localhost y una base test_*');
  }
  return true;
}
