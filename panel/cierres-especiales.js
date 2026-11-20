// Días cerrados (festivos) en Configuración → Horarios, operación y entregas.
//
// Por qué existe: el lunes 16-nov-2026 Acuña cerró por festivo y
// mantenimiento. El panel no tenía dónde decirlo, así que desmarcaron el lunes
// en el horario de la semana. El domingo el bot les dijo a ~12 personas
// «abrimos mañana a las 7:30», y al volver a marcar el lunes el panel le puso
// 9:00–20:00 por su cuenta. El bot, la tienda y el descuento tras cierre ya
// entendían `reglas_atencion.cierres_especiales` (src/services/horarioSemanal.js);
// faltaba la pantalla.
//
// Qué guarda, por día: { fecha: 'YYYY-MM-DD', motivo, hora_cierre? }. Sin
// hora_cierre ese día no se abre; con ella se cierra temprano. El servidor
// revisa lo mismo al guardar (src/services/cierresEspeciales.js). Los días que
// pasaron hace más de 30 se quitan solos al guardar.
//
// También decide qué horario proponer al volver a marcar un día de la semana
// que estaba cerrado: el más común de los días que sí abren, no 9:00–20:00.
//
// Lo usan renderReglasForm y guardarReglas de index.html. Lo puro (normalizar,
// horarioSugerido, fechaLegible) no toca el DOM, para probarlo fuera del navegador.
(function (global) {
  'use strict';

  var NOMBRE_DIA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  var MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto',
    'septiembre', 'octubre', 'noviembre', 'diciembre'];
  var SEMANA = ['lunes', 'martes', 'miercoles', 'jueves', 'viernes', 'sabado', 'domingo'];
  var DIAS_PASADOS_QUE_SE_GUARDAN = 30;
  var DIAS_HACIA_ADELANTE = 730;
  var MAX_MOTIVO = 80;
  var MOTIVO_POR_OMISION = 'cierre especial';
  var HORARIO_POR_OMISION = { apertura: '09:00', cierre: '20:00' };

  function dos(n) { return (n < 10 ? '0' : '') + n; }

  function fechaReal(f) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(f || ''))) return false;
    var d = new Date(f + 'T12:00:00Z');
    return !isNaN(d.getTime()) && d.toISOString().slice(0, 10) === f;
  }

  function minutos(v) {
    var m = /^(\d{1,2}):(\d{2})$/.exec(String(v || '').trim());
    if (!m) return null;
    var h = Number(m[1]), mi = Number(m[2]);
    return h > 23 || mi > 59 ? null : h * 60 + mi;
  }

  function sumarDias(f, n) {
    var d = new Date(f + 'T12:00:00Z');
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  function hoyLocal(ahora) {
    var d = ahora || new Date();
    return d.getFullYear() + '-' + dos(d.getMonth() + 1) + '-' + dos(d.getDate());
  }

  /** '2026-11-16' → 'lunes 16 de noviembre de 2026'. */
  function fechaLegible(f) {
    if (!fechaReal(f)) return String(f || '');
    var d = new Date(f + 'T12:00:00Z');
    return NOMBRE_DIA[d.getUTCDay()] + ' ' + d.getUTCDate() + ' de ' + MESES[d.getUTCMonth()] + ' de ' + d.getUTCFullYear();
  }

  /**
   * El horario que se propone al volver a marcar un día cerrado: el par
   * apertura–cierre más repetido entre los días que abren (en empate, el que
   * aparece primero de lunes a domingo). Sin ninguno, 09:00–20:00.
   */
  function horarioSugerido(horarios) {
    var cuenta = {}, mejor = null;
    SEMANA.forEach(function (dia) {
      var h = horarios && horarios[dia];
      if (!h || h.abierto !== true) return;
      if (!/^\d{1,2}:\d{2}$/.test(String(h.apertura || '')) || !/^\d{1,2}:\d{2}$/.test(String(h.cierre || ''))) return;
      var k = h.apertura + '|' + h.cierre;
      cuenta[k] = (cuenta[k] || 0) + 1;
      if (!mejor || cuenta[k] > cuenta[mejor]) mejor = k;
    });
    if (!mejor) return { apertura: HORARIO_POR_OMISION.apertura, cierre: HORARIO_POR_OMISION.cierre };
    var p = mejor.split('|');
    return { apertura: p[0], cierre: p[1] };
  }

  function falla(fila, error) { return { ok: false, fila: fila, error: error }; }

  /**
   * De los renglones de la pantalla (o de lo guardado) a lo que se guarda:
   * revisa cada día, quita los ya guardados que pasaron hace más de 30 días y
   * ordena por fecha. Un día nuevo o cambiado no puede ser pasado ni estar a
   * más de dos años. Conserva cualquier otro dato que traiga cada día.
   * Devuelve { ok: true, lista } o { ok: false, fila, error }.
   */
  function normalizar(lista, opciones) {
    var hoy = (opciones && opciones.hoy) || hoyLocal();
    var limite = sumarDias(hoy, -DIAS_PASADOS_QUE_SE_GUARDAN);
    var salida = [], vistas = {};
    var filas = Array.isArray(lista) ? lista : [];
    for (var i = 0; i < filas.length; i++) {
      var e = filas[i] || {};
      var fecha = String(e.fecha || '').trim();
      if (!fecha) return falla(i, 'A un día cerrado le falta la fecha: ponla o quita ese renglón.');
      if (!fechaReal(fecha)) return falla(i, 'La fecha ' + fecha + ' de un día cerrado no es válida.');
      var origen = e.original && typeof e.original === 'object' ? e.original : e;
      // Un día que se acaba de poner (o cambiar) con fecha pasada o muy lejana
      // es un error de dedo en el año: se avisa en vez de quitarlo callado.
      var nuevo = String(origen.fecha || '') !== fecha;
      if (nuevo && fecha < hoy) return falla(i, 'El ' + fechaLegible(fecha) + ' ya pasó: revisa la fecha.');
      if (nuevo && fecha > sumarDias(hoy, DIAS_HACIA_ADELANTE)) {
        return falla(i, 'El ' + fechaLegible(fecha) + ' está a más de dos años: revisa el año.');
      }
      if (fecha < limite) continue;
      if (vistas[fecha]) return falla(i, 'El ' + fechaLegible(fecha) + ' está dos veces en los días cerrados.');
      vistas[fecha] = true;

      var limpio = {};
      Object.keys(origen).forEach(function (k) {
        if (k !== 'original' && k !== 'modo') limpio[k] = origen[k];
      });
      limpio.fecha = fecha;

      var motivo = String(e.motivo == null ? '' : e.motivo).trim();
      if (motivo.length > MAX_MOTIVO) {
        return falla(i, 'El motivo del ' + fechaLegible(fecha) + ' es muy largo (máximo ' + MAX_MOTIVO + ' letras).');
      }
      limpio.motivo = motivo || MOTIVO_POR_OMISION;

      var modo = e.modo || (e.hora_cierre ? 'temprano' : 'todo');
      if (modo === 'temprano') {
        var m = minutos(e.hora_cierre);
        if (m === null) return falla(i, 'Pon a qué hora cierran el ' + fechaLegible(fecha) + '.');
        if (m === 0) return falla(i, 'Si el ' + fechaLegible(fecha) + ' no abren, elige «Cerrado todo el día».');
        limpio.hora_cierre = String(e.hora_cierre).trim();
      } else {
        delete limpio.hora_cierre;
      }
      salida.push(limpio);
    }
    salida.sort(function (a, b) { return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0; });
    return { ok: true, lista: salida };
  }

  // ── Pantalla ──────────────────────────────────────────────────────────────
  var estado = { cont: null, filas: [] };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var CAMPO = 'padding:6px;border:1px solid #e5e2da;border-radius:6px;font-size:0.85rem;';

  function nota(fila) {
    if (!fechaReal(fila.fecha)) return 'Elige la fecha.';
    var paso = fila.fecha < hoyLocal() ? ' · ya pasó' : '';
    return fechaLegible(fila.fecha) + (fila.modo === 'temprano' ? ' · se cierra temprano' : ' · no se abre') + paso;
  }

  function renglon(fila, i) {
    var temprano = fila.modo === 'temprano';
    return '<div data-fila="' + i + '" style="border:1px solid #e5e2da;border-radius:8px;padding:8px;margin-bottom:6px;">'
      + '<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">'
      + '<input type="date" data-campo="fecha" aria-label="Fecha" value="' + esc(fila.fecha) + '" style="' + CAMPO + 'flex:1;min-width:140px;">'
      + '<select data-campo="modo" aria-label="Cómo" style="' + CAMPO + 'flex:1;min-width:150px;">'
      + '<option value="todo"' + (temprano ? '' : ' selected') + '>Cerrado todo el día</option>'
      + '<option value="temprano"' + (temprano ? ' selected' : '') + '>Cierra temprano</option>'
      + '</select>'
      + '<input type="time" data-campo="hora_cierre" aria-label="Hora de cierre" value="' + esc(fila.hora_cierre) + '" style="' + CAMPO + 'width:110px;display:' + (temprano ? 'inline-block' : 'none') + ';">'
      + '<button type="button" data-accion="quitar" style="background:none;border:none;color:#ef4444;font-size:0.8rem;cursor:pointer;padding:4px 8px;">Quitar</button>'
      + '</div>'
      + '<input data-campo="motivo" maxlength="' + MAX_MOTIVO + '" aria-label="Motivo" placeholder="Motivo (ej. día festivo, mantenimiento)" value="' + esc(fila.motivo) + '" style="' + CAMPO + 'width:100%;box-sizing:border-box;margin-top:6px;">'
      + '<div data-nota style="font-size:0.75rem;color:#888;margin-top:4px;">' + esc(nota(fila)) + '</div>'
      + '<div data-error style="font-size:0.78rem;color:#ef4444;margin-top:2px;"></div>'
      + '</div>';
  }

  function dibujar() {
    if (!estado.cont) return;
    estado.cont.innerHTML =
      '<div style="font-size:0.75rem;color:#888;margin-bottom:8px;">Para un día festivo o de mantenimiento, sin tocar el horario de la semana. '
      + 'Ese día el bot avisa que no abren y dice cuándo vuelven a abrir, y la tienda en línea no recibe pedidos para esa fecha. '
      + 'Los días que ya pasaron se quitan solos al mes.</div>'
      + estado.filas.map(renglon).join('')
      + (estado.filas.length ? '' : '<div style="font-size:0.78rem;color:#aaa;margin-bottom:6px;">Sin días cerrados.</div>')
      + '<button type="button" data-accion="agregar" style="background:#f1f0ed;border:none;border-radius:6px;padding:6px 12px;font-size:0.8rem;cursor:pointer;margin-top:4px;">+ Agregar día cerrado</button>';
  }

  function filaDe(el) {
    var caja = el && el.closest ? el.closest('[data-fila]') : null;
    return caja ? { caja: caja, i: Number(caja.getAttribute('data-fila')) } : null;
  }

  function alCambiar(ev) {
    var campo = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-campo');
    var f = filaDe(ev.target);
    if (!campo || !f || !estado.filas[f.i]) return;
    var fila = estado.filas[f.i];
    fila[campo] = ev.target.value;
    if (campo === 'modo') {
      var hora = f.caja.querySelector('[data-campo="hora_cierre"]');
      if (hora) hora.style.display = fila.modo === 'temprano' ? 'inline-block' : 'none';
    }
    var n = f.caja.querySelector('[data-nota]');
    if (n) n.textContent = nota(fila);
    var err = f.caja.querySelector('[data-error]');
    if (err) err.textContent = '';
  }

  function alClic(ev) {
    var boton = ev.target && ev.target.closest ? ev.target.closest('[data-accion]') : null;
    if (!boton || !estado.cont || !estado.cont.contains(boton)) return;
    var accion = boton.getAttribute('data-accion');
    if (accion === 'agregar') {
      estado.filas.push({ fecha: '', motivo: '', modo: 'todo', hora_cierre: '', original: {} });
      dibujar();
      var nuevas = estado.cont.querySelectorAll('[data-campo="fecha"]');
      if (nuevas.length) nuevas[nuevas.length - 1].focus();
    } else if (accion === 'quitar') {
      var f = filaDe(boton);
      if (f) { estado.filas.splice(f.i, 1); dibujar(); }
    }
  }

  /** Pinta la lista dentro de `cont` con lo que ya está guardado. */
  function pintar(cont, lista) {
    if (!cont) return;
    estado.cont = cont;
    estado.filas = (Array.isArray(lista) ? lista : []).map(function (e) {
      e = e && typeof e === 'object' ? e : {};
      return {
        fecha: String(e.fecha || ''), motivo: String(e.motivo || ''),
        modo: e.hora_cierre ? 'temprano' : 'todo', hora_cierre: String(e.hora_cierre || ''), original: e,
      };
    }).sort(function (a, b) { return a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0; });
    if (!cont.getAttribute('data-cierres-listo')) {
      cont.addEventListener('input', alCambiar);
      cont.addEventListener('change', alCambiar);
      cont.addEventListener('click', alClic);
      cont.setAttribute('data-cierres-listo', '1');
    }
    dibujar();
  }

  /**
   * Lo que se va a guardar. null si la lista no está en pantalla (entonces
   * guardarReglas conserva lo que ya había, como antes). Si algo está mal,
   * lo marca en su renglón y devuelve { ok: false, error }.
   */
  function leer() {
    if (!estado.cont || !estado.cont.isConnected) return null;
    var r = normalizar(estado.filas, { hoy: hoyLocal() });
    if (!r.ok) {
      var caja = estado.cont.querySelector('[data-fila="' + r.fila + '"]');
      var err = caja && caja.querySelector('[data-error]');
      if (err) err.textContent = r.error;
      if (caja && caja.scrollIntoView) caja.scrollIntoView({ block: 'center' });
    }
    return r;
  }

  global.XaborCierresEspeciales = {
    pintar: pintar, leer: leer,
    normalizar: normalizar, horarioSugerido: horarioSugerido, fechaLegible: fechaLegible,
  };
})(typeof window !== 'undefined' ? window : globalThis);
