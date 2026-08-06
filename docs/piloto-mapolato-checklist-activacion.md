# Checklist de activación — Piloto Restaurante Mapolato

Regla: el piloto NO se activa con cualquier casilla CRÍTICA pendiente.
Las casillas críticas están marcadas con ⛔.

## Preparación

- [ ] ⛔ Sucursal confirmada por el propietario (única candidata hoy:
      "Mapolato Acuña", sucursal `7da6a655…`).
- [ ] ⛔ Propietario presente durante la primera jornada.
- [ ] ⛔ Usuarios confirmados: quién es mesero, quién es caja, con SU
      propia cuenta (hoy solo existe 1 usuario admin — faltan usuarios
      staff; no compartir una sola cuenta).
- [ ] ⛔ Mesas confirmadas: cantidad (3–5) y numeración física visible.
- [ ] ⛔ Métodos de pago revisados (hoy: efectivo y terminal habilitados;
      transferencia/enlace deshabilitados — confirmar que refleja la
      operación real).
- [ ] ⛔ Política provisional de propinas aceptada por el propietario
      (separada, informativa, distribución manual fuera de Xabor).
- [ ] ⛔ Menú cargado en Xabor (hoy está VACÍO: 0 categorías, 0
      productos) o decisión explícita de capturar productos a mano en cada
      cuenta durante el piloto.
- [ ] ⛔ Impresora física conectada y probada desde el panel (comanda de
      prueba impresa correctamente ANTES del piloto).
- [ ] ⛔ Ticket final validado en la impresora física (folio RM-, pagos,
      propina, acentos, corte).
- [ ] Conexión a internet estable en salón y caja (verificada ese día).
- [ ] ⛔ Respaldo manual listo: bloc de comandas en papel + calculadora.
- [ ] ⛔ Capacitación impartida (mesero, caja, cocina, admin) con la hoja
      rápida entregada.
- [ ] ⛔ Prueba interna cerrada (4 escenarios) ejecutada y aprobada SIN
      clientes.
- [ ] Reportes revisados con el propietario: dónde ver las ventas RM- y
      cómo cuadrar el corte del día.
- [ ] ⛔ Rollback operativo leído por el administrador (sabe detener el
      piloto sin ayuda técnica).
- [ ] ⛔ Autorización final y expresa del propietario para activar el
      módulo SOLO en Mapolato.

## Día de activación (en este orden)

- [ ] Verificar producción estable (/health 200, sin errores en logs).
- [ ] Activar módulo `restaurante` únicamente para Mapolato.
- [ ] Confirmar que mesas.html carga para Mapolato y muestra las mesas.
- [ ] Confirmar que ningún OTRO negocio ve el módulo.
- [ ] Primera cuenta de prueba interna (personal, sin cliente) de punta a
      punta: abrir → comanda → pago → cierre → folio RM- → reporte →
      ticket.
- [ ] Revisar que esa venta aparece UNA vez en Ventas.
- [ ] Dar inicio a la jornada controlada (2–3 h, 3–5 mesas).

## Cierre de jornada

- [ ] Corte físico vs. reporte de ventas RM- del día: cuadrado.
- [ ] Propinas del día revisadas (total informativo).
- [ ] Incidentes anotados (aunque sean menores).
- [ ] Decisión registrada: continuar / ajustar / detener.
