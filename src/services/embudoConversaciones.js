import { normalizarTelefonoMX } from '../utils/telefono.js';
const claveTelefono = t => normalizarTelefonoMX(t) || String(t || '');

// Cuenta conversaciones, no mensajes. Formulario de WhatsApp y tienda web
// se informan por separado. Un registro cancelado no es una venta entregada.
export function analizarEmbudo({ mensajes = [], pedidos = [], intervenciones = [] } = {}) {
  const grupos = new Map();
  for (const m of mensajes) {
    const tel = claveTelefono(m.telefono);
    if (!grupos.has(tel)) grupos.set(tel, []);
    grupos.get(tel).push(m);
  }
  const resumen = { conversaciones: grupos.size, mensajes: mensajes.length,
    formularioOfrecido: 0, formularioOfrecidoSinConfirmacion: 0,
    formulariosConfirmados: 0, formulariosRecibidos: 0, atencionHumana: 0,
    formularioYHumano: 0, atencionHumanaSinFormulario: 0, formularioSinHumano: 0,
    formularioEntregado: 0, formularioCanceladoSinRecuperacion: 0, formularioRecuperadoManual: 0,
    tiendaEntregadaConConversacion: 0, tiendaEntregadaSinConversacion: 0, motivosIntervencion: {} };
  for (const [tel, chat] of grupos) {
    const humano = chat.some(m => m.origen === 'humano' && m.direccion === 'saliente');
    const recibido = chat.some(m => /Formulario recibido/.test(m.texto));
    const ofrecido = chat.some(m => m.origen === 'bot' && /\*Haz tu pedido\*/.test(m.texto));
    const folios = new Set(chat.filter(m => m.origen === 'bot' && /qued[oó] registrado/.test(m.texto))
      .flatMap(m => m.texto.match(/XAB-\d+/g) || []));
    const relacionados = pedidos.filter(p => claveTelefono(p.telefono) === tel);
    const porFormulario = relacionados.filter(p => folios.has(p.folio) && p.canal === 'whatsapp');
    const confirmado = recibido && porFormulario.length > 0;
    if (recibido) resumen.formulariosRecibidos++;
    if (ofrecido) resumen.formularioOfrecido++;
    if (ofrecido && !confirmado) resumen.formularioOfrecidoSinConfirmacion++;
    if (confirmado) resumen.formulariosConfirmados++;
    if (humano) resumen.atencionHumana++;
    if (confirmado && humano) resumen.formularioYHumano++;
    if (humano && !confirmado) resumen.atencionHumanaSinFormulario++;
    if (confirmado && !humano) resumen.formularioSinHumano++;
    if (confirmado) {
      if (porFormulario.some(p => p.estado === 'entregado')) resumen.formularioEntregado++;
      else if (relacionados.some(p => p.origen === 'manual' && p.estado === 'entregado'
        && p.creado >= porFormulario[0].creado)) resumen.formularioRecuperadoManual++;
      else if (porFormulario.every(p => p.estado === 'cancelado')) resumen.formularioCanceladoSinRecuperacion++;
    }
    if (relacionados.some(p => p.canal === 'tienda_online' && p.estado === 'entregado')) resumen.tiendaEntregadaConConversacion++;
    // Son motivos registrados, no una atribución inferida leyendo palabras.
    for (const motivo of new Set(intervenciones.filter(i => claveTelefono(i.telefono)===tel).map(i => i.motivo).filter(Boolean))) {
      resumen.motivosIntervencion[motivo] = (resumen.motivosIntervencion[motivo] || 0) + 1;
    }
  }
  resumen.tiendaEntregadaSinConversacion = pedidos.filter(p => p.canal === 'tienda_online'
    && p.estado === 'entregado' && !grupos.has(claveTelefono(p.telefono))).length;
  return resumen;
}

export function validarPeriodo(desde, hasta) {
  for (const d of [desde,hasta]) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d || '') || Number.isNaN(Date.parse(d))
      || new Date(d).toISOString().slice(0,10) !== d) throw Error('Fechas YYYY-MM-DD válidas requeridas');
  }
  if (hasta <= desde || Date.parse(hasta)-Date.parse(desde)>31*86400000) throw Error('Periodo de 1 a 31 días requerido; hasta es exclusivo');
}

export async function consultarEmbudo(db, { slug, desde, hasta }) {
  validarPeriodo(desde,hasta);
  if (!slug) throw Error('Slug de negocio requerido');
  await db.query('BEGIN READ ONLY');
  try {
    await db.query("SET LOCAL statement_timeout='20s'");
    const { rows: [n] } = await db.query(`SELECT n.id,n.nombre,c.valor zona FROM negocios n
      JOIN configuracion c ON c.negocio_id=n.id AND c.clave='timezone' WHERE n.slug=$1`,[slug]);
    if (!n) throw Error('Negocio o zona horaria no encontrado');
    // Usar límites [desde,hasta) y convertir UTC explícitamente: las columnas
    // históricas son timestamp SIN zona; no dependen del TZ de Node o Windows.
    const rango = columna => `${columna}>= (($2::date::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC')
      AND ${columna}< (($3::date::timestamp AT TIME ZONE $4) AT TIME ZONE 'UTC')`;
    const params = [n.id,desde,hasta,n.zona];
    const { rows: mensajes } = await db.query(`SELECT telefono,direccion,origen,texto,
      to_char((timestamp AT TIME ZONE 'UTC') AT TIME ZONE $4,'YYYY-MM-DD') dia
      FROM mensajes WHERE negocio_id=$1 AND ${rango('timestamp')} ORDER BY id`,params);
    const { rows: pedidos } = await db.query(`SELECT folio,estado,datos->>'canal' canal,datos->>'origen' origen,
      COALESCE(datos->>'telefono_conversacion',datos->'cliente'->>'telefono') telefono,
      to_char((created_at AT TIME ZONE 'UTC') AT TIME ZONE $4,'YYYY-MM-DD') dia,
      to_char(created_at,'YYYY-MM-DD HH24:MI:SS.US') creado FROM pedidos_activos
      WHERE negocio_id=$1 AND ${rango('created_at')} ORDER BY created_at`,params);
    const { rows: intervenciones } = await db.query(`SELECT DISTINCT m.telefono,t.motivo_handoff motivo,
      to_char(t.created_at AT TIME ZONE $4,'YYYY-MM-DD') dia
      FROM agente_turnos t JOIN mensajes m ON m.negocio_id=t.negocio_id AND m.message_id_externo=ANY(t.wamids)
      WHERE t.negocio_id=$1 AND t.modo='productivo' AND t.motivo_handoff IS NOT NULL
        AND t.created_at>=($2::date::timestamp AT TIME ZONE $4)
        AND t.created_at<($3::date::timestamp AT TIME ZONE $4)`,params);
    return { negocio:n.nombre,desde,hastaExclusivo:hasta,zona:n.zona,fuentes:['mensajes','pedidos_activos','agente_turnos'],
      total:analizarEmbudo({mensajes,pedidos,intervenciones}),
      porDia:[...new Set(mensajes.map(m=>m.dia))].sort().map(dia=>({dia,
        ...analizarEmbudo({mensajes:mensajes.filter(m=>m.dia===dia),pedidos:pedidos.filter(p=>p.dia===dia),
          intervenciones:intervenciones.filter(i=>i.dia===dia)})})) };
  } finally { await db.query('ROLLBACK'); }
}
