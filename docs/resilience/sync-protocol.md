# Protocolo de sincronización

## El problema

Entre "el Edge lo mandó" y "la nube lo guardó" hay una red que puede cortarse
en cualquier punto. El Edge no puede distinguir "no llegó" de "llegó y se
perdió la respuesta", así que reintenta. Sin idempotencia real, un turno de
500 operaciones puede acabar cobrado dos veces.

## Contrato

El Edge manda un lote de operaciones. La nube responde **una de cuatro cosas
por operación**, nunca un 200 ambiguo:

| Resultado | Significa | Qué hace el Edge |
|---|---|---|
| `aceptada` | primera vez, aplicada | la marca sincronizada |
| `duplicada` | ya estaba; se devuelve el efecto original | la marca sincronizada |
| `conflicto` | choca con algo que no se resuelve solo | la deja para revisión |
| `rechazada` | inválida (tipo desconocido, tenant equivocado) | no reintenta |

Un fallo de infraestructura devuelve `rechazada` con `reintentable: true`. Eso
es distinto de un rechazo definitivo: ahí el reintento es lo correcto.

## Idempotencia

Clave: `(negocio_id, operation_id)` con índice UNIQUE. No `operation_id` solo:
un identificador de otro tenant jamás debe poder colisionar ni consultar el
resultado del primero. Probado.

**No basta `ON CONFLICT DO NOTHING`.** Sin mirar el resultado es
indistinguible de "se insertó". Se usa `RETURNING`: si vuelve vacío es que ya
existía, y entonces se busca la fila original y se devuelve **su mismo
efecto** — mismo folio, mismo identificador de cuenta. Un reintento que
recibiera un folio distinto haría creer al Edge que son dos pedidos.

## Atomicidad

La operación y su efecto se aplican en la misma transacción. Si `aplicar()`
falla, no queda registrada como aceptada y el Edge puede reintentar sin haber
dejado un efecto a medias. Probado: tras el fallo, el reintento sí la aplica.

## Orden (Parte 18)

No se confía en el reloj. El lote se ordena por `(dispositivo_id, secuencia)`.
Una tablet con la hora atrasada no puede reordenar lo que hizo otra. Probado
con una operación fechada una hora antes que su predecesora.

## Conflictos (Partes 19 y 20)

| Situación | Política | Por qué |
|---|---|---|
| Dos meseros agregan items a la misma mesa | **merge** | es un turno normal |
| Dos rondas simultáneas | merge | aditivas |
| Dos pagos registrados | merge | son dos hechos reales |
| Dos dispositivos cierran la misma cuenta | **conflicto** | hay dinero |
| Una mesa movida a dos destinos | **conflicto** | los dos no pueden ser ciertos |
| Item quitado en uno y modificado en otro | conflicto | requiere criterio humano |

Nunca *last-write-wins* para dinero ni para operaciones destructivas. Un
conflicto termina **resuelto** o **en revisión**; nunca pisado en silencio.
`conflictosPendientes()` los lista con su motivo y su payload intactos.

## Borrados (Parte 52)

Tombstones, no borrado físico. `ITEM_QUITADO` marca; no elimina. Un borrado
físico no se puede reconciliar con lo que otro dispositivo hizo sobre ese
mismo item mientras tanto.

## Folio (Parte 21)

El folio definitivo lo asigna la nube al sincronizar y viaja de vuelta en el
`efecto`. Mientras tanto, la pantalla local muestra `LOCAL-<id corto>`. No se
reservan bloques de folios por adelantado: no hace falta y complica. No se
reciclan.

## Amnesia del Edge (Parte 63)

El `dispositivo_id` y la `generación` viven **dentro** del almacén local, así
que desaparecen si alguien borra la carpeta de datos. Al reconectar, la nube
compara la generación: si cambió, responde `amnesia: true` con la última
secuencia conocida. El Edge entra en recuperación en vez de resincronizar a
ciegas y duplicar el turno entero. Probado.

## Versionado (Parte 65)

Cada operación lleva `version` de payload. El journal local puede sobrevivir a
una actualización de Xabor; no se asume que la estructura sea eterna.
