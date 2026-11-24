# Venta pública de Xabor Básico

El propietario indicó el 24/11/2026: abrir la venta a clientes y dejar la
comprobación del primer cobro real para un cliente que lo autorice. El autocobro
del vendedor no se usará como requisito de lanzamiento.

## Oferta y recorrido

- Precio:150 MXN mensuales, siete días de prueba desde verificar el correo.
- Productos, categorías, ventas de mostrador, historial, reportes y ticket digital.
- El mismo panel `/app`, con los permisos del Básico aplicados por el servidor.
- Registro sin tarjeta en `/registro-basico`, verificación por correo y acceso.
- En «Mi suscripción», el cliente indica el correo de su cuenta compradora y
  autoriza personalmente en Mercado Pago el contrato recurrente. Puede cancelar
  los cobros futuros desde esa misma pantalla.
- WhatsApp automático, mesas, reparto e impresión física se contratan aparte.
  La propuesta acompañada conserva su referencia anterior; no se cobra al
  solicitar una demostración.

La landing retira la promoción vencida de agosto/septiembre y usa la vista social
`xabor-social-basico-v4.png`. El formulario de prospectos sigue operativo.

## Configuración para publicar

En `production / xabor-agent`, desplegar el commit revisado y fijarlo por SHA.
Activar `XABOR_ALTA_BASICO_MODO=publico`, conservando las banderas de registro,
Mercado Pago y conciliación ya verificadas. Vaciar los dos identificadores del
piloto individual sin espera: ningún cliente recibe esa excepción.

La migración156 agrega `correo_pagador` nullable y su validación en una transacción.
Para este despliegue el predeploy necesita `XABOR_MIGRAR_BASICO=SI`. Conserva los
contratos anteriores sin inventar un correo de pago. No añade ventas ni cuentas,
no borra tablas y no cambia importes ni periodos pagados. Existe respaldo diario
del volumen productivo configurado previamente.

## Verificación y reversión

Pruebas locales de cliente, permisos, correo, registro público, concurrencia,
reintentos, cancelación, acreditación e historial; landing y visual móvil.
Esperar CI antes de publicar. Tras el despliegue comprobar `/health`, oferta,
`/api/publico/registro-basico/estado` con `porInvitacion:false`, esquema y logs.
No crear cuentas ficticias ni ventas de prueba en producción.

Para detener nuevas altas, `XABOR_ALTA_PUBLICA_BASICO=false`; para volver al
piloto de registro, `XABOR_ALTA_BASICO_MODO=invitacion`. Se conserva el correo de
invitación anterior. Si se vuelve al código previo, no eliminar156: el código
anterior admite esa columna adicional y conserva las cuentas ya creadas.

## Pendientes que no se declaran verificados

Primer cobro real aprobado y acreditado, entrega automática de su webhook y
renovación: se observarán con el primer cliente que complete la autorización.
La conciliación consulta al proveedor; no simula pagos. La contratación pendiente
del propietario conserva su histórico y no se reemplaza ni se cancela por esta
publicación.
