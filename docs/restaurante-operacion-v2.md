# Xabor · Restaurante — operación v2

Rama `feat/restaurante-operacion-v2` (base de producción a93930a). **Sin
migración nueva**: el motor de Restaurante (mesas, cuentas, rondas,
modificadores, división, pagos, cierre) ya existía y no se tocó. Lo que
cambia es la capa de interacción y dos datos adicionales que el tablero
necesitaba.

## Filosofía

El criterio dejó de ser "la API responde" y pasó a ser **si un mesero puede
trabajar en hora pico sin capacitación**. De ahí salen las decisiones:

- **El mesero no tiene que entender cómo está construido Xabor.** No se le
  pide elegir su nombre otra vez, no se le muestran módulos, no se le ofrecen
  acciones que su rol no puede ejecutar.
- **Menos toques.** Un producto simple entra con un toque. Uno con opciones
  avanza solo cuando ya no queda nada que decidir.
- **Nada de desplegables para capturar.** El flujo principal es visual:
  categorías a un lado, productos en rejilla, cuenta a la vista.
- **Leer poco.** Cada pantalla hace una pregunta a la vez.

## Una sola experiencia

Hay **una** pantalla operativa (`panel/mesas.html`), servida en dos rutas:

| Ruta | Quién llega ahí |
|---|---|
| `/restaurante` | el administrador desde `/app` → pestaña **Restaurante**, y el mesero tras su PIN |
| `/mesas.html` | la misma pantalla, para enlaces y tablets que ya la tenían guardada |

`/mesero/<slug>` sigue siendo la puerta del mesero (QR, tablet fija,
celular), pero al entrar cae en el **mismo** espacio de trabajo: barra de
Xabor arriba, nombre del restaurante, quién está trabajando. No es un
micrositio aparte.

La diferencia entre roles no es la pantalla, son las acciones:

| | Mesero (estación) | Admin / staff (panel) |
|---|---|---|
| Tablero de mesas, abrir mesa | sí | sí |
| Tomar orden, modificadores, comanda | sí | sí |
| Dividir cuenta, mover de mesa | sí | sí |
| Registrar pago, cerrar cuenta | **no se le muestra** | sí |
| Captura libre (producto con precio manual) | **no se le muestra** | sí |
| Cancelar un item ya capturado | no | solo admin |
| Barra: enlace al panel | no (botón **Salir**) | sí |

**Ocultar no es proteger.** El backend responde 403 igual: `pagos` y `cerrar`
exigen sesión de panel, y las dos puertas administrativas rechazan el rol
`mesero`. La UI solo deja de ofrecer lo que de todas formas iba a fallar.

## Tablero de mesas

Cada mesa se lee de un vistazo: número, mesero, personas, minutos desde que
abrió e importe. El estado es accionable, no decorativo:

| Estado | Cuándo |
|---|---|
| **Disponible** | sin cuenta abierta |
| **Por enviar** | hay items capturados que no han salido a cocina (muestra cuántos) |
| **Cobrando** | ya hay pagos parciales y queda saldo |
| **Ocupada** | el resto |

Filtro **Mis mesas / Todas**: el mesero arranca en las suyas, quien
administra en todas. "Mis mesas" nunca esconde las mesas libres — desde ahí
se abre una nueva.

Para esto `GET /api/restaurante/mesas` agrega dos campos (aditivos, sin
cambiar nada de lo existente): `meseroUsuarioId` y `pendientes`.

## Abrir mesa

Mesero: toca la mesa → elige personas en botones grandes → **Abrir mesa**. No
se le vuelve a preguntar quién es: el servidor asigna al mesero autenticado y
**no acepta** que abra a nombre de otro aunque el cliente mande otro id.

Admin o soporte: además elige al mesero local (con su PIN si no es él mismo),
como ya funcionaba.

## Toma de orden

Tres zonas: **categorías · productos · cuenta**.

- Las categorías son botones; tocar una pinta sus productos de inmediato.
- Los productos son tarjetas grandes con nombre y precio, y marcan
  "Con opciones" cuando abren wizard.
- Hay un buscador por nombre para cuando el menú crece; el flujo principal no
  depende de él.
- En tablet horizontal (1024) la cuenta sigue al lado. Por debajo de 960 px
  pasa a hoja inferior y una barra fija conserva total y acción principal. En
  celular las categorías se vuelven una tira horizontal y los productos van a
  dos columnas.

## Modificadores secuenciales

`panel/modificadores.js` es el único lugar donde viven las reglas y el
cálculo de referencia. Expone dos presentaciones sobre la misma lógica:

- `abrirModal(producto)` — formulario completo. **POS lo sigue usando**: esta
  fase es de Restaurante y no rediseña el resto de Xabor.
- `abrirWizard(producto)` — un grupo por pantalla, para tablet.

En el wizard:

- Encabezado "Paso 2 de 3" + nombre del grupo + su regla ("Elige 1", "Elige
  1–2").
- Opciones como botones de 56 px con el extra a la derecha (`+$30.00`).
- **Avance automático** cuando ya no queda nada que decidir: grupo de una
  sola opción al elegir, grupo múltiple al llegar a su máximo. El botón
  "Continuar" solo aparece cuando de verdad hace falta.
- **Atrás** en cualquier paso.
- Resumen final con lo elegido, cantidad y total, y un botón grande
  **Agregar a la mesa**.

**El precio final lo hace el servidor.** El wizard manda ids de opción; si el
cliente mandara un precio, se ignora (`resolverProductoConModificadores`
resuelve nombre, precio, reglas, pertenencia al negocio y disponibilidad).
Una opción de otro restaurante responde 400.

### Toques reales

| Flujo | Toques |
|---|---|
| Bebida sin opciones | **1** (producto) |
| Chilaquiles con 3 grupos | **6**: producto → salsa → proteína → guarnición → guarnición (o "Continuar") → **Agregar a la mesa** |

Cinco de esos seis son decisiones del comensal; el sexto es la confirmación
con el total a la vista, que es lo que evita mandar a cocina algo mal armado.

## Rondas: pendiente vs enviado

La cuenta separa lo que ya salió de lo que no:

```
RONDA 1 · 07:42                 ✓ Cocina
  1× Chilaquiles
     Salsa: Verde · Proteína: Bistec · Guarniciones: Frijoles, Papas
  1× Coca-Cola
────────────────────────────────────────
PENDIENTE DE ENVIAR                    2
  2× Coca-Cola
[ ENVIAR COMANDA (2) ]
```

Los modificadores se juntan por grupo para leerse rápido. La ronda no guarda
su propia hora: se usa la del primer item que salió en ella. **Enviar comanda
manda solo lo pendiente** — nunca reimprime rondas anteriores — y el botón se
apaga cuando no hay nada por mandar.

## Lo que NO se hizo (a propósito)

- **No se tocó el motor**: mismas rutas, misma concurrencia, mismos folios.
- **No se tocó POS, Superadmin, repartidores, rewards, bot, corte ni
  impresión.**
- **Reasignar mesero en una cuenta abierta** sigue sin existir en el core.
- **Cobro por el mesero**: sigue siendo decisión de producto pendiente. Hoy
  cobra y cierra la caja.
- Sin impresión LAN, sin offline, sin framework nuevo.

## Pruebas

`test/fase-restaurante-operacion-v2.mjs` (30 casos): entrada del mesero,
permisos cerrados de verdad, tablero, autoasignación, menú y rejilla, wizard
y sus reglas, extra de $30 resuelto por el servidor, rondas, aislamiento
entre restaurantes, turnos en tablet compartida y render (scripts que
compilan como los lee el navegador, tamaños táctiles, media queries).

`test/seed-restaurante-demo.mjs` deja un restaurante de demostración
(categorías, chilaquiles con tres grupos, mesero con PIN) para revisar la
pantalla en un navegador real sin tocar ningún negocio.
