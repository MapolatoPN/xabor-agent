# Ampliación del piloto de WhatsApp — 29 septiembre 2026

## Autorización y alcance

El dueño proporcionó ocho números adicionales y confirmó explícitamente que
los dos prefijos escritos como `58` debían corregirse a `52`. No se habilitaron
los números con el prefijo original incorrecto.

La operación se aplicó a Mapolato Obispado
(`5de544d8-9a0a-4972-9c92-fd48ff22de66`) a las **19:01:05 UTC**.
Los teléfonos completos permanecen en la configuración del negocio, no en
este documento. Terminaciones autorizadas: 8093, 9836, 7932, 5664, 3324,
4278, 8094 y 9979.

## Cambio aplicado y verificado

- `mesero_agente_telefonos`: de una a nueve personas.
- `whatsapp_flows_telefonos`: de una a nueve personas.
- Se conservó el número del dueño y sus representaciones existentes.
- Se agregaron las representaciones `52` y `521` de cada nuevo número:
  `enElCanario` compara los dígitos literalmente, mientras que la barrera de
  atención normaliza ambos formatos. Son nueve personas, no dieciocho.
- Se mantienen `bot_whatsapp_solo_prueba=true`, porcentaje `0`, bot maestro
  encendido y Flow de categorías `1579871723825809`.

Se usó una transacción PostgreSQL con bloqueo de las filas, comprobación
del negocio y de las barreras, actualización de solo las dos listas y
comparación de toda la configuración antes de confirmar. Una lectura
posterior al COMMIT verificó ambas listas y las barreras.

Prueba local de las funciones reales `alcanceDePruebaPermite`, `enElCanario`
y `flowsActivos`: las nueve personas pasan en ambos formatos; un número
ajeno, su representación `521`, los dos prefijos `58` y un teléfono vacío
son rechazados.

## Sin cambios y pendientes

No se desplegó código, enviaron mensajes, crearon pedidos, modificaron pausas,
reiniciaron conversaciones ni alteraron horarios, zonas, tarifas o pagos.
Los siguientes mensajes entrantes leen la configuración sin necesitar un
reinicio. Las pausas humanas y demás reglas del negocio siguen vigentes.

La corrección de la flecha Atrás sigue pendiente: ampliar el piloto no la
corrige. No se simularon conversaciones reales con los nuevos participantes.
Confirmar un pedido durante estas pruebas puede crear una orden real.
