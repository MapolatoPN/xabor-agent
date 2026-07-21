// Maneja el estado de cada conversación activa
// Una sesión = una llamada o un chat de WhatsApp

const sessions = new Map();

export function getSession(sessionId) {
  if (!sessions.has(sessionId)) {
    sessions.set(sessionId, createSession(sessionId));
  }
  return sessions.get(sessionId);
}

export function deleteSession(sessionId) {
  sessions.delete(sessionId);
}

export function getAllSessions() {
  return Array.from(sessions.values());
}

function createSession(sessionId) {
  return {
    id: sessionId,
    canal: 'desconocido', // 'voz' | 'whatsapp' | 'test'
    estado: 'inicio',    // 'inicio' | 'tomando_pedido' | 'confirmando' | 'finalizado'
    mensajes: [],        // historial de conversación para Claude
    pedido: {
      items: [],         // [{ id, nombre, cantidad, precio_unitario, notas }]
      cliente: {
        nombre: null,
        telefono: null
      },
      modalidad: null,   // 'recoger' | 'entrega a domicilio'
      total: 0
    },
    creado_en: new Date().toISOString(),
    actualizado_en: new Date().toISOString()
  };
}

export function agregarMensaje(sessionId, rol, contenido) {
  const session = getSession(sessionId);
  session.mensajes.push({ role: rol, content: contenido });
  session.actualizado_en = new Date().toISOString();
  return session;
}

export function actualizarEstado(sessionId, nuevoEstado) {
  const session = getSession(sessionId);
  session.estado = nuevoEstado;
  session.actualizado_en = new Date().toISOString();
}
