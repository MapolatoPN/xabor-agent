// Control de lecturas, no de atención: nunca escribe ni supone que el bot
// está libre si falla la red. Se prueba el mismo código servido al navegador.
(function (root) {
  'use strict';
  function validarEstado(e) {
    const campos = ['pausado', 'pausaManual', 'botWhatsappActivo', 'requiereRevision', 'takeoverVigente'];
    if (!e || campos.some(k => typeof e[k] !== 'boolean')
      || e.pausado !== (e.pausaManual || e.requiereRevision)
      || !Number.isFinite(Date.parse(e.consultadoEn))
      || (e.takeoverVigente && !Number.isFinite(Date.parse(e.takeoverHasta)))) {
      throw new Error('ESTADO_ATENCION_INVALIDO');
    }
    return e;
  }
  function crearConsulta({ consultar, pintar }) {
    let telefono = null, secuencia = 0, pendiente = null;
    function cerrar() { telefono = null; secuencia++; pendiente = null; }
    function refrescar({ invalidar = false } = {}) {
      if (!telefono) return Promise.resolve(null);
      if (pendiente && !invalidar) return pendiente;
      const actual = telefono, turno = ++secuencia;
      if (invalidar) pintar({ situacion: 'cargando' });
      const vigente = () => telefono === actual && secuencia === turno;
      const tarea = Promise.resolve().then(() => consultar(actual)).then(validarEstado).then(e => {
        if (!vigente()) return null;
        pintar({ ...e, situacion: 'verificado' });
        return e;
      }).catch(() => {
        if (vigente()) pintar({ situacion: 'no_disponible' });
        return null;
      }).finally(() => { if (vigente()) pendiente = null; });
      pendiente = tarea;
      return tarea;
    }
    function abrir(nuevoTelefono) {
      cerrar(); telefono = nuevoTelefono;
      return refrescar({ invalidar: true });
    }
    return { abrir, cerrar, refrescar };
  }
  root.XaborEstadoAtencionChat = { crearConsulta, validarEstado };
})(typeof window === 'undefined' ? globalThis : window);
