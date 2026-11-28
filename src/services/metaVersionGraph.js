// Versión de la Graph API de Meta: UNA sola para todo Xabor.
//
// Antes, `v20.0` estaba escrita a mano en más de veinte lugares. v20.0 caducó
// el 24-sep-2026, y Meta atiende una versión caducada con la vigente más
// antigua: la versión real cambiaba sola, sin que nadie la eligiera (v21.0
// hasta el 21-ene-2027, v22.0 después). Ahora cada llamada a Graph arma su
// URL con versionGraph(), y scripts/check-graph-version-unica.mjs (en el
// predeploy) falla si vuelve una versión escrita a mano.
//
// META_GRAPH_VERSION (variable de Railway) la cambia sin tocar código. Solo
// se acepta con la forma vNN.0: cualquier otro valor cae a la de por
// omisión, para que un valor mal escrito nunca arme una URL rara.
//
// Reversa: META_GRAPH_VERSION=v20.0 deja las URLs idénticas a las de antes
// de este cambio.
export const GRAPH_VERSION_POR_OMISION = 'v25.0';

const FORMA_VERSION = /^v\d{2,3}\.0$/;

/** Versión efectiva de la Graph API, p. ej. «v25.0». Se lee en cada llamada. */
export function versionGraph() {
  const v = String(process.env.META_GRAPH_VERSION ?? '').trim();
  return FORMA_VERSION.test(v) ? v : GRAPH_VERSION_POR_OMISION;
}

/** true si META_GRAPH_VERSION trae algo que no es una versión válida. */
export function versionGraphIgnorada() {
  const v = String(process.env.META_GRAPH_VERSION ?? '').trim();
  return v !== '' && !FORMA_VERSION.test(v);
}
