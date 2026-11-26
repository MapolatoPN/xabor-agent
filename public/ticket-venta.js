(function () {
  'use strict';
  const imprimir = document.getElementById('ticket-imprimir');
  if (imprimir) imprimir.addEventListener('click', () => window.print());
  const form = document.getElementById('ticket-correo');
  if (!form) return;
  const email = document.getElementById('ticket-email');
  const boton = document.getElementById('ticket-enviar');
  const mensaje = document.getElementById('ticket-mensaje');
  const disponible = !boton.disabled;
  const solicitudes = new Map();
  const enviados = new Set();
  let enCurso = false;
  const destinatario = () => email.value.trim().toLowerCase();
  email.addEventListener('input', () => {
    if (!enCurso) {
      boton.disabled = !disponible || enviados.has(destinatario());
      boton.textContent = enviados.has(destinatario()) ? 'Correo enviado' : 'Enviar por correo';
      mensaje.textContent = '';
    }
  });
  form.addEventListener('submit', async ev => {
    ev.preventDefault();
    if (enCurso || !disponible || enviados.has(destinatario()) || !form.reportValidity()) return;
    const to = destinatario();
    if (!solicitudes.has(to)) solicitudes.set(to, crypto.randomUUID());
    enCurso = true; boton.disabled = true; email.disabled = true;
    boton.textContent = 'Enviando…'; mensaje.textContent = ''; mensaje.classList.remove('error');
    try {
      const r = await fetch(form.dataset.endpoint, {
        method: 'POST', credentials: 'same-origin', signal: AbortSignal.timeout(20000),
        headers: { 'Content-Type': 'application/json', 'X-Xabor-Accion': 'enviar-ticket', 'X-Xabor-Negocio': form.dataset.negocio },
        body: JSON.stringify({ email: to, token: form.dataset.token, solicitudId: solicitudes.get(to) }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.enviado) throw Error(d.error || 'No se confirmó el envío. Puedes intentarlo de nuevo.');
      enviados.add(to);
      mensaje.textContent = `Correo enviado a ${to}. La entrega puede tardar unos minutos.`;
    } catch (e) {
      mensaje.classList.add('error');
      mensaje.textContent = ['TimeoutError', 'AbortError', 'TypeError'].includes(e.name)
        ? 'No se confirmó el envío. Reintenta con el mismo correo para recuperar la confirmación.'
        : e.message;
    } finally {
      enCurso = false; email.disabled = false;
      boton.disabled = enviados.has(to); boton.textContent = enviados.has(to) ? 'Correo enviado' : 'Reintentar envío';
    }
  });
})();
