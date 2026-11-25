// Presentación del plan dentro del panel existente. Los permisos reales se
// comprueban en las APIs y WebSocket; esta lista no concede ningún módulo.
(function (global) {
  'use strict';
  const vistas = new Set(['inicio', 'comandas', 'presencial', 'historial', 'menu', 'restaurante', 'ventas', 'config', 'suscripcion']);
  function permiteVista(vista) { return vistas.has(vista); }
  function aplicar(document) {
    document.body.classList.add('plan-basico');
    for (const boton of document.querySelectorAll('#tabs-nav .tab-btn')) {
      if (!permiteVista(boton.id.replace(/^tab-/, ''))) boton.style.display = 'none';
    }
    const suscripcion = document.getElementById('tab-suscripcion');
    if (suscripcion) suscripcion.style.display = '';
    for (const elemento of document.querySelectorAll('[data-basico-excluir]')) elemento.style.display = 'none';
    for (const elemento of document.querySelectorAll('#config-portada .cfg-card')) {
      if (elemento.id !== 'cfg-card-negocio') elemento.style.display = 'none';
    }
    for (const elemento of document.querySelectorAll('.mod-chip, .modalidad-card')) {
      if (elemento.dataset.mod !== 'llevar') elemento.style.display = 'none';
    }
    for (const id of ['pest-repartidores', 'pest-ajustes', 'cfg-card-usuarios', 'cfg-card-diagnostico']) {
      const elemento = document.getElementById(id);
      if (elemento) elemento.style.display = 'none';
    }
  }
  global.XaborPlanBasicoPanel = Object.freeze({ permiteVista, aplicar });
})(typeof window === 'undefined' ? globalThis : window);
