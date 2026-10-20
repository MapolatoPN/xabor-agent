// Versión de ESTE código del Edge.
//
// La manda al autenticarse, y con ella la nube decide si le ofrece una
// actualización. También es la que confirma al lanzador que la versión nueva
// arrancó: si no coincide con la que el lanzador puso a prueba, nunca se
// confirma y se revierte. Por eso firmar-actualizacion.mjs se niega a firmar
// un paquete cuya versión no sea la de este archivo.
export const VERSION_EDGE = '1.2.0';
