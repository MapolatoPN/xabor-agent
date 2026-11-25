// Interfaz del Superadmin. Las escrituras siguen usando las rutas auditadas;
// los filtros de procedencia son solo lectura y no alteran ninguna cuenta.
let CE_SOLICITUD = 0;
let CE_BUSQUEDA_TIMER;
let FICHA_SOLICITUD = 0;
let FICHA_NOMBRE = '';
let FICHA_DATOS = null;
const PLANES_ETIQUETAS = { prueba: 'Prueba comercial', basico: 'Básico', pro: 'Pro', personalizado: 'Personalizado' };
const REVISION_ETIQUETAS = { prueba_tecnica: 'Prueba técnica', piloto: 'Piloto', sin_senales: 'Sin señales de prueba' };
const numeroConsola = valor => (Number(valor) || 0).toLocaleString('es-MX');
const planConsola = valor => PLANES_ETIQUETAS[valor] || valor || 'Sin plan';

function badgeRevision(datos) {
  const revision = datos?.revision_datos;
  if (!revision || !REVISION_ETIQUETAS[revision.tipo]) return '';
  return `<span class="badge badge-${revision.tipo}" title="${escaparHTML(revision.evidencia || '')}">${REVISION_ETIQUETAS[revision.tipo]}</span>`;
}

function programarBusquedaCentral() {
  clearTimeout(CE_BUSQUEDA_TIMER);
  CE_SOLICITUD++; // invalida también la respuesta que ya esté en vuelo
  document.getElementById('ce-contexto').textContent = 'Buscando…';
  CE_BUSQUEDA_TIMER = setTimeout(() => cargarCentral(), 280);
}

function limpiarCamposCentral() {
  for (const id of ['ce-buscar', 'ce-revision', 'ce-estado', 'ce-plan', 'ce-atencion', 'ce-onboarding']) document.getElementById(id).value = '';
  document.getElementById('ce-orden').value = 'created_at';
  CE_OFFSET = 0;
}

function limpiarFiltrosCentral() { limpiarCamposCentral(); cargarCentral(); }

function abrirCartera(revision = '', atencion = '') {
  limpiarCamposCentral();
  document.getElementById('ce-revision').value = revision;
  document.getElementById('ce-atencion').value = atencion;
  if (atencion) document.querySelector('.filter-extras').open = true;
  irVista('central');
}

async function cargarCentral(mantenerPagina) {
  clearTimeout(CE_BUSQUEDA_TIMER);
  if (!mantenerPagina) CE_OFFSET = 0;
  const solicitud = ++CE_SOLICITUD;
  const offset = CE_OFFSET;
  const q = new URLSearchParams({ limit: CE_LIMIT, offset });
  for (const clave of ['buscar', 'revision', 'estado', 'plan', 'atencion', 'onboarding', 'orden']) q.set(clave, document.getElementById('ce-' + clave).value);
  const tbody = document.getElementById('ce-tabla');
  tbody.setAttribute('aria-busy', 'true');
  tbody.innerHTML = '<tr><td colspan="6" class="empty">Cargando negocios…</td></tr>';
  document.getElementById('ce-contexto').textContent = 'Consultando…';
  document.getElementById('ce-prev').disabled = true;
  document.getElementById('ce-next').disabled = true;
  try {
    const r = await api('/api/superadmin/central/negocios?' + q);
    if (!r.ok) throw new Error('No se pudo consultar la lista');
    const { total, negocios } = await r.json();
    if (solicitud !== CE_SOLICITUD) return;
    if (offset > 0 && offset >= total) { CE_OFFSET = Math.max(0, Math.ceil(total / CE_LIMIT) - 1) * CE_LIMIT; return cargarCentral(true); }
    tbody.innerHTML = negocios.length ? negocios.map(n => `<tr>
      <td data-label="Negocio"><button class="business-name" onclick="abrirFicha('${n.id}')">${escaparHTML(n.nombre)}</button><small>${escaparHTML(n.slug)}</small>${badgeRevision(n)}</td>
      <td data-label="Cuenta">${badgeEstado(n.estado)}<small>${n.admin_con_acceso ? (n.estado === 'suspendido' ? 'Acceso suspendido' : 'Administrador con contraseña') : 'Sin administrador con acceso'}</small></td>
      <td data-label="Plan">${escaparHTML(planConsola(n.plan))}</td>
      <td data-label="Actividad">${numeroConsola(n.num_pedidos)} pedidos<small>${numeroConsola(n.num_productos)} productos · ${n.ultima_actividad ? fechaCorta(n.ultima_actividad) : 'Sin pedidos registrados'}</small></td>
      <td data-label="Seguimiento">${escaparHTML(n.siguiente_accion || 'Sin siguiente acción')}<small>${Number(n.num_bloqueantes) ? numeroConsola(n.num_bloqueantes) + ' bloqueos · ' : ''}${escaparHTML(n.responsable_implementacion || 'Sin responsable')}</small></td>
      <td><button class="btn secundario" onclick="abrirFicha('${n.id}')" aria-label="Abrir ficha de ${escaparHTML(n.nombre)}">Abrir ficha</button></td>
    </tr>`).join('') : '<tr><td colspan="6" class="empty">No hay negocios con estos filtros.<br><button class="btn secundario" onclick="limpiarFiltrosCentral()">Limpiar filtros</button></td></tr>';
    const filtro = REVISION_ETIQUETAS[q.get('revision')] || 'Todos los negocios';
    document.getElementById('ce-contexto').textContent = `${numeroConsola(total)} ${Number(total) === 1 ? 'negocio' : 'negocios'} · ${filtro}`;
    document.getElementById('ce-pagina').textContent = `Página ${Math.floor(offset / CE_LIMIT) + 1} de ${Math.max(1, Math.ceil(total / CE_LIMIT))}`;
    document.getElementById('ce-prev').disabled = offset === 0;
    document.getElementById('ce-next').disabled = offset + CE_LIMIT >= total;
  } catch (e) {
    if (solicitud !== CE_SOLICITUD) return;
    tbody.innerHTML = '<tr><td colspan="6" class="empty error-state">No se pudieron cargar los negocios. Intenta nuevamente.<br><button class="btn secundario" onclick="cargarCentral(true)">Reintentar</button></td></tr>';
    document.getElementById('ce-contexto').textContent = 'La consulta falló; los resultados anteriores se ocultaron.';
    document.getElementById('ce-pagina').textContent = '';
  } finally { if (solicitud === CE_SOLICITUD) tbody.setAttribute('aria-busy', 'false'); }
}

function renderDashboard(d) {
  const rd = d.resumenDatos || {};
  document.getElementById('da-stats').innerHTML = [
    [d.totalNegocios, 'Negocios registrados', 'Incluye pruebas y pilotos', ''],
    [rd.sinSenales, 'Sin señales de prueba', 'Revisar cartera comercial', 'sin_senales'],
    [rd.pruebas, 'Pruebas técnicas', 'Coinciden con pruebas del sistema', 'prueba_tecnica'],
    [rd.pilotos, 'Pilotos', 'Cuentas de validación comercial', 'piloto'],
  ].map(([n, label, ayuda, filtro]) => `<button class="stat ${filtro === 'prueba_tecnica' ? 'signal' : ''}" onclick="abrirCartera('${filtro}')"><div class="num">${numeroConsola(n)}</div><div class="lbl">${label}</div><small>${ayuda} →</small></button>`).join('');
  document.getElementById('da-totales').textContent = `${numeroConsola(d.activos)} cuentas activas · ${numeroConsola(d.pendientes)} pendientes · ${numeroConsola(d.suspendidos)} suspendidas · ${numeroConsola(d.totalUsuarios)} usuarios · ${numeroConsola(d.totalSucursales)} sucursales. Cuenta activa no significa suscripción pagada.`;
  document.getElementById('da-revision').innerHTML = `<strong>Datos de prueba separados para revisar.</strong> Las coincidencias se basan en nombre y clave de pruebas conocidas. Las cuentas conservan su acceso y sus datos. «Sin señales» tampoco confirma que exista una contratación.
    ${Number(rd.accesosPruebaPlataforma) ? `<p><strong>Revisar seguridad:</strong> ${numeroConsola(rd.accesosPruebaPlataforma)} ${Number(rd.accesosPruebaPlataforma) === 1 ? 'usuario vinculado a pruebas técnicas conserva' : 'usuarios vinculados a pruebas técnicas conservan'} privilegios activos de plataforma. Revisa sus permisos antes de retirar cuentas.</p>` : ''}
    <div class="actions" style="margin-top:12px"><button class="btn secundario" onclick="abrirCartera('prueba_tecnica')">Revisar pruebas técnicas</button></div>`;
  const fila = (n, detalle) => `<button class="fila-lista" onclick="abrirFicha('${n.id}')"><span><strong>${escaparHTML(n.nombre)}</strong><small>${detalle}</small></span><span>Abrir →</span></button>`;
  document.getElementById('da-recientes').innerHTML = d.recientes.length ? d.recientes.map(n => fila(n, `${escaparHTML(planConsola(n.plan))} · Alta ${fechaCorta(n.created_at)}`)).join('') : '<p class="empty">Sin altas recientes en esta categoría.</p>';
  document.getElementById('da-sin-admin').innerHTML = d.sinAdministrador.length ? d.sinAdministrador.map(n => fila(n, 'Revisar administrador y acceso')).join('') : '<p class="empty">Sin pendientes de este tipo.</p>';
  const sinMenu = d.sinMenu || [];
  document.getElementById('da-sin-instalar').innerHTML = sinMenu.length ? sinMenu.map(n => fila(n, 'Sin productos en el catálogo')).join('') : '<p class="empty">Sin pendientes de este tipo.</p>';
}

async function abrirFicha(negocioId) {
  const solicitud = ++FICHA_SOLICITUD;
  if (FICHA_NEGOCIO_ID !== negocioId) document.querySelectorAll('#vista-ficha details').forEach(d => { d.open = false; });
  FICHA_NEGOCIO_ID = negocioId;
  FICHA_DATOS = null;
  document.querySelectorAll('.vista').forEach(v => v.classList.remove('activa'));
  document.getElementById('vista-ficha').classList.add('activa');
  document.querySelectorAll('nav .tab').forEach(b => b.classList.toggle('activo', b.dataset.tab === 'central'));
  document.getElementById('fi-contenido').hidden = true;
  document.getElementById('fi-titulo').textContent = 'Cargando negocio…';
  document.getElementById('fi-subtitulo').textContent = '';
  document.getElementById('fi-error').innerHTML = '';
  try {
    const r = await api(`/api/superadmin/negocios/${negocioId}/ficha`);
    if (!r.ok) throw new Error('No se pudo cargar');
    const f = await r.json();
    if (solicitud !== FICHA_SOLICITUD) return;
    FICHA_DATOS = f;
    FICHA_NOMBRE = f.general.nombre;
    document.getElementById('fi-titulo').textContent = FICHA_NOMBRE;
    document.getElementById('fi-subtitulo').textContent = `${f.general.slug} · Alta ${fechaCorta(f.general.fecha_alta)}`;
    document.getElementById('fi-revision').innerHTML = `${badgeRevision(f.general)} <span>${escaparHTML(f.general.revision_datos?.evidencia || '')}</span>`;
    document.getElementById('fi-stats').innerHTML = `
      <div class="stat"><div class="num">${badgeEstado(f.general.estado)}</div><div class="lbl">Estado de la cuenta</div></div>
      <div class="stat"><div class="num">${escaparHTML(planConsola(f.general.plan))}</div><div class="lbl">Plan comercial</div></div>
      <div class="stat"><div class="num">${numeroConsola(f.operacion.pedidos_totales)}</div><div class="lbl">Pedidos registrados</div></div>
      <div class="stat"><div class="num">${numeroConsola(f.configuracion.menu_productos)}</div><div class="lbl">Productos del catálogo</div></div>`;
    const inv = f.cuenta.invitacion;
    const admin = f.cuenta.admin_principal;
    document.getElementById('fi-cuenta').innerHTML = `
      <p><strong>Administrador:</strong> ${admin ? escaparHTML(admin.nombre) + '<br>' + escaparHTML(admin.email) : 'Sin administrador activo'}</p>
      <p>${admin?.tiene_password ? 'Administrador con contraseña creada.' : 'El administrador todavía no tiene acceso.'}</p>
      <p><strong>Invitación:</strong> ${inv.enviada ? (inv.aceptada ? 'Aceptada' : (inv.vigente ? 'Vigente hasta ' + new Date(inv.expira_at).toLocaleString('es-MX') : 'Expirada o revocada')) : 'Sin invitación registrada'}</p>
      <p><strong>Usuarios activos:</strong> ${numeroConsola(f.cuenta.num_usuarios)}</p>`;
    document.getElementById('fi-siguiente').innerHTML = `<p>${escaparHTML(f.implementacion.siguiente_accion || 'Sin siguiente acción registrada.')}</p><p class="muted-line">Responsable: ${escaparHTML(f.general.responsable_implementacion || 'Sin asignar')}${f.implementacion.fecha_objetivo ? '<br>Fecha objetivo: ' + escaparHTML(f.implementacion.fecha_objetivo) : ''}</p>`;
    document.getElementById('fi-checklist').innerHTML = '<table><thead><tr><th>Paso</th><th>Estado</th><th>Tipo</th><th>Responsable</th><th>Notas</th><th></th></tr></thead><tbody>' + f.checklist_operativo.map(p => `<tr>
      <td>${escaparHTML(p.clave.replace(/_/g, ' '))}</td><td>${escaparHTML(p.estado.replace(/_/g, ' '))}</td><td>${p.automatico ? 'Automático' : 'Manual'}</td><td>${escaparHTML(p.responsable || '—')}</td><td>${escaparHTML(p.notas || '—')}</td><td>${p.automatico ? '' : `<button class="btn secundario" onclick="marcarPaso('${p.clave}')">Actualizar</button>`}</td></tr>`).join('') + '</tbody></table>';
    document.getElementById('fi-impl').innerHTML = `<p><strong>Etapa de instalación:</strong> ${escaparHTML(CE_ETIQUETAS_ONBOARDING[f.implementacion.onboarding_estado] || f.implementacion.onboarding_estado)} · ${numeroConsola(f.implementacion.progreso)}% del checklist</p>
      <p><strong>Responsable:</strong> ${escaparHTML(f.general.responsable_implementacion || 'Sin asignar')} · <strong>Comercial:</strong> ${escaparHTML(f.general.responsable_comercial || 'Sin asignar')}</p>
      <p><strong>Bloqueos:</strong> ${f.implementacion.bloqueantes.length ? f.implementacion.bloqueantes.map(escaparHTML).join(' · ') : 'Ninguno registrado'}</p><p><strong>Notas:</strong> ${escaparHTML(f.implementacion.notas || 'Sin notas')}</p>
      <div class="actions"><button class="btn secundario" onclick="editarImplementacion()">Editar seguimiento</button><button class="btn secundario" onclick="cambiarOnboarding()">Cambiar etapa</button></div>`;
    document.getElementById('fi-acciones').innerHTML = `
      <button class="btn secundario" onclick="verDetalleNegocio(FICHA_NEGOCIO_ID)">Configuración avanzada</button>
      ${admin && !admin.tiene_password ? '<button class="btn secundario" onclick="reenviarInvitacionFicha(FICHA_NEGOCIO_ID)">Reenviar invitación</button>' : ''}
      <button class="btn secundario" onclick="entrarComoSoporte(FICHA_NEGOCIO_ID, FICHA_NOMBRE)">Entrar como soporte</button>
      <button class="btn peligro" onclick="cambiarEstadoNegocioFicha('${f.general.estado === 'suspendido' ? 'activo' : 'suspendido'}')">${f.general.estado === 'suspendido' ? 'Reactivar negocio' : 'Suspender negocio'}</button>`;
    renderEdicionNegocio(f);
    document.getElementById('fi-contenido').hidden = false;
    cargarInvitacionesFicha(negocioId);
  } catch (e) {
    if (solicitud !== FICHA_SOLICITUD) return;
    document.getElementById('fi-titulo').textContent = 'No se pudo abrir la ficha';
    document.getElementById('fi-error').innerHTML = '<p class="notice error-state">No se cargaron los datos. Las acciones permanecen ocultas.</p><button class="btn secundario" onclick="abrirFicha(FICHA_NEGOCIO_ID)">Reintentar</button>';
  }
}

function editarImplementacion() { mostrarDialogoSeguimiento('implementacion'); }
function cambiarOnboarding() { mostrarDialogoSeguimiento('onboarding'); }
function marcarPaso(clave) { mostrarDialogoSeguimiento('checklist-operativo', clave); }

function mostrarDialogoSeguimiento(tipo, clave) {
  if (!FICHA_DATOS) return;
  const f = FICHA_DATOS;
  const paso = tipo === 'checklist-operativo' ? f.checklist_operativo.find(p => p.clave === clave && !p.automatico) : null;
  if (tipo === 'checklist-operativo' && !paso) return;
  const anterior = document.getElementById('seguimiento-dialogo');
  if (anterior) anterior.remove();
  const dialogo = document.createElement('dialog');
  dialogo.id = 'seguimiento-dialogo';
  dialogo.className = 'tracking-dialog';
  dialogo.setAttribute('aria-labelledby', 'seguimiento-titulo');
  const campos = paso ? `
    <label>Estado<select name="estado">${['pendiente','en_proceso','bloqueado','completado','no_aplica'].map(v => `<option value="${v}" ${paso.estado === v ? 'selected' : ''}>${v.replace(/_/g, ' ')}</option>`).join('')}</select></label>
    <label>Responsable<input name="responsable" value="${escaparHTML(paso.responsable || '')}"></label>
    <label>Fecha<input type="date" name="fecha" value="${escaparHTML(paso.fecha || new Date().toISOString().slice(0, 10))}"></label>
    <label class="full">Notas<textarea name="notas" rows="4">${escaparHTML(paso.notas || '')}</textarea></label>` : tipo === 'implementacion' ? `
    <label>Responsable de implementación<input name="responsable_implementacion" value="${escaparHTML(f.general.responsable_implementacion || '')}"></label>
    <label>Fecha objetivo<input type="date" name="fecha_objetivo" value="${escaparHTML((f.implementacion.fecha_objetivo || '').slice(0, 10))}"></label>
    <label class="full">Siguiente acción<input name="siguiente_accion" value="${escaparHTML(f.implementacion.siguiente_accion || '')}"></label>
    <label class="full">Notas<textarea name="notas" rows="4">${escaparHTML(f.implementacion.notas || '')}</textarea></label>`
    : `<label class="full">Nueva etapa<select name="estado" required><option value="">Elige una etapa manual</option>${Object.entries(CE_ETIQUETAS_ONBOARDING).filter(([v]) => !['invitacion_enviada', 'cuenta_creada', 'configuracion_en_proceso'].includes(v)).map(([valor, label]) => `<option value="${valor}" ${f.implementacion.onboarding_estado === valor ? 'selected' : ''}>${label}</option>`).join('')}</select></label><p class="muted-line full">Las etapas automáticas dependen del registro y acceso. Cambiar esta etapa no cambia la suscripción ni el acceso de la cuenta.</p>`;
  const titulo = paso ? 'Actualizar paso: ' + paso.clave.replace(/_/g, ' ') : tipo === 'implementacion' ? 'Editar seguimiento' : 'Cambiar etapa de instalación';
  dialogo.innerHTML = `<form><p class="eyebrow">${escaparHTML(f.general.nombre)}</p><h2 id="seguimiento-titulo">${escaparHTML(titulo)}</h2><div class="field-grid">${campos}</div><p id="seguimiento-error" class="feedback err" role="status"></p><div class="actions"><button type="submit" class="btn">Guardar cambios</button><button type="button" class="btn secundario" onclick="document.getElementById('seguimiento-dialogo').close()">Cancelar</button></div></form>`;
  const id = f.general.id;
  dialogo.querySelector('form').addEventListener('submit', async e => {
    e.preventDefault();
    const boton = dialogo.querySelector('[type=submit]');
    boton.disabled = true;
    const datos = Object.fromEntries(new FormData(e.target));
    if ('fecha_objetivo' in datos && !datos.fecha_objetivo) datos.fecha_objetivo = null;
    try {
      const ruta = paso ? `${tipo}/${paso.clave}` : tipo;
      const r = await api(`/api/superadmin/negocios/${id}/${ruta}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(datos) });
      if (!r.ok) { const fallo = await r.json().catch(() => ({})); throw new Error(fallo.error || 'No se pudo guardar'); }
      dialogo.close();
      if (FICHA_NEGOCIO_ID === id) abrirFicha(id);
    } catch (error) { document.getElementById('seguimiento-error').textContent = error.message; }
    finally { boton.disabled = false; }
  });
  document.body.append(dialogo);
  dialogo.showModal();
}

verificarAcceso();
