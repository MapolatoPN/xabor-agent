// Servicio de aprendizaje automático del bot
// Analiza conversaciones de la semana, detecta fallos y genera sugerencias de mejora
// Las sugerencias se envían a Mario por WhatsApp para aprobación

import Anthropic from '@anthropic-ai/sdk';
import {
  obtenerMensajesRango,
  guardarSugerencias,
  obtenerSugerenciasPendientes,
  aprobarSugerencias,
  guardarOverride
} from './database.js';
import { enviarMensaje } from '../channels/whatsapp-meta.js';

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const MARIO_TELEFONO = process.env.MARIO_TELEFONO || '528781091115';

// ─── Agrupar mensajes por conversación (teléfono) ────────────────────────────
function agruparConversaciones(mensajes) {
  const convs = {};
  for (const m of mensajes) {
    if (!convs[m.telefono]) convs[m.telefono] = [];
    convs[m.telefono].push(m);
  }
  return Object.values(convs);
}

// ─── Detectar señales de fallo en una conversación ───────────────────────────
function detectarFallos(mensajes) {
  const textos = mensajes.map(m => m.texto);
  const señales = [];

  // Cliente dejó de responder después de pregunta del bot
  const ultimoMensaje = mensajes[mensajes.length - 1];
  if (ultimoMensaje?.direccion === 'saliente') {
    señales.push('cliente_no_respondio');
  }

  // Bot no supo responder algo
  if (textos.some(t => t.includes('<CONSULTA_PENDIENTE'))) {
    señales.push('consulta_sin_respuesta');
  }

  // Escalación a humano
  if (textos.some(t => t.includes('<ESCALAR_A_HUMANO>'))) {
    señales.push('escalacion_humano');
  }

  // Cliente preguntó lo mismo varias veces
  const preguntasCliente = mensajes.filter(m => m.direccion === 'entrante').map(m => m.texto);
  if (preguntasCliente.length >= 2) {
    const repetida = preguntasCliente.some((p, i) =>
      preguntasCliente.slice(i + 1).some(q =>
        q.toLowerCase().includes(p.toLowerCase().slice(0, 15))
      )
    );
    if (repetida) señales.push('pregunta_repetida');
  }

  // Palabras de frustración
  const frustacion = ['no entiendes', 'no me ayudas', 'mal', 'pésimo', 'qué pena', 'inútil', 'no sirves'];
  if (textos.some(t => frustacion.some(f => t.toLowerCase().includes(f)))) {
    señales.push('frustracion_cliente');
  }

  return señales;
}

// ─── Analizar semana y generar sugerencias ────────────────────────────────────
export async function analizarSemana() {
  console.log('[Learner] Iniciando análisis semanal...');

  const hasta = new Date();
  const desde = new Date(hasta);
  desde.setDate(desde.getDate() - 7);

  const mensajes = await obtenerMensajesRango(desde.toISOString(), hasta.toISOString());

  if (mensajes.length < 5) {
    console.log('[Learner] Pocas conversaciones esta semana, omitiendo análisis.');
    return;
  }

  const conversaciones = agruparConversaciones(mensajes);
  const conFallos = conversaciones.filter(c => detectarFallos(c).length > 0);

  console.log(`[Learner] ${conversaciones.length} conversaciones, ${conFallos.length} con fallos detectados.`);

  if (conFallos.length === 0) {
    await enviarMensaje(MARIO_TELEFONO,
      '📊 *Reporte semanal del bot*\n\nEsta semana el bot no tuvo fallos detectables. ¡Todo bien! 🎉'
    );
    return;
  }

  // Preparar resumen de conversaciones con fallos para Claude
  const resumenConvs = conFallos.slice(0, 10).map((conv, i) => {
    const fallos = detectarFallos(conv);
    const dialogo = conv.map(m =>
      `${m.direccion === 'entrante' ? 'Cliente' : 'Bot'}: ${m.texto.slice(0, 200)}`
    ).join('\n');
    return `--- Conversación ${i + 1} (fallos: ${fallos.join(', ')}) ---\n${dialogo}`;
  }).join('\n\n');

  // Pedir a Claude que genere sugerencias concretas
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 1500,
    messages: [{
      role: 'user',
      content: `Eres un experto en optimización de chatbots para restaurantes mexicanos.

Analiza estas conversaciones reales del bot de Xabor (restaurante en México) donde se detectaron problemas:

${resumenConvs}

Genera exactamente 3 a 5 sugerencias concretas para mejorar el comportamiento del bot. Cada sugerencia debe:
1. Ser un cambio específico al prompt del bot (texto exacto a agregar o modificar)
2. Dirigirse a un problema real observado en las conversaciones
3. Estar en español mexicano natural
4. Ser breve (máximo 2 oraciones)

Responde SOLO en este formato JSON:
{
  "sugerencias": [
    {
      "titulo": "título corto del problema",
      "problema": "qué falló",
      "mejora": "texto exacto a agregar al prompt del bot"
    }
  ]
}`
    }]
  });

  let sugerencias;
  try {
    const texto = response.content[0].text;
    const jsonMatch = texto.match(/\{[\s\S]*\}/);
    sugerencias = JSON.parse(jsonMatch[0]).sugerencias;
  } catch (e) {
    console.error('[Learner] Error parseando sugerencias:', e.message);
    return;
  }

  // Guardar en DB
  const semana = desde.toISOString().split('T')[0];
  const id = await guardarSugerencias(semana, sugerencias);

  // Enviar a Mario por WhatsApp
  let mensaje = `📊 *Reporte semanal del bot Xabor*\n`;
  mensaje += `Semana del ${semana}\n`;
  mensaje += `${conversaciones.length} conversaciones, ${conFallos.length} con problemas.\n\n`;
  mensaje += `*Sugerencias de mejora:*\n\n`;

  sugerencias.forEach((s, i) => {
    mensaje += `*${i + 1}. ${s.titulo}*\n`;
    mensaje += `Problema: ${s.problema}\n`;
    mensaje += `Mejora: _${s.mejora}_\n\n`;
  });

  mensaje += `Para aprobar, responde: *APROBAR ${id} 1,2,3* (los números que quieras aplicar)\n`;
  mensaje += `Para rechazar todo: *RECHAZAR ${id}*`;

  await enviarMensaje(MARIO_TELEFONO, mensaje);
  console.log(`[Learner] Sugerencias enviadas a Mario. ID: ${id}`);
}

// ─── Procesar respuesta de aprobación de Mario ───────────────────────────────
export async function procesarAprobacion(texto) {
  const textoUpper = texto.trim().toUpperCase();

  // APROBAR {id} {indices}
  const matchAprobar = textoUpper.match(/^APROBAR\s+(\d+)\s+([\d,\s]+)$/);
  if (matchAprobar) {
    const id = parseInt(matchAprobar[1]);
    const indices = matchAprobar[2].split(',').map(n => parseInt(n.trim()) - 1);

    const pendiente = await obtenerSugerenciasPendientes();
    if (!pendiente || pendiente.id !== id) {
      await enviarMensaje(MARIO_TELEFONO, `No encontré sugerencias pendientes con ID ${id}.`);
      return true;
    }

    const sugerencias = pendiente.sugerencias;
    const aprobadas = indices.filter(i => i >= 0 && i < sugerencias.length).map(i => sugerencias[i]);

    // Aplicar cada mejora aprobada como override
    for (const s of aprobadas) {
      await guardarOverride(`aprendizaje_${Date.now()}`, s.mejora);
    }

    await aprobarSugerencias(id, indices);

    await enviarMensaje(MARIO_TELEFONO,
      `✅ Aplicadas ${aprobadas.length} mejoras al bot. Ya están activas.\n\n` +
      aprobadas.map((s, i) => `${i + 1}. ${s.titulo}`).join('\n')
    );
    return true;
  }

  // RECHAZAR {id}
  const matchRechazar = textoUpper.match(/^RECHAZAR\s+(\d+)$/);
  if (matchRechazar) {
    const id = parseInt(matchRechazar[1]);
    await aprobarSugerencias(id, []);
    await enviarMensaje(MARIO_TELEFONO, `Entendido, sugerencias ${id} descartadas.`);
    return true;
  }

  return false; // No era un comando de aprobación
}
