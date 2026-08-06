# Capacitación piloto Restaurante — Mapolato (máx. 30 minutos)

Panel de mesas: `https://xabor.mx/mesas.html` (requiere sesión y módulo
activo). Panel general (comandas/impresión/reportes):
`https://xabor.mx/index.html`.

Agenda sugerida: 10 min mesero · 10 min caja · 5 min cocina · 5 min admin.

## Mesero (staff) — 10 min

1. **Iniciar sesión** en el dispositivo del salón con TU usuario (no
   compartas cuenta: cada apertura, comanda y cierre queda a tu nombre).
2. **Abrir mesa**: toca la mesa libre → captura número de personas → Abrir
   cuenta. Si no eliges mesero, el mesero eres tú.
3. **Agregar productos**: nombre, cantidad, precio; notas/modificadores en
   el campo de notas ("sin cebolla, extra queso").
4. **Enviar comanda**: botón "Enviar comanda" — imprime en cocina SOLO lo
   nuevo. Sin productos pendientes no hay nada que enviar.
5. **Segunda ronda**: agrega los productos y vuelve a enviar comanda — sale
   una comanda ADICIONAL solo con lo nuevo (cocina no repite lo anterior).
6. **Pedir apoyo**: cancelaciones de producto las hace el administrador
   (con motivo). Tú no puedes cancelar.
7. **Revisar cuenta**: total, pagado y saldo siempre visibles en la mesa.
8. **Nunca cierres sin pago**: el sistema no lo permite (saldo debe ser
   $0.00), no lo intentes "para probar".

## Caja (staff) — 10 min

1. **Revisar la cuenta** de la mesa: total, items, pagos previos.
2. **Dividir**: "Dividir en partes iguales" muestra cuánto toca por
   persona (es una calculadora; los cobros reales se registran uno a uno).
3. **Registrar pagos**: método real usado (efectivo/terminal), monto y
   propina si la hay. Pagos mixtos = varios pagos, cada uno con su método.
4. **Propina**: SIEMPRE en el campo propina, nunca sumada al monto.
5. **Cerrar cuenta**: solo con saldo $0.00. Confirma → aparece
   "Venta registrada: RM-…" y se imprime el ticket final.
6. **Verificar folio RM-**: ese folio es la venta en reportes. Si la
   respuesta tardó y vuelves a tocar cerrar, el sistema te repite el MISMO
   folio — no se duplica nada.
7. **Reverso**: si una cuenta cerrada estuvo mal cobrada, NO se reabre —
   pide al administrador el reverso de venta (con motivo).

## Cocina — 5 min

1. **Comanda inicial**: primer envío de la mesa — prepara todo lo listado.
2. **Comanda adicional**: solo trae lo NUEVO — no repitas lo anterior.
3. **Comanda de cancelación**: dice "CANCELADO: <producto>" — NO prepares
   ese producto; si ya salió, avisa a caja.
4. El ticket de cuenta final NO llega a cocina — si ves un ticket con
   "CUENTA CERRADA", es de caja, avisa.
5. **Errores**: cualquier comanda rara (duplicada, incompleta) se avisa de
   inmediato al administrador — no se improvisa.

## Administrador — 5 min

1. **Mover mesa**: desde la cuenta abierta → "Mover de mesa" (falla si la
   mesa destino está ocupada).
2. **Cancelar ítems**: botón Cancelar del producto + motivo obligatorio —
   queda auditado y ajusta el total; si ya salió a cocina se imprime la
   comanda de cancelación.
3. **Reversar venta**: cuenta cerrada mal cobrada → reverso con motivo
   (la venta queda cancelada en reportes con auditoría, la cuenta reabre y
   el re-cierre genera folio RM- nuevo). Reabrir directo está bloqueado.
4. **Revisar reportes**: pestaña Ventas del panel — la venta de mesa
   aparece UNA vez, con canal restaurante_mesa y folio RM-.
5. **Detener el piloto**: deja de abrir cuentas, cierra/traslada las
   abiertas y desactiva el módulo (ver rollback operativo en el plan).

---

## Hoja rápida (imprimir, 1 página)

| Quiero…                    | Hago…                                                        |
|----------------------------|--------------------------------------------------------------|
| Abrir mesa                 | Tocar mesa libre → personas → Abrir cuenta                   |
| Mandar a cocina            | + Agregar productos → Enviar comanda                         |
| Segunda ronda              | Agregar lo nuevo → Enviar comanda (sale solo lo nuevo)       |
| Cancelar un producto       | ADMIN: Cancelar + motivo                                     |
| Cobrar                     | Registrar pago (método real, propina aparte)                 |
| Dividir la cuenta          | "Dividir en partes iguales" (solo calcula)                   |
| Cerrar                     | Saldo $0.00 → Cerrar → anota el folio RM-                    |
| Se trabó al cerrar         | Vuelve a tocar Cerrar: repite el MISMO folio, no duplica     |
| Cuenta cerrada mal cobrada | ADMIN: Reverso de venta con motivo (no reabrir)              |
| Reimprimir ticket final    | Panel general → botón 🧾↺ (solo el último, manual)           |
| Algo raro                  | Avisar al administrador y anotar en papel                    |
