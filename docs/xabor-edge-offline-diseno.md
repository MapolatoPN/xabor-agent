# Modo sin conexión — diseño y estado real

Sustituye a `xabor-edge-offline-roadmap.md`, que era un diseño **aspiracional**
escrito antes de mirar el código de sala. Ese documento sigue siendo útil como
registro de las preguntas correctas, pero su premisa central resultó falsa y su
alcance era varias veces mayor del necesario.

Estado al **9 de septiembre de 2026**. Nada de esto está desplegado.

## Alcance: qué tiene que sobrevivir a un corte

Decisión del dueño, y simplifica mucho: **la tienda en línea y el asistente
virtual pueden apagarse sin internet.** WhatsApp sigue atendiéndose desde el
celular con su plan de datos.

Lo que NO puede pararse es la **operación de sala**: abrir mesa, capturar,
mandar comandas a cocina, cobrar e imprimir. Eso es lo único que cubre este
diseño, y es también lo que hoy obliga a seguir pagando Wansoft, que corre
local y sobrevive al corte.

## El hallazgo que redujo el alcance

La hoja de ruta anterior daba por **"el punto crítico"** que los folios
globales no sirven offline: dos Edges desconectados generarían el mismo número
y chocarían al reconectar. Proponía por eso una arquitectura de dos capas —id
local que genera el Edge, folio real que asigna la nube al reconciliar— con la
comanda impresa mostrando una referencia provisional tipo `LOCAL-A7F3`.

Eso es cierto para `pedidos_activos.folio`, la secuencia de WhatsApp y
mostrador. **El camino de sala no la usa.**

| Hecho | Dónde se comprueba |
|---|---|
| `restaurante_cuentas`, `_items` y `_pagos` tienen PK `UUID` | migración 039 |
| El folio de venta se **deriva** de la cuenta: `RM-<8 hex del uuid>-<reversos>` | `restauranteService.js:379` |
| El insert de la venta ya es `ON CONFLICT (folio) DO NOTHING` | mismo archivo |
| `venta_folio` tiene índice único parcial | `idx_restaurante_venta_folio` |

Consecuencias, todas a favor:

- El Edge genera identificadores **definitivos**. No hay reasignación.
- **El ticket que se imprime sin internet ya lleva el folio final.** La cocina y
  el cliente nunca ven un número que después signifique otra cosa — que era
  justo el riesgo que la referencia `LOCAL-A7F3` intentaba administrar.
- Sincronizar es un *upsert por UUID*: idempotente por construcción.
- **No hace falta migración.**

## Arquitectura

El Edge ya es la autoridad local de impresión y ya sobrevive a cortes. Se le
extiende el mismo papel para la sala:

```
  PCs de sala  ──HTTP LAN──►  Edge (PC del local)  ──WS saliente──►  Nube
   (meseros,                   · catálogo (foto)                     (Postgres)
    caja,                      · sala local (UUID)
    para llevar)               · outbox
                               · impresoras
```

Con enlace, las PCs hablan con la nube como hoy. Sin enlace, hablan con el Edge,
que está en la misma red. Cuando el enlace vuelve, el Edge sube su outbox.

## Lo que ya está construido y probado

| Pieza | Archivo | Pruebas |
|---|---|---|
| Motor local de sala | `edge/sala/operacionLocal.js` | `fase-sala-offline` — 22 |
| Ingesta en la nube | `src/services/sincronizacionSala.js` | `fase-sala-sincronizacion` — 12 |
| Foto del catálogo | `src/services/catalogoParaEdge.js` | `fase-catalogo-edge` — 9 |

Decisiones que conviene no volver a discutir:

- **Los mismos invariantes que la nube, y los mismos códigos de error.** No una
  versión relajada "para la emergencia": si offline permitiera algo que online
  rechaza, la sincronización tendría que deshacer trabajo ya cobrado, y eso no
  se le explica a un cliente que ya pagó y se fue. Los códigos coinciden
  (`MESA_OCUPADA`, `CUENTA_NO_ABIERTA`, `SALDO_PENDIENTE`, …) para que la
  interfaz se comporte igual con enlace y sin él.
- **Dinero en centavos enteros.** El cierre exige saldo cero y sumar flotantes
  lo impide (`0.1 + 0.2`). La nube usa `NUMERIC(10,2)`; en JavaScript, enteros.
- **Una transacción por cuenta, no por lote.** Una mesa en conflicto no puede
  dejar sin subir las otras treinta ventas del día.
- **Solo se confirma lo aplicado.** El Edge conserva en su cola lo que la nube
  no pudo incorporar y lo reintenta.

### Un defecto encontrado construyendo esto

El corte de caja agrupa el día por `pedidos_activos.created_at`
(`cortesCaja.js:208`). Insertar la venta sincronizada con `NOW()` metía **el
dinero del sábado sin internet en el corte del domingo**. Se inserta con la
hora en que se cobró. Cuidado al leer ese campo: `created_at` es
`timestamp WITHOUT time zone` y `entregado_at` es `timestamptz`, así que el
driver reinterpreta el primero como hora local y *parece* corrido; la
comparación honesta se hace del lado de Postgres.

## Conflictos: qué se resuelve y qué no

La regla de partida sigue siendo la del documento anterior, y es correcta:
**lo que ya se cobró no se recalcula.** El dinero registrado es un hecho, no una
derivada del catálogo.

| Caso | Qué hace el sistema |
|---|---|
| Cuenta cerrada offline que la nube no conoce | Entra completa, con su folio y su venta |
| El mismo lote subido dos veces | Nada cambia: upsert por UUID |
| Precio que cambió durante el corte | Manda el precio cobrado: viaja en el item |
| Pago que llega de una cuenta que la nube ya cerró | Se **guarda** el pago; la venta **no** se recalcula; se reporta |
| Mesero dado de baja durante el corte | Se reporta `USUARIO_DESCONOCIDO`, no se inserta |
| Dos dispositivos abrieron la misma mesa | Se reporta `MESA_OCUPADA` y **decide una persona** |

Ese último caso no se resuelve adivinando a propósito. Solo ocurre si hubo dos
operaciones independientes sobre la misma mesa, y ninguna regla automática sabe
cuál de las dos cuentas es la del cliente que se sentó ahí.

Una cuenta **cerrada** nunca choca con el índice único, porque solo cubre
`estado = 'abierta'`. Al reconectar, la mayoría de las mesas ya se cobraron: el
conflicto es la excepción, no la norma.

## Lo que falta, en orden

1. **Servidor HTTP del Edge en la red local**, exponiendo la operación de sala
   con la misma forma que `/api/restaurante/*`.
2. **Failover en el panel**: detectar que la nube no responde y hablarle al
   Edge. Toca `panel/index.html`, componente protegido — requiere aprobación.
3. **Bucle de sincronización**: subir el outbox al reconectar y refrescar la
   foto del catálogo mientras hay enlace.
4. **Informe de reconciliación** en el panel: qué se creó sin enlace, con qué
   folio, y qué quedó pendiente de decisión. Sin ese informe nadie puede
   confiar en la caja del día.
5. **Prueba física**: cortar el internet del local a propósito, con el
   restaurante operando, y ver qué pasa de verdad.

Los pasos 1 y 3 son código nuevo en el Edge. El 2 es el que decide si esto es
usable, y el único que toca un componente protegido.

## Lo que este diseño NO cubre

- **Pedidos de WhatsApp y tienda en línea sin internet.** Fuera de alcance por
  decisión del dueño: el asistente y la tienda se apagan durante el corte.
- **Cobros con terminal bancaria o enlace de pago.** La terminal es otro aparato
  y funciona sola; el Edge **registra** que ese cobro ocurrió, nunca lo ejecuta.
  Cobrar de verdad exige red.
- **El cajón de dinero.** No existe en el código, ni con enlace ni sin él (ver
  `mapolato-obispado-paridad-wansoft.md`). Es un pendiente aparte.
