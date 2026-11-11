# Número consecutivo por sucursal

Qué es el número OB-152 que aparece en Caja, cómo se enciende y cómo se lee un
hueco. Escrito para el dueño y para el siguiente que toque esto.

## Por qué existe

El folio `XAB-` sale de **una sola secuencia para todos los negocios**
(`folio_pedido_seq`, migración 059). Obispado y Acuña se intercalan: el
10-nov-2026, de XAB-3163 a XAB-3207, 16 folios eran de Acuña. En «Pedidos del
día» de una sucursal faltaban números que había tomado la otra, y un hueco no
significaba nada.

El número por sucursal es **adicional**. El folio `XAB-` no cambia: sigue
siendo la identidad del pedido para pagos, impresión, facturas y WhatsApp.

Decisiones de Mario (10-nov-2026):

- Se muestra como **prefijo + número**: OB-152, AC-48.
- **No se reinicia nunca.**
- **Empieza en 1 al encenderlo.** Los pedidos de antes no se numeran.
- Nace **apagado** en todas las sucursales.

## Cómo funciona

Migración 136. Un trigger (`trg_zz_numero_sucursal`) sobre `pedidos_activos`
le pone su número a cada pedido de una sucursal encendida, en la misma
transacción en que se guarda el pedido:

- **Sin huecos.** El contador es una fila por negocio
  (`pedido_numero_sucursal_contador`). Si el pedido no se guarda, el número
  tampoco se gasta. Un re-guardado del mismo folio y un folio que la barrera
  de la 061 descarta tampoco gastan número.
- **Nunca rechaza un pedido.** Si el contador tarda más de 3 s o algo falla,
  el pedido se guarda **sin número** y queda un `WARNING [136]` en el log. La
  Caja enseña esos pedidos en rojo.
- **El ledger** (`pedido_numeros_sucursal`) guarda qué folio recibió cada
  número y sobrevive al borrado del pedido. Un programado que vuelve a la
  agenda y se reactiva recupera su mismo número.
- Ningún INSERT ni UPDATE puede poner o cambiar el número a mano.

## Qué enseña la Caja

En «Pedidos del día», cada pedido numerado dice `OB-152 #3170`: el número de
la sucursal y, en gris, el folio de siempre.

Arriba de la lista:

- **Números del día: OB-140 a OB-175 (36).** Son los números que se dieron
  ese día. Si todos están en la lista: «✓ Están todos en la lista».
- **No están en la lista** (amarillo), uno por renglón, con el porqué:
  - `OB-150: #3170 se eliminó`: el pedido se borró.
  - `OB-151: #3100 está en la lista del 8 NOV 2026`: un programado conserva la
    fecha de su reserva; aparece en la lista de ese día.
  - `no hay registro de a qué pedido se dio`: no debería pasar nunca.
- **Sin número** (rojo): pedidos guardados después de encender la numeración
  que se quedaron sin número porque algo falló. Hay que revisar el log.

La numeración queda guardada en el corte al cerrarlo.

## Encender una sucursal

Dos claves en `configuracion`. Las corre Mario, con su respaldo de siempre:

```sql
-- :negocio_id = el id de la sucursal; 'OB' = sus letras (A-Z y dígitos, hasta 4).
INSERT INTO configuracion (negocio_id, clave, valor)
VALUES (:negocio_id, 'numero_sucursal_prefijo', 'OB')
ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor;

INSERT INTO configuracion (negocio_id, clave, valor)
VALUES (:negocio_id, 'numero_sucursal_activo', 'true')
ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = EXCLUDED.valor;
```

El siguiente pedido de esa sucursal recibe el 1. Se pone primero el prefijo:
sin él, la Caja escribe `N.º 1`.

## Apagar

```sql
UPDATE configuracion SET valor = 'false'
 WHERE negocio_id = :negocio_id AND clave = 'numero_sucursal_activo';
```

Los números ya dados se quedan. Al volver a encenderla sigue donde iba (no se
reinicia).

## Reversa

No hace falta para apagarla ni para volver a un binario anterior: el binario
viejo no lee la columna ni las tablas. `migrations/136_numero_pedido_sucursal_down.sql`
quita el trigger y su función y **conserva** los números. Borrar también los
datos haría que, al reaplicarla, la numeración empezara otra vez en 1.

## Pendiente (fase 2)

El número solo se ve en Caja. Falta decidir dónde más: tablero de comandas,
comanda de cocina (la pinta el Edge en la PC), ticket del cliente y los
mensajes de WhatsApp.
