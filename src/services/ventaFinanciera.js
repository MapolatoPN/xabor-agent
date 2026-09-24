/**
 * Lectura financiera normalizada de una venta.
 *
 * Este modulo NO recalcula promociones con reglas o precios actuales. Solo
 * interpreta snapshots que ya quedaron dentro de `pedidos_activos.datos`.
 * Cuando la evidencia historica no alcanza, conserva el importe como no
 * clasificado y marca la calidad; nunca inventa un concepto o porcentaje.
 */

const dinero = (n) => Math.round((Number(n) || 0) * 100) / 100;

function numeroO(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function texto(value) {
  const s = String(value ?? '').trim();
  return s || null;
}

function mayorCalidad(actual, nueva) {
  const rango = { completa: 0, parcial: 1, no_determinable: 2 };
  return (rango[nueva] || 0) > (rango[actual] || 0) ? nueva : actual;
}

function subtotalHistorico(datos) {
  const explicito = numeroO(datos?.subtotal);
  if (explicito !== null && explicito >= 0) return { monto: dinero(explicito), origen: 'subtotal_snapshot' };

  const items = Array.isArray(datos?.items) ? datos.items : [];
  if (!items.length) return { monto: null, origen: null };
  let total = 0;
  for (const item of items) {
    const precio = numeroO(item?.precio_unitario);
    if (precio === null) return { monto: null, origen: null };
    const cantidad = Math.max(1, Math.floor(numeroO(item?.cantidad, 1)));
    total += precio * cantidad;
  }
  return { monto: dinero(total), origen: 'items_snapshot' };
}

function promocionesHistoricas(datos) {
  const tienda = Array.isArray(datos?.tienda?.promociones) ? datos.tienda.promociones : [];
  if (tienda.length) return { promociones: tienda, origen: 'tienda.promociones' };
  const generales = Array.isArray(datos?.promociones) ? datos.promociones : [];
  if (generales.length) return { promociones: generales, origen: 'promociones' };
  const normalizadas = Array.isArray(datos?.descuentos?.promociones) ? datos.descuentos.promociones : [];
  return { promociones: normalizadas, origen: normalizadas.length ? 'descuentos.promociones' : null };
}

function clasificarPromocion(promo) {
  if (promo?.automatica === true) return 'automatica';
  if (promo?.automatica === false || texto(promo?.codigo)) return 'codigo';
  return 'desconocida';
}

function datosPrecioEspecial(datos) {
  const items = Array.isArray(datos?.items) ? datos.items : [];
  let importe = 0;
  let unidades = 0;
  for (const item of items) {
    const lista = numeroO(item?.precio_lista);
    const canal = numeroO(item?.precio_base);
    if (lista === null || canal === null || lista <= canal) continue;
    const cantidad = Math.max(1, Math.floor(numeroO(item?.cantidad, 1)));
    importe += (lista - canal) * cantidad;
    unidades += cantidad;
  }
  return { importe: dinero(importe), unidades };
}

function nuevaAplicacion(base, extra) {
  return {
    folio: base.folio,
    fecha: base.fecha,
    canal: base.canal,
    categoria: extra.categoria,
    concepto: extra.concepto,
    importe: dinero(extra.importe),
    tipo_regla: extra.tipo_regla || null,
    porcentaje: numeroO(extra.porcentaje),
    valor_regla: numeroO(extra.valor_regla),
    promocion_id: extra.promocion_id || null,
    codigo: extra.codigo || null,
    automatica: extra.automatica ?? null,
    usuario_id: extra.usuario_id || null,
    usuario: extra.usuario || null,
    calidad: extra.calidad || 'completa',
    origen_dato: extra.origen_dato || 'snapshot_pedido',
    detalle: extra.detalle || null,
  };
}

/**
 * Normaliza un `datos` historico sin consultar catalogos ni definiciones
 * actuales. `meta.totalNeto` permite reconocer un pago tardio por el monto
 * efectivamente asentado, manteniendo el snapshot original como evidencia.
 */
export function normalizarVentaFinanciera(datos = {}, meta = {}) {
  const folio = texto(meta.folio || datos.id) || 'sin-folio';
  const fecha = meta.fecha || datos.cobrado_at || datos.timestamp || null;
  const canal = texto(datos.canal || datos.origen) || 'desconocido';
  const base = { folio, fecha, canal };
  const avisos = [];
  let calidad = 'completa';

  const subtotal = subtotalHistorico(datos);
  if (subtotal.monto === null) {
    calidad = mayorCalidad(calidad, 'no_determinable');
    avisos.push('No se conserva subtotal ni precios historicos suficientes para determinar la venta bruta.');
  }

  const precioEspecial = datosPrecioEspecial(datos);
  const brutoProductos = subtotal.monto === null ? null : dinero(subtotal.monto + precioEspecial.importe);
  const aplicaciones = [];

  if (precioEspecial.importe > 0) {
    aplicaciones.push(nuevaAplicacion(base, {
      categoria: 'promocion',
      concepto: 'Precio especial de tienda',
      importe: precioEspecial.importe,
      tipo_regla: 'precio_especial',
      automatica: true,
      calidad: 'completa',
      origen_dato: 'items.precio_lista/precio_base',
      detalle: { unidades: precioEspecial.unidades },
    }));
  }

  const envioCobradoRaw = numeroO(datos.costo_envio);
  const envioCobrado = dinero(envioCobradoRaw ?? 0);
  const envioBaseRaw = numeroO(datos?.tienda?.envio_base, numeroO(datos.envio_base, envioCobradoRaw));
  const envioBase = dinero(envioBaseRaw ?? 0);
  const envioBonificado = dinero(Math.max(0, envioBase - envioCobrado));

  const { promociones, origen: origenPromos } = promocionesHistoricas(datos);
  let bonificacionEnvioAsignada = false;
  for (let i = 0; i < promociones.length; i++) {
    const promo = promociones[i] || {};
    const esEnvio = promo.envio_gratis === true || promo.envioGratis === true || promo.tipo === 'envio_gratis';
    let importe = dinero(numeroO(promo.descuento, numeroO(promo.monto, 0)));
    if (esEnvio) {
      // El motor guarda descuento=0 para envio gratis. El beneficio real es
      // la diferencia entre envio base y envio cobrado, una sola vez.
      importe = bonificacionEnvioAsignada ? 0 : envioBonificado;
      bonificacionEnvioAsignada = true;
    }
    if (importe <= 0) continue;
    const clasificacion = clasificarPromocion(promo);
    if (clasificacion === 'desconocida') {
      calidad = mayorCalidad(calidad, 'parcial');
      avisos.push('Una promocion historica no conserva si fue automatica o mediante codigo.');
    }
    const valor = numeroO(promo.valor);
    aplicaciones.push(nuevaAplicacion(base, {
      categoria: 'promocion',
      concepto: texto(promo.nombre) || (esEnvio
        ? 'Envio bonificado (concepto historico no conservado)'
        : 'Promocion sin concepto historico'),
      importe,
      tipo_regla: texto(promo.tipo),
      porcentaje: ['porcentaje', 'segundo_descuento'].includes(promo.tipo) ? valor : null,
      valor_regla: valor,
      promocion_id: promo.id || null,
      codigo: texto(promo.codigo),
      automatica: clasificacion === 'automatica' ? true : (clasificacion === 'codigo' ? false : null),
      calidad: texto(promo.nombre) ? (clasificacion === 'desconocida' ? 'parcial' : 'completa') : 'parcial',
      origen_dato: origenPromos,
      detalle: {
        envio_gratis: esEnvio,
        unidades_beneficiadas: numeroO(promo.unidades_beneficiadas, numeroO(promo.unidades)),
        acumulable: promo.acumulable == null ? null : promo.acumulable === true,
        prioridad: numeroO(promo.prioridad),
        base_calculo: numeroO(promo.base_calculo, numeroO(promo.baseCalculo)),
        campania_id: promo.campania_id || promo.campaniaId || null,
      },
    }));
  }

  if (envioBonificado > 0 && !bonificacionEnvioAsignada) {
    calidad = mayorCalidad(calidad, 'parcial');
    avisos.push('Se conserva el envio bonificado, pero no el concepto historico que lo otorgo.');
    aplicaciones.push(nuevaAplicacion(base, {
      categoria: 'promocion',
      concepto: 'Envio bonificado (concepto historico no conservado)',
      importe: envioBonificado,
      tipo_regla: 'envio_gratis',
      automatica: null,
      calidad: 'parcial',
      origen_dato: 'tienda.envio_base/costo_envio',
      detalle: { envio_gratis: true },
    }));
  }

  let promoMercancia = dinero(aplicaciones
    .filter(a => a.categoria === 'promocion' && a.tipo_regla !== 'envio_gratis' && a.tipo_regla !== 'precio_especial')
    .reduce((s, a) => s + a.importe, 0));
  const descuentoNormalizado = dinero(
    numeroO(datos?.descuentos?.manual?.monto, 0)
    + (Array.isArray(datos?.descuentos?.promociones)
      ? datos.descuentos.promociones.reduce((s, p) => s + numeroO(p?.monto ?? p?.descuento, 0), 0)
      : 0)
  );
  const descuentoAgregado = dinero(Math.max(0, numeroO(
    datos.descuento,
    numeroO(datos.descuento_total, descuentoNormalizado)
  )));

  // Rappi entrega un descuento total pero no su concepto. Es un beneficio
  // externo, no un descuento manual de un operador de Xabor.
  if (canal === 'rappi' && promociones.length === 0 && descuentoAgregado > 0) {
    aplicaciones.push(nuevaAplicacion(base, {
      categoria: 'promocion',
      concepto: 'Descuento Rappi (concepto no informado)',
      importe: descuentoAgregado,
      tipo_regla: 'externa_no_informada',
      automatica: null,
      calidad: 'parcial',
      origen_dato: 'descuento',
    }));
    promoMercancia = descuentoAgregado;
    calidad = mayorCalidad(calidad, 'parcial');
    avisos.push('Rappi informa el importe del descuento, pero no su concepto original.');
  }

  let residual = dinero(descuentoAgregado - promoMercancia);
  if (residual < -0.02) {
    calidad = mayorCalidad(calidad, 'parcial');
    avisos.push('El descuento agregado es menor que la suma de promociones historicas.');
    residual = 0;
  } else residual = Math.max(0, residual);

  if (residual > 0) {
    const motivo = texto(datos.motivo_descuento || datos.descuento_motivo || datos?.descuentos?.manual?.motivo);
    const esManualConocido = !!motivo || canal === 'presencial' || canal === 'restaurante_mesa'
      || canal === 'restaurante' || canal === 'pos';
    const categoria = esManualConocido ? 'descuento_manual' : 'descuento_no_clasificado';
    if (!motivo || categoria === 'descuento_no_clasificado') {
      calidad = mayorCalidad(calidad, 'parcial');
      avisos.push(categoria === 'descuento_manual'
        ? 'Un descuento manual no conserva su motivo historico.'
        : 'Existe un descuento historico cuyo origen manual/promocional no se puede determinar.');
    }
    const tipo = texto(datos.descuento_tipo || datos?.descuentos?.manual?.tipo);
    const valor = numeroO(datos.descuento_valor, numeroO(datos?.descuentos?.manual?.monto));
    aplicaciones.push(nuevaAplicacion(base, {
      categoria,
      concepto: motivo || (categoria === 'descuento_manual'
        ? 'Descuento manual sin concepto historico'
        : 'Descuento sin clasificacion historica'),
      importe: residual,
      tipo_regla: tipo,
      porcentaje: tipo === 'porcentaje' || tipo === 'porcentual' ? valor : null,
      valor_regla: valor,
      automatica: false,
      usuario_id: datos.descuento_por || datos.descuento_aplicado_por || datos?.descuentos?.manual?.autorizadoPor || null,
      usuario: texto(datos.descuento_por_nombre || datos?.descuentos?.manual?.autorizadoPorNombre),
      calidad: motivo && categoria === 'descuento_manual' ? 'completa' : 'parcial',
      origen_dato: 'descuento - promociones',
    }));
  }

  const canje = datos.rewards_canje || meta.rewardsCanje || datos?.descuentos?.rewards || null;
  const rewards = dinero(Math.max(0, numeroO(canje?.monto, numeroO(canje?.monto_descuento, 0))));
  if (rewards > 0) {
    aplicaciones.push(nuevaAplicacion(base, {
      categoria: 'rewards',
      concepto: 'Canje Rewards',
      importe: rewards,
      tipo_regla: 'canje_puntos',
      automatica: false,
      usuario_id: canje?.usuario_id || null,
      usuario: texto(canje?.usuario),
      calidad: 'completa',
      origen_dato: datos.rewards_canje ? 'rewards_canje' : 'rewards_movements',
      detalle: { puntos: numeroO(canje?.puntos) },
    }));
  }

  // Una versión antigua sólo conservaba `devolucion` (una fila que se
  // sobrescribía). Las versiones nuevas conservan cada aplicación en
  // `devoluciones`; nunca sumamos ambas representaciones para no duplicar.
  const devolucionesHistoricas = Array.isArray(datos?.devoluciones)
    ? datos.devoluciones
    : (datos?.devolucion ? [datos.devolucion] : []);
  let devolucion = 0;
  for (const devolucionDato of devolucionesHistoricas) {
    const importe = dinero(Math.max(0, numeroO(devolucionDato?.monto, 0)));
    if (importe <= 0) continue;
    devolucion = dinero(devolucion + importe);
    const motivo = texto(devolucionDato?.motivo);
    aplicaciones.push(nuevaAplicacion(base, {
      categoria: 'devolucion',
      concepto: motivo || 'Devolucion sin motivo historico',
      importe,
      tipo_regla: 'devolucion',
      automatica: false,
      usuario_id: devolucionDato?.usuario_id || devolucionDato?.autorizado_por || null,
      calidad: motivo ? 'completa' : 'parcial',
      origen_dato: 'devoluciones',
      detalle: {
        fecha: devolucionDato?.fecha || devolucionDato?.created_at || devolucionDato?.timestamp || null,
        fuente: devolucionDato?.fuente || null,
      },
    }));
  }

  const promocionesTotal = dinero(aplicaciones
    .filter(a => a.categoria === 'promocion').reduce((s, a) => s + a.importe, 0));
  const descuentosManuales = dinero(aplicaciones
    .filter(a => a.categoria === 'descuento_manual').reduce((s, a) => s + a.importe, 0));
  const descuentosNoClasificados = dinero(aplicaciones
    .filter(a => a.categoria === 'descuento_no_clasificado').reduce((s, a) => s + a.importe, 0));
  const totalNeto = dinero(numeroO(meta.totalNeto, numeroO(datos.total, 0)));
  const propinas = dinero(Math.max(0, numeroO(datos.propinas, numeroO(datos.propina, 0))));

  let descuadre = null;
  if (brutoProductos !== null) {
    const esperado = dinero(brutoProductos + envioBase - promocionesTotal
      - descuentosManuales - descuentosNoClasificados - rewards);
    descuadre = dinero(totalNeto - esperado);
    if (Math.abs(descuadre) > 0.02) {
      calidad = mayorCalidad(calidad, 'parcial');
      avisos.push(`Los componentes historicos no concilian con el total neto (diferencia ${descuadre.toFixed(2)}).`);
    }
  }

  return {
    folio, fecha, canal,
    calidad,
    avisos: [...new Set(avisos)],
    subtotal_historico: subtotal.monto,
    origen_subtotal: subtotal.origen,
    venta_bruta_productos: brutoProductos,
    envio_base: envioBase,
    envio_cobrado: envioCobrado,
    promociones_total: promocionesTotal,
    descuentos_manuales: descuentosManuales,
    descuentos_no_clasificados: descuentosNoClasificados,
    rewards,
    venta_neta: totalNeto,
    propinas,
    devoluciones: devolucion,
    descuadre,
    aplicaciones,
  };
}

function agruparAplicaciones(aplicaciones) {
  const grupos = new Map();
  for (const a of aplicaciones) {
    const clave = `${a.categoria}\u0000${a.concepto}`;
    if (!grupos.has(clave)) {
      grupos.set(clave, {
        categoria: a.categoria,
        concepto: a.concepto,
        ventas: new Set(),
        aplicaciones: 0,
        importe: 0,
        calidad: 'completa',
      });
    }
    const g = grupos.get(clave);
    g.ventas.add(a.folio);
    g.aplicaciones++;
    g.importe += a.importe;
    g.calidad = mayorCalidad(g.calidad, a.calidad);
  }
  return [...grupos.values()].map(g => ({
    categoria: g.categoria,
    concepto: g.concepto,
    ventas: g.ventas.size,
    aplicaciones: g.aplicaciones,
    importe: dinero(g.importe),
    calidad: g.calidad,
  })).sort((a, b) => b.importe - a.importe || a.concepto.localeCompare(b.concepto));
}

/** Agrega ventas ya reconocidas por las mismas reglas del corte. */
export function construirReporteFinanciero(ventas = [], ajustes = []) {
  const normalizadas = ventas.map(v => v?.aplicaciones ? v
    : normalizarVentaFinanciera(v?.datos || v || {}, v?.meta || {}));
  const aplicaciones = normalizadas.flatMap(v => v.aplicaciones || []);

  for (const a of ajustes || []) {
    const importe = dinero(a.monto_ajuste);
    if (importe <= 0) continue;
    const tipoAjuste = texto(a.tipo) || 'ajuste';
    aplicaciones.push(nuevaAplicacion({
      folio: texto(a.folio) || 'sin-folio', fecha: a.created_at || null,
      canal: texto(a.canal) || 'ajuste_administrativo',
    }, {
      categoria: tipoAjuste === 'devolucion' ? 'devolucion' : 'ajuste',
      concepto: texto(a.motivo) || `Ajuste ${tipoAjuste}`,
      importe,
      tipo_regla: texto(a.modo || tipoAjuste),
      porcentaje: numeroO(a.porcentaje),
      usuario_id: a.usuario_id || null,
      usuario: texto(a.usuario),
      automatica: false,
      calidad: 'completa',
      origen_dato: 'ajustes_cierre',
    }));
  }

  const suma = (campo) => dinero(normalizadas.reduce((s, v) => s + (numeroO(v[campo], 0) || 0), 0));
  const brutoCompleto = normalizadas.every(v => v.venta_bruta_productos !== null);
  const promociones = aplicaciones.filter(a => a.categoria === 'promocion');
  const manuales = aplicaciones.filter(a => a.categoria === 'descuento_manual');
  const noClasificados = aplicaciones.filter(a => a.categoria === 'descuento_no_clasificado');
  const rewards = aplicaciones.filter(a => a.categoria === 'rewards');
  const devoluciones = aplicaciones.filter(a => a.categoria === 'devolucion');
  const ajustesAplicados = aplicaciones.filter(a => a.categoria === 'ajuste');
  const total = (lista) => dinero(lista.reduce((s, a) => s + a.importe, 0));
  const promoAutomatica = promociones.filter(a => a.automatica === true);
  const promoCodigo = promociones.filter(a => a.automatica === false && a.codigo);
  const promoSinClasificar = promociones.filter(a => a.automatica === null
    || (a.automatica === false && !a.codigo && a.tipo_regla !== 'precio_especial'));

  const ventaNeta = suma('venta_neta');
  const brutoProductosTotal = suma('venta_bruta_productos');
  const envioBaseTotal = suma('envio_base');
  const devolucionesTotal = total(devoluciones);
  const ajustesTotal = total(ajustesAplicados);
  const resumen = {
    venta_bruta_productos: brutoProductosTotal,
    venta_bruta_antes_descuentos: brutoCompleto
      ? dinero(brutoProductosTotal + envioBaseTotal) : null,
    venta_bruta_completa: brutoCompleto,
    ventas_sin_bruto_determinable: normalizadas.filter(v => v.venta_bruta_productos === null).length,
    envio_base: envioBaseTotal,
    envio_cobrado: suma('envio_cobrado'),
    promociones_total: total(promociones),
    promociones_automaticas: total(promoAutomatica),
    promociones_codigo: total(promoCodigo),
    promociones_sin_clasificar: total(promoSinClasificar),
    descuentos_manuales: total(manuales),
    descuentos_no_clasificados: total(noClasificados),
    promociones_y_descuentos: dinero(total(promociones) + total(manuales) + total(noClasificados)),
    rewards: total(rewards),
    venta_neta: ventaNeta,
    propinas: suma('propinas'),
    devoluciones: devolucionesTotal,
    ajustes_posteriores: ajustesTotal,
    neto_conciliado: dinero(ventaNeta - devolucionesTotal - ajustesTotal),
  };

  const conceptos = agruparAplicaciones(aplicaciones);
  return {
    resumen,
    calidad: {
      completa: normalizadas.filter(v => v.calidad === 'completa').length,
      parcial: normalizadas.filter(v => v.calidad === 'parcial').length,
      no_determinable: normalizadas.filter(v => v.calidad === 'no_determinable').length,
      avisos: [...new Set(normalizadas.flatMap(v => v.avisos || []))],
    },
    conceptos,
    descuentos_por_concepto: conceptos.filter(c =>
      ['promocion', 'descuento_manual', 'descuento_no_clasificado'].includes(c.categoria)),
    aplicaciones,
  };
}
