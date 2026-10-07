# Órdenes por persona en mesas y tienda

Una cuenta o pedido conserva líneas independientes por comensal: Orden 1
con 2 tacos de barbacoa, 1 de frijoles y 2 de huevo; Orden 2 con 3 de
barbacoa y 3 de papas. Cocina recibe dos bloques de 5 y 6 tacos y se
conserva el mismo total general. La función no divide pagos ni cambia precios.

## Versión integrada y activación

La versión publicable parte de 48e4150, el commit que sirve Railway desde
prod/mesero-shadow-v3. La implementación inicial 6a22c75 se adaptó a esta
base, conservando captura unificada, descuentos, cobros, correcciones de
platillos, cancelaciones autorizadas y tienda actuales. No cambia el Mesero
de WhatsApp ni resucita el protocolo de impresión legado retirado.

La migración es 115 (079 ya está ocupada por Rewards). Añade persona JSONB
nullable a restaurante_cuenta_items, sin actualizar filas. Se incluyó en
scripts/predeploy-run-032-033.mjs, que Railway ejecuta antes del binario nuevo.
Tiene lock_timeout de 3 segundos y statement_timeout de 15 segundos.

La clave configuracion.ordenes_por_persona es texto true/false por negocio,
apagada por omisión. Un administrador puede cambiarla en Configuración.
El servidor la comprueba al aceptar líneas asignadas. El usuario autorizó
publicar y activarla en Mapolato Obispado y Mapolato Acuña.

## Uso y persistencia

El selector ofrece Compartido / sin asignar y Orden 1, Orden 2… Agregar
persona permite hasta 99 órdenes. Mesas parte del número de comensales;
tienda parte de una orden. Se agrega cada guiso con su cantidad y persona.
La tienda permite cambiar la persona al editar; los índices originales del
carrito se conservan para que Editar y Quitar actúen sobre la línea correcta.
No se combinan líneas entre personas.

Cada línea lleva persona: { numero: 1, nombre: '' } o null. No hay editor de
nombres en esta primera versión; el nombre opcional admite 40 caracteres
sin controles. La identidad se conserva al guardar y recargar, en rondas
adicionales, cancelaciones completas/parciales y la venta consolidada.
Un reemplazo de platillo conserva la persona del producto que reemplaza.

Las rondas siguen enviando solo lo pendiente. Los snapshots y las claves de
idempotencia conservan el contrato existente. Cada estación conserva la
persona después del routing. El navegador y el renderer Edge nuevo imprimen
bloques por persona. Para los Edges ya instalados, el servidor incluye
Orden N también en la nota de cada línea; el renderer nuevo elimina esa
etiqueta sintética de la nota al agrupar. La cancelación incluye la orden en
su motivo para que el Edge anterior también la pueda identificar.

Desactivar impide nuevas líneas asignadas y conserva el historial. Si se
apagó la función después de guardar un carrito, la cotización lo rechaza;
se puede editar cada línea y elegir compartido. No se pierde silenciosamente
la separación del pedido.

## Validación antes de publicar

Se usó una base Docker aislada, con migraciones hasta la 115. El predeploy
completo pasó: checks de incidentes, migraciones, gate financiero y gate de
datos. Las pruebas de integración se ejecutaron con Node 22 y Chrome real,
sin proveedores externos, mensajes reales ni impresoras físicas.

- Órdenes por persona: ejemplo de 11 tacos, precios de servidor, aislamiento,
  persistencia, concurrencia, rondas adicionales, dos estaciones, cancelación
  completa/parcial y pantallas reales de mesas y tienda móvil.
- Mesas: 28 pruebas pasadas.
- Cancelaciones autorizadas: 22 pruebas pasadas.
- Tienda: 77 pruebas pasadas; se comparó con la misma base productiva.
- Exclusividad de comanda Edge: 23 pruebas pasadas.
- Modificadores en todos los canales: 27 pruebas pasadas.
- Runtime Node 22: rutas, contexto, DOM, triple clic y cierre de Chrome pasados.

La suite nueva ejecuta también el renderer anterior 48e4150 para comprobar
la compatibilidad de los snapshots con los Edges instalados. Exige una base
local de pruebas y genera capturas ignoradas en test/.personas-qa/.
Las verificaciones de producción previas a publicar fueron READ ONLY;
no crearon pedidos, cobros ni trabajos de impresión.
