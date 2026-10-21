// ─── Configuración → Impresoras: equipos y rutas ────────────────────────────
//
// Lo que la pantalla de Impresoras no decía y ahora dice:
//   - de cada equipo (PC con Xabor Edge): si nunca se conectó, desde cuándo
//     está sin conexión y qué versión tiene;
//   - «Olvidar este equipo», para los que ya no existen, diciendo ANTES qué
//     se pierde (src/services/equiposImpresion.js);
//   - qué se imprime dónde, con las rutas que no están funcionando marcadas
//     y cada una cambiable a otra impresora.
//
// Vive en su propio archivo para tocar lo menos posible index.html, que es
// componente protegido. index.html lo carga con ?v=<huella> y llama a
// XaborImpresoras desde pintarImpresoras(). Los datos vienen de
// GET /api/impresion/self-service (impEstado).
(function () {
  'use strict';

  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  // Argumento de un onclick="…('x')": comillas escapadas para JS y para HTML.
  var arg = function (s) { return esc(JSON.stringify(String(s == null ? '' : s))); };
  var pedir = function (url, opts) { return window.apiFetch(url, opts || {}); };
  var json = function (r) { return r.json().catch(function () { return {}; }); };
  var avisar = function (txt, error) { if (typeof window.impProgreso === 'function') window.impProgreso(txt, error); };
  var recargar = function () { return typeof window.cargarImpresoras === 'function' ? window.cargarImpresoras() : null; };

  var ocupado = false;

  // ── Equipos ──────────────────────────────────────────────────────────────

  function haceCuanto(fecha) {
    var t = new Date(fecha).getTime();
    if (!isFinite(t)) return '';
    var min = Math.max(0, Math.round((Date.now() - t) / 60000));
    if (min < 2) return 'hace un momento';
    if (min < 60) return 'hace ' + min + ' minutos';
    var horas = Math.round(min / 60);
    if (horas < 24) return 'hace ' + horas + (horas === 1 ? ' hora' : ' horas');
    var dias = Math.round(horas / 24);
    return 'hace ' + dias + (dias === 1 ? ' día' : ' días');
  }

  function fechaCorta(fecha) {
    try {
      return new Date(fecha).toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
    } catch (e) { return ''; }
  }

  // El texto junto al nombre del equipo.
  function estadoEquipo(eq) {
    var gris = 'color:#666;font-size:0.85rem;';
    if (eq.conectado) {
      return '<span style="' + gris + '">Conectado &#10003;' +
        (eq.version ? ' &middot; Xabor Edge ' + esc(eq.version) : '') + '</span>';
    }
    if (eq.nuncaConectado) {
      return '<span style="color:#b45309;font-size:0.85rem;">Nunca se ha conectado</span>';
    }
    return '<span style="color:#b45309;font-size:0.85rem;" title="' + esc(fechaCorta(eq.ultimaConexion)) + '">' +
      'Sin conexi&oacute;n desde ' + esc(haceCuanto(eq.ultimaConexion)) + '</span>';
  }

  // Debajo del encabezado de un equipo conectado con un Edge anterior a la
  // 1.2.0, que no dice su versión ni se actualiza solo. (Para uno sin
  // conexión, index.html ya dice qué revisar.)
  function notaEquipo(eq) {
    if (!eq.conectado || eq.version) return '';
    return '<div style="color:#888;font-size:0.82rem;margin-top:6px;">Esta computadora tiene una versi&oacute;n anterior de Xabor Edge. ' +
      'Inst&aacute;lale la nueva una vez y despu&eacute;s se actualiza sola.</div>';
  }

  // Solo para equipos sin conexión: uno conectado está imprimiendo.
  function botonOlvidar(eq) {
    if (eq.conectado) return '';
    return '<button onclick="XaborImpresoras.olvidar(' + arg(eq.id) + ',' + arg(eq.nombre) + ')"' + (ocupado ? ' disabled' : '') +
      ' style="background:#fff;color:#b91c1c;border:1px solid #fca5a5;border-radius:8px;padding:8px 14px;font-size:0.85rem;' +
      'font-weight:700;cursor:pointer;margin-top:6px;">Olvidar este equipo</button>';
  }

  function listaCorta(xs, max) {
    if (xs.length <= max) return xs.join(', ');
    return xs.slice(0, max).join(', ') + ' y ' + (xs.length - max) + ' más';
  }

  async function olvidar(id, nombre) {
    if (ocupado) return;
    ocupado = true;
    avisar('Revisando qué tiene este equipo...');
    try {
      var r = await pedir('/api/impresion/edges/' + encodeURIComponent(id) + '/olvido');
      var res = await json(r);
      if (!r.ok) throw new Error(res.error || 'No pudimos revisar ese equipo');
      if (res.conectado) throw new Error('«' + nombre + '» está conectado ahora mismo: no se puede olvidar mientras imprime.');

      var lineas = ['¿Olvidar «' + nombre + '»?', '',
        'Se quita de esta lista y ya no podrá imprimir aunque esa computadora se vuelva a encender.'];
      if (res.impresoras.length) lineas.push('• Sus impresoras dejan de usarse: ' + listaCorta(res.impresoras, 3) + '.');
      var claves = res.rutas.filter(function (x) { return x.ambito !== 'documento'; })
        .map(function (x) { return nombreVisible(x.clave, window.impCategoriasPrep); });
      if (claves.length) lineas.push('• Lo que se mandaba ahí (' + listaCorta(claves, 4) + ') saldrá en Cocina.');
      if (res.trabajosEnEspera) {
        lineas.push('• Se cancelan ' + res.trabajosEnEspera + (res.trabajosEnEspera === 1 ? ' impresión que seguía' : ' impresiones que seguían') +
          ' esperando a este equipo y nunca salió papel.');
      }
      lineas.push('', 'Si después quieres usar esa computadora, conéctala otra vez con «Conectar otro equipo».');
      if (!window.confirm(lineas.join('\n'))) { avisar(''); return; }

      avisar('Olvidando «' + nombre + '»...');
      r = await pedir('/api/impresion/edges/' + encodeURIComponent(id) + '/olvidar', { method: 'POST' });
      res = await json(r);
      if (!r.ok) throw new Error(res.error || 'No pudimos olvidar ese equipo');
      ocupado = false;
      await recargar();
      avisar('«' + nombre + '» ya no aparece.' +
        (res.trabajosCancelados ? ' Se cancelaron ' + res.trabajosCancelados + ' impresiones que lo esperaban.' : ''));
    } catch (e) {
      avisar(e.message, true);
    } finally {
      ocupado = false;
    }
  }

  // ── Papel ────────────────────────────────────────────────────────────────

  function ayudaPapel() {
    return '<div style="color:#888;font-size:0.8rem;margin-top:10px;line-height:1.5;">' +
      '<b>Papel de 80 mm:</b> &laquo;80 mm a todo lo ancho&raquo; usa todo el rollo y la comanda sale con letra m&aacute;s grande. ' +
      'Imprime una prueba: si la l&iacute;nea de n&uacute;meros 1234567890&hellip; no cabe completa en un rengl&oacute;n, elige &laquo;80 mm&raquo;.</div>';
  }

  // ── Rutas de preparación ─────────────────────────────────────────────────

  // La clave de una ruta se guarda normalizada (routingEngine.normalizarClave:
  // sin acentos, minúsculas, un solo espacio). Para compararla con el menú y
  // para mostrarla con el nombre de siempre, se normaliza igual aquí. Los
  // acentos combinantes se arman con fromCharCode para no depender de
  // caracteres invisibles en este archivo.
  var COMBINANTES = new RegExp('[' + String.fromCharCode(0x300) + '-' + String.fromCharCode(0x36f) + ']', 'g');
  function normalizar(s) {
    return String(s == null ? '' : s).normalize('NFD').replace(COMBINANTES, '').trim().toLowerCase().replace(/\s+/g, ' ');
  }

  // Nombre de la categoría como está en el menú. Si ya no está en el menú, la
  // clave guardada con mayúscula inicial (los acentos ya no se recuperan).
  function nombreVisible(clave, categorias) {
    var n = normalizar(clave);
    var lista = categorias || [];
    for (var i = 0; i < lista.length; i++) if (normalizar(lista[i]) === n) return lista[i];
    var s = String(clave == null ? '' : clave);
    return s.charAt(0).toUpperCase() + s.slice(1);
  }

  var AVISOS = {
    impresora_apagada: 'Esa impresora est&aacute; fuera de uso: esto sale en Cocina.',
    equipo_desconectado: 'El equipo de esa impresora no est&aacute; conectado: mientras tanto esto sale en Cocina.',
  };

  function nombreImpresora(i, varios) {
    return esc(i.impresoraNombre || i.nombre) + (varios && i.equipoNombre ? ' &middot; ' + esc(i.equipoNombre) : '');
  }

  function aviso(estado) {
    return AVISOS[estado]
      ? '<div style="color:#b45309;font-size:0.8rem;margin-top:3px;">&#9888; ' + AVISOS[estado] + '</div>'
      : '';
  }

  function rutasHtml(e, categorias) {
    if (!e) return '';
    var imps = e.impresorasParaRutas || [];
    var rutas = e.rutasPreparacion || [];
    if (!imps.length && !rutas.length) return '';
    var equipos = {};
    imps.forEach(function (i) { equipos[i.equipoNombre] = true; });
    var varios = Object.keys(equipos).length > 1;
    // Nombre de la categoría como está en el menú; si ya no está, la clave.
    var visible = function (clave) { return nombreVisible(clave, categorias); };
    var fila = 'padding:8px 0;border-bottom:1px solid #f1f0ed;font-size:0.88rem;';
    var sel = 'padding:5px;border-radius:6px;border:1px solid #ddd;max-width:220px;font-family:inherit;font-size:0.85rem;';

    var html = '<div style="background:#fff;border:1px solid #eee;border-radius:12px;padding:14px 16px;margin-top:14px;">' +
      '<div style="font-weight:800;font-size:0.95rem;margin-bottom:2px;">&#129517; Rutas de preparaci&oacute;n</div>' +
      '<div style="color:#666;font-size:0.82rem;margin-bottom:8px;">Qu&eacute; se imprime d&oacute;nde. Cada categor&iacute;a puede ir a su estaci&oacute;n; ' +
      'lo que no tenga ruta sale en <b>Cocina</b>.</div>';

    // Lo de siempre: comandas y tickets.
    var pd = e.porDefecto || { comanda: [], cuenta: [] };
    var destinoFijo = function (titulo, lista) {
      return '<div style="' + fila + '"><b>' + titulo + '</b> &rarr; ' +
        (lista.length ? lista.map(function (d) { return nombreImpresora(d, varios); }).join(', ') : '<span style="color:#b45309;">ninguna</span>') +
        lista.map(function (d) { return aviso(d.estado); }).join('') + '</div>';
    };
    html += destinoFijo('Todo lo dem&aacute;s (Cocina)', pd.comanda || []) + destinoFijo('Ticket del cliente (Caja)', pd.cuenta || []);

    rutas.forEach(function (r) {
      var opciones = imps.map(function (i) {
        return '<option value="' + esc(i.id) + '"' + (i.id === r.impresoraId ? ' selected' : '') + '>' + nombreImpresora(i, varios) + '</option>';
      }).join('');
      // La impresora actual puede estar fuera de uso: se muestra igual para
      // que se vea a dónde apunta hoy, sin poder elegirla.
      if (!imps.some(function (i) { return i.id === r.impresoraId; })) {
        opciones = '<option value="" selected disabled>' + esc(r.impresoraNombre || 'sin impresora') + ' (fuera de uso)</option>' + opciones;
      }
      html += '<div style="' + fila + (r.estado !== 'ok' ? 'background:#fffbeb;' : '') + '">' +
        '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<span><b>' + esc(visible(r.clave)) + '</b>' + (r.ambito === 'producto' ? ' <span style="color:#888;">(platillo)</span>' : '') + ' &rarr;</span>' +
          '<span style="display:flex;gap:6px;align-items:center;">' +
            '<select onchange="XaborImpresoras.cambiarRuta(' + arg(r.id) + ',this)" style="' + sel + '"' + (ocupado ? ' disabled' : '') + '>' + opciones + '</select>' +
            '<button onclick="XaborImpresoras.quitarRuta(' + arg(r.id) + ',' + arg(visible(r.clave)) + ')" style="background:none;border:none;color:#b91c1c;cursor:pointer;font-size:0.82rem;">Quitar</button>' +
          '</span>' +
        '</div>' + aviso(r.estado) + '</div>';
    });
    if (!rutas.length) {
      html += '<div style="color:#888;font-size:0.85rem;padding:6px 0;">A&uacute;n no hay rutas por categor&iacute;a.</div>';
    }

    if (imps.length && (categorias || []).length) {
      var conRuta = {};
      rutas.forEach(function (r) { if (r.ambito === 'categoria') conRuta[normalizar(r.clave)] = true; });
      html += '<div style="display:flex;gap:8px;align-items:flex-end;flex-wrap:wrap;margin-top:10px;">' +
        '<label style="font-size:0.8rem;color:#555;">Categor&iacute;a<br><select id="ruta-prep-cat" style="' + sel + 'min-width:150px;">' +
          categorias.map(function (c) {
            return '<option value="' + esc(c) + '">' + esc(c) + (conRuta[normalizar(c)] ? ' (ya tiene ruta)' : '') + '</option>';
          }).join('') +
        '</select></label>' +
        '<label style="font-size:0.8rem;color:#555;">Impresora<br><select id="ruta-prep-imp" style="' + sel + 'min-width:150px;">' +
          imps.map(function (i) { return '<option value="' + esc(i.id) + '">' + nombreImpresora(i, varios) + '</option>'; }).join('') +
        '</select></label>' +
        '<button onclick="XaborImpresoras.guardarRuta()" id="btn-ruta-prep"' + (ocupado ? ' disabled' : '') +
          ' style="background:#15803d;color:#fff;border:none;border-radius:8px;padding:8px 16px;font-weight:700;cursor:pointer;">Agregar ruta</button>' +
      '</div>';
    } else if (imps.length) {
      html += '<div style="color:#b45309;font-size:0.85rem;margin-top:8px;">Carga tu men&uacute; (categor&iacute;as) para crear rutas por categor&iacute;a.</div>';
    }
    return html + '<div id="ruta-prep-msg" style="font-size:0.83rem;margin-top:8px;"></div></div>';
  }

  function mensaje(txt, error) {
    var el = document.getElementById('ruta-prep-msg');
    if (el) { el.style.color = error ? '#b91c1c' : '#15803d'; el.textContent = txt || ''; }
  }

  async function guardarRuta() {
    var cat = document.getElementById('ruta-prep-cat');
    var imp = document.getElementById('ruta-prep-imp');
    if (!cat || !imp || !cat.value || !imp.value) { mensaje('Elige categoría e impresora.', true); return; }
    if (ocupado) return;
    ocupado = true;
    try {
      var r = await pedir('/api/impresion/rutas', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ impresoraId: imp.value, ambito: 'categoria', clave: cat.value, modo: 'agregar' }),
      });
      var d = await json(r);
      if (!r.ok) throw new Error(r.status === 409 ? 'Esa categoría ya sale en esa impresora.' : (d.error || 'No se pudo guardar la ruta.'));
      ocupado = false;
      await recargar();
      mensaje('Listo: ' + cat.value + ' sale en la impresora elegida.');
    } catch (e) { mensaje(e.message, true); }
    finally { ocupado = false; }
  }

  async function cambiarRuta(id, select) {
    if (ocupado || !select || !select.value) return;
    ocupado = true;
    try {
      var r = await pedir('/api/impresion/rutas/' + encodeURIComponent(id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ impresoraId: select.value }),
      });
      var d = await json(r);
      if (!r.ok) throw new Error(d.error || 'No se pudo cambiar la ruta.');
      ocupado = false;
      await recargar();
      mensaje('Ruta cambiada.');
    } catch (e) {
      ocupado = false;
      await recargar();
      mensaje(e.message, true);
    } finally { ocupado = false; }
  }

  async function quitarRuta(id, clave) {
    if (ocupado) return;
    if (!window.confirm('¿Quitar la ruta de «' + clave + '»? Saldrá en Cocina.')) return;
    ocupado = true;
    try {
      var r = await pedir('/api/impresion/rutas/' + encodeURIComponent(id), { method: 'DELETE' });
      var d = await json(r);
      if (!r.ok) throw new Error(d.error || 'No se pudo quitar.');
      ocupado = false;
      await recargar();
      mensaje(clave + ' ahora sale en Cocina.');
    } catch (e) { mensaje(e.message, true); }
    finally { ocupado = false; }
  }

  window.XaborImpresoras = {
    estadoEquipo: estadoEquipo, notaEquipo: notaEquipo, botonOlvidar: botonOlvidar, olvidar: olvidar,
    ayudaPapel: ayudaPapel, rutasHtml: rutasHtml, guardarRuta: guardarRuta, cambiarRuta: cambiarRuta, quitarRuta: quitarRuta,
    haceCuanto: haceCuanto,
  };
})();
