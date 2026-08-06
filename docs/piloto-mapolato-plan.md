# Plan operativo del piloto Restaurante — Mapolato

Fecha de preparación: 2026-08-06. Producción en `d387669` (deployment
`89e6f286`), módulo restaurante apagado para todos, cero datos de
restaurante. Este plan NO activa nada.

## 1. Diagnóstico (solo lectura, producción)

- **Negocio**: Mapolato Acuña — `negocio_id bb27290a-3359-4348-ba60-03d89f97127f`,
  slug `mapolato-acuna`, activo.
- **Sucursales**: exactamente UNA — "Mapolato Acuña"
  (`7da6a655-9f1a-4fb4-84d9-79bbb90907ec`, activa). No hay multi-sucursal
  que evaluar.
- **Config**: ciudad Acuña, teléfono 8787899919. Sin dirección registrada
  en `configuracion` (falta para el ticket).
- **Módulos activos**: caja, impresion, menu, pagos, pos, repartidores,
  usuarios. Pendientes: facturacion, rappi, voz, whatsapp. `restaurante`:
  sin fila (apagado).
- **Usuarios**: 1 — MARIO ALBERTO CANTU OCHOA (admin, activo). No hay
  usuarios staff.
- **Métodos de pago**: efectivo ✓, terminal ✓; enlace_pago ✗,
  transferencia ✗ (deshabilitados).
- **Menú**: VACÍO — 0 categorías, 0 productos, 0 modificadores.
- **Historial**: 0 pedidos en `pedidos_activos` y 0 en historial — el
  negocio aún no opera por Xabor; no hay dato de volumen promedio ni de
  mezcla salón/llevar/domicilio.
- **Impresión**: contrato printRouter → WebSocket → panel en navegador
  (plantillas 80 mm, `window.print`). No hay tabla de impresoras: la
  "impresora" es el dispositivo que tenga abierto el panel.
- **Mesas**: no existe ningún dato previo de mesas (tablas vacías).

### Información que debe preguntarse al propietario

1. Dirección exacta de la sucursal (para el ticket).
2. Horario de operación y franja preferida para la jornada piloto.
3. Cuántas mesas físicas hay y cuáles participarán (3–5).
4. Quiénes serán mesero y caja (nombres) para crearles usuario propio.
5. ¿Se acepta transferencia en la práctica? (hoy está deshabilitada).
6. Menú: lista de productos y precios reales (hoy el menú en Xabor está
   vacío) — o confirmar captura manual por cuenta durante el piloto.
7. Impresora física: modelo, ancho real (58/80 mm) y a qué dispositivo
   está conectada.
8. RFC/datos fiscales si se quieren en el ticket (opcional).
9. Las 5 preguntas de propinas (sección 6).
10. Volumen esperado de comensales en la franja del piloto.

## 2. Sucursal recomendada

Solo existe una sucursal ("Mapolato Acuña"), así que la evaluación
multi-criterio se reduce a confirmar que ESA sucursal cumple las
condiciones del piloto (propietario presente, pocas mesas, respaldo
manual, horario controlado). **Recomendación: Mapolato Acuña, sujeta a
confirmación del propietario.** No se seleccionó definitivamente.

## 3. Modelo operativo (flujo exacto y responsables)

| # | Paso | Responsable |
|---|------|-------------|
| 1 | Abrir mesa (tocar mesa libre) | Mesero |
| 2 | Capturar número de personas | Mesero |
| 3 | Confirmar mesero (por defecto, quien abre) | Mesero |
| 4 | Agregar productos | Mesero |
| 5 | Agregar modificadores/notas | Mesero |
| 6 | Enviar comanda inicial | Mesero |
| 7 | Recibir impresión y preparar | Cocina |
| 8 | Agregar productos posteriores | Mesero |
| 9 | Enviar comanda adicional (solo lo nuevo) | Mesero |
| 10 | Solicitar cuenta / revisarla en pantalla | Mesero → Caja |
| 11 | Revisar propina (separada, opcional) | Caja |
| 12 | Dividir la cuenta si aplica (calculadora) | Caja |
| 13 | Registrar pagos (método real; mixto = varios pagos) | Caja |
| 14 | Confirmar saldo $0.00 | Caja |
| 15 | Cerrar cuenta | Caja |
| 16 | Verificar folio de venta RM- en pantalla | Caja |
| 17 | Entregar ticket final impreso | Caja |
| 18 | Verificar mesa liberada | Mesero |
| 19 | Verificar la venta en el reporte (una vez) | Administrador |
| 20 | Comparar cobro físico vs. Xabor | Administrador + Propietario |

Cancelaciones de producto, movimientos de mesa y reversos de venta:
exclusivos del Administrador (motivo obligatorio, auditado). El
Propietario supervisa los pasos 19–20 y decide continuar/detener.

## 4. Mesas (propuesta, NO creadas)

- 5 mesas: Mesa 1 … Mesa 5 (sin mapa gráfico; el sistema no requiere
  pre-crearlas: la mesa existe al abrir su primera cuenta, con estado
  libre/ocupada, personas y mesero).
- Numeración física visible en cada mesa (etiqueta).
- Ampliación posterior: simplemente se usan números mayores (hasta 500
  soportados); si el salón crece, se documentará la numeración por zona.

## 5. Usuarios y permisos (matriz propuesta, NO creada)

| Usuario | Sucursal | Rol actual | Función en piloto | Permisos requeridos |
|---|---|---|---|---|
| MARIO ALBERTO CANTU OCHOA | Mapolato Acuña | admin | Administrador + respaldo caja | admin (ya) |
| (por crear) Mesero piloto | Mapolato Acuña | — | Mesero | staff |
| (por crear) Caja piloto | Mapolato Acuña | — | Caja | staff |

- Roles existentes únicamente: staff (mesero/caja) y admin
  (cancelaciones, reversos). No se crean roles nuevos.
- ⚠ **Riesgo marcado**: hoy solo existe UNA cuenta (admin). Operar el
  piloto compartiendo esa cuenta entre mesero/caja/cocina anula la
  auditoría (todo quedaría a nombre del mismo usuario) y da a todos
  permisos de admin (cancelar/reversar). Antes del piloto deben crearse
  los 2 usuarios staff — con autorización, en fase posterior.

## 6. Métodos de pago y propinas

Configuración recomendada (ya coincide con lo existente — no requiere
cambios): efectivo y terminal habilitados; transferencia solo si el
propietario confirma que se usa; enlace_pago fuera del piloto. Pago mixto
permitido; propina separada; el sistema ya impide pago mayor al saldo y
cierre con saldo pendiente; se registra el método real de cada pago.

**Política provisional de propinas**: opcional; capturada por pago
(separada de la venta); registrada por método; visible en cuenta, ticket y
reporte; NO se distribuye automáticamente; distribución manual fuera de
Xabor; sin supuesto fiscal/laboral.

**Decisiones pendientes del propietario**: (1) ¿propina en efectivo? (2)
¿propina en terminal? (3) ¿por cuenta o por pago? — el sistema la captura
por pago; (4) ¿quién revisa el total diario de propinas? (5) ¿cómo se
distribuye hoy entre el personal?

## 7. Impresión y ticket final

- Contrato real: printRouter (server) → WebSocket → panel index.html
  (plantillas HTML 80 mm + window.print del navegador). Los trabajos de
  restaurante llegan con `tipo_comanda`: inicial / adicional / cancelacion
  / cuenta_final.
- **Brecha detectada y corregida en `feat/restaurante-ticket-final-piloto`**:
  el panel no distinguía `cuenta_final` — lo habría impreso con la
  plantilla de comanda de cocina y agregado como tarjeta al tablero. Ahora
  `cuenta_final` NO entra al tablero y se imprime con su propia plantilla.
- Campos que YA llegan y se imprimen: folio RM-, mesa, personas, mesero,
  items (cantidad/nombre/notas+modificadores), total, propina total,
  pagos por método con su propina, saldo $0.00, negocio (nombre, ciudad,
  teléfono desde config).
- Campos que FALTAN de datos (no de código): dirección de la sucursal
  (config vacía), RFC (no capturado). Impuestos y descuentos no existen en
  el módulo de mesas (documentado; no se imprimen líneas vacías). "Cambio"
  no aplica: los pagos registrados nunca exceden el saldo.
- Ancho: 80 mm (igual que todas las plantillas existentes). Si la
  impresora del piloto es de 58 mm, se ajustará la hoja de estilos en una
  iteración menor — pendiente de conocer el hardware real.
- Codificación UTF-8 (acentos verificados); el corte lo maneja el driver
  de la impresora del navegador (igual que comandas actuales).
- Reimpresión: controlada — botón manual 🧾↺ en el panel, solo el último
  ticket; el servidor jamás re-emite el trabajo en reintentos de cierre.
- Impresora física a probar: pendiente de confirmar con el propietario.

## 8. Prueba interna previa (sin clientes, con módulo activado en piloto)

| Esc. | Contenido | Resultado esperado | Evidencia | Responsable | Aprueba si |
|---|---|---|---|---|---|
| 1 | 1 mesa, 2 personas, 3 productos, 1 modificador, comanda inicial + producto adicional, pago efectivo sin propina | 2 comandas impresas (inicial con 3, adicional con 1), cierre con folio RM-, ticket final, venta única en reportes | Fotos de comandas y ticket + captura del reporte | Caja + Admin | Todo coincide al centavo |
| 2 | 1 mesa, 4 personas, división en 2, efectivo + terminal, propina, cierre | Pagos mixtos conservados por método, propina separada en ticket y reporte, saldo 0 | Ticket + reporte | Caja | forma_pago "mixto", propina fuera del total |
| 3 | Cancelar un producto ya enviado, comanda de cancelación, mover de mesa, cierre | Comanda "CANCELADO" impresa, total ajustado, mesa movida, cierre normal | Comanda de cancelación + cuenta | Admin | El producto cancelado no suma ni se cobra |
| 4 | Reverso administrativo de la venta del esc. 3, recierre | Venta original cancelada con motivo en reportes, cuenta reabierta, recierre con folio RM-…-1 nuevo, UNA venta neta | Capturas de reportes antes/después | Admin | Cero ventas duplicadas |

## 9. Primera jornada controlada

Duración 2–3 h; máximo 3–5 mesas; propietario presente; 1 mesero
capacitado; 1 persona en caja; respaldo en papel a la mano; impresora
monitoreada; NO se activa toda la operación de golpe.

Monitoreo continuo (Admin): cuentas abiertas, comandas emitidas vs.
impresas, tiempos de cocina, pagos registrados, ventas RM- en el reporte,
diferencias de cobro, errores en pantalla, cierres, reversos, ánimo del
personal.

**Criterios para DETENER el piloto de inmediato**: venta duplicada;
diferencia entre cobro físico y Xabor; impresión duplicada; comanda que no
llegó a cocina; saldo incorrecto; cualquier dato de otro negocio visible;
el mismo error dos veces; personal confundido al punto de frenar el
servicio; el servicio al cliente se está afectando.

## 10. Rollback operativo (NO ejecutado)

1. Dejar de abrir cuentas nuevas.
2. Terminar o trasladar a papel las cuentas abiertas (cerrarlas con su
   pago real, o anotarlas y cerrarlas después).
3. Registrar manualmente cualquier cobro pendiente.
4. Desactivar el módulo `restaurante` SOLO para Mapolato.
5. Volver al flujo habitual del negocio.
6. Conservar TODOS los registros (cuentas, ventas RM-, reversos) para
   auditoría — nada se borra.
7. Documentar el incidente (qué pasó, cuándo, evidencia).
8. Rollback de código: solo si hay un error general del sistema, no por
   incidentes operativos del piloto.

## 11. Riesgos

- Menú vacío: capturar productos a mano en cada cuenta es lento y
  propenso a errores de precio — cargar el menú antes del piloto es lo
  recomendado.
- Usuario único admin: sin usuarios staff no hay separación de funciones
  ni auditoría real (riesgo marcado en la matriz).
- Impresora desconocida: la plantilla está en 80 mm; hardware de 58 mm
  requeriría un ajuste menor previo.
- Dirección/RFC ausentes en config: el ticket sale sin esas líneas hasta
  capturarlas.
- El negocio no ha operado por Xabor (0 pedidos): la primera jornada
  también es la primera vez del personal con el panel — capacitación y
  respaldo en papel son críticos.
