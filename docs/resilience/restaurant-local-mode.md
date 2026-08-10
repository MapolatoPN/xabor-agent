# Modo local del restaurante

## La premisa

Wansoft puede tener su web caída y el restaurante sigue trabajando, porque el
sistema vive en la PC del local. Xabor hoy no: cada click operativo va a la
nube. Un incidente del proveedor deja al mesero mirando una pantalla que gira.

Este documento describe cómo se parte Xabor en dos planos para que eso deje de
ser cierto.

## Los dos planos

**Plano de operaciones (local).** Todo lo que un mesero o la caja necesitan
para atender un turno: mesas, cuentas, platillos, rondas, comandas, impresión.
Vive en el Edge, dentro del restaurante, y no necesita internet.

**Plano de coordinación (nube).** Sincronización, WhatsApp, administración,
reportes, integraciones, multi-sucursal, respaldo, actualizaciones. Puede
faltar un rato sin que el turno se detenga.

La regla que ordena todo lo demás: **el negocio no depende del plano de
coordinación para cada click operativo.**

## Qué necesita hoy la nube (Parte 4)

Medido leyendo las rutas actuales del módulo Restaurante.

| Acción | Pide a la nube hoy | Podría ser local | Datos mínimos locales |
|---|---|---|---|
| Login de mesero por PIN | sí | **sí** | verificador del PIN, con TTL |
| Ver mesas | sí | **sí** | configuración de mesas |
| Abrir cuenta | sí | **sí** | mesas + mesero |
| Agregar producto | sí | **sí** | menú cacheado con versión |
| Modificadores | sí | **sí** | grupos y opciones cacheados |
| Ronda / comanda | sí | **sí** | reglas de ruteo de impresión |
| Imprimir comanda | sí (nube → Edge) | **sí, directo** | impresoras y rutas |
| Mover mesa | sí | **sí** | cuenta abierta |
| Dividir cuenta | sí | sí, con cuidado | items de la cuenta |
| Pago en efectivo | sí | **sí** | métodos permitidos offline |
| Pago con link / Clip | sí | **no** | requiere internet |
| Cerrar cuenta | sí | sí | totales locales |
| Ticket | sí | sí | plantilla + impresora |
| Corte de caja | sí | fuera de alcance V1 | — |

Once de catorce funcionan localmente. Las dos que no (link de pago y corte) se
identifican como tales en la interfaz en vez de fallar de forma opaca.

## Qué se guarda en el Edge (Parte 5)

No una copia de PostgreSQL. Solo lo necesario:

- identidad: `business_id`, `branch_id`, `device_id`, `generación`
- menú: versión, productos, categorías, grupos y opciones de modificadores,
  foto de disponibilidad
- meseros habilitados para offline, con verificador de PIN y su TTL
- configuración de mesas
- cuentas abiertas con sus items, rondas y comandas
- métodos de pago permitidos sin conexión
- el journal de operaciones locales

## El journal

`edge/journal/index.js`. Guarda **operaciones**, no estado final. La diferencia
importa en la reconciliación: si guardáramos el estado, al volver la nube
habría que elegir entre pisar lo local o lo remoto, y las dos opciones
descartan trabajo real. Con operaciones, dos meseros que agregaron platillos a
la misma mesa produjeron dos hechos aditivos y los dos valen.

Tipos: `CUENTA_ABIERTA`, `ITEM_AGREGADO`, `ITEM_QUITADO`, `RONDA_ENVIADA`,
`MESA_MOVIDA`, `PAGO_REGISTRADO`, `CUENTA_CERRADA`.

Cada operación lleva `operation_id` (UUIDv4), `dispositivo_id`, `secuencia`,
`tipo`, `payload`, `version` y `creada_en_local`.

**Por qué UUIDv4 y no ULID ni UUIDv7.** v7 y ULID codifican el reloj local en
el propio identificador, y el reloj local es justo lo que no es de fiar: una
tablet puede tener la hora mal. El orden se reconstruye con
`(dispositivo_id, secuencia)`, que es monótona por dispositivo y no depende de
ningún reloj. El identificador solo tiene que ser único, y v4 lo es sin
arrastrar una mentira temporal.

**Por qué nunca un folio.** El folio es un contador global; dos tablets sin red
generarían el mismo número para pedidos distintos. Eso ya pasó en el POS y
costó un hotfix. `syncService` rechaza explícitamente un `operationId` con
forma de folio.

## Proyección

El journal es la verdad; la proyección (mesas, cuentas, items) es una vista
para leer rápido. Se puede tirar y rehacer con `journal.proyectar()`. Si un
crash deja la proyección a medias no hay que adivinar cuál de las dos era
buena: manda el journal. Probado en el caos, incluyendo reinicio a mitad de
turno.

## Almacenamiento

Reutiliza `edge/storage` — SQLite en WAL con `synchronous=FULL`, respaldo en
JSON atómico, y lock de proceso. Ya sobrevivió al chaos de 500 rondas del Edge
de impresión. Nada de escribir el único archivo directamente, y nunca
`archivo inválido → []`.

## Autenticación offline (Parte 11)

Un mesero puede entrar sin conexión **solo si fue aprovisionado antes** en ese
negocio y sucursal. Se guarda un verificador del PIN, nunca el PIN ni la
contraseña de nube en claro. Quien nunca fue aprovisionado no aparece
mágicamente offline.

**Limitación que hay que decir en voz alta:** si la nube revoca a un usuario
mientras el Edge está sin conexión, el Edge no puede enterarse hasta
reconectar. Por eso las credenciales locales llevan TTL y versión: vencido el
plazo, ese mesero deja de poder entrar offline aunque el Edge siga aislado. El
TTL es una decisión de negocio; la propuesta es 72 horas.

## Modo degradado en la interfaz (Partes 12 y 13)

Dos modos explícitos, sin descubrimiento automático mágico:

- **NORMAL** contra la nube
- **DEGRADADO** contra el Edge de la LAN, por URL configurada (o QR)

En degradado tiene que ser **imposible** creer que estás en línea:

```
MODO LOCAL — sin conexión a Xabor Cloud
Última sincronización: 21:04
Operaciones pendientes de subir: 37
```

Sin rojo alarmista: el turno está funcionando, no roto. El rojo se reserva
para cuando de verdad haya que parar.

## Impresión en modo local (Parte 15)

Tablet → Edge → impresora. La comanda **no** sale del restaurante durante un
corte. Reutiliza el motor de ruteo y el modelo de trabajos del Edge de
impresión; no se duplica el motor.

## Estado

Journal, proyección, identidad y sincronización: **implementados y probados**.
API local del Edge, caché de menú, PIN offline e interfaz degradada:
**diseñados, no implementados**. Ver el roadmap.
