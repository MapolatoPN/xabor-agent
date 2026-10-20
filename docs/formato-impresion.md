# Formato de impresión configurable

Rama `feat/formato-configurable`, sobre `feat/impresion-sin-perdidas`. Hoy el
papel lo arma el Edge, el programa instalado en cada PC, y cambiar su diseño
exige tocar esa PC. Desde este cambio **el servidor arma el papel** y el Edge
solo lo imprime. El diseño de la comanda y del ticket se cambia con un
despliegue o, desde el paso 2, desde el panel de cada negocio.

## Cómo funciona

```
servidor (src/printing/formato/)          Edge (edge/renderers/formato.js)
  datos del pedido + diseño del negocio      renglones → ESC/POS
  + ancho de ESA impresora                    tabla de acentos, saneado,
  → payload.formato = { v:1, renglones }      última defensa del ancho
```

- `maquetador.js` convierte texto y estilo en renglones que caben en el papel:
  12 puntos por letra, letra alta, ancha o doble, y aire entre letras.
- `comanda.js` arriba y en grande pone el número de orden (o la mesa), el tipo
  y la hora, y el cliente. Cada platillo va en el tamaño más grande que no lo
  parta. Las opciones salen en lista, grandes y en negritas, sin repetirse en
  la nota. Agrupa por persona, imprime «cambio de» y la nota del pedido en su
  propio renglón. Sin precios.
- `ticket.js` es el ticket de siempre, con el encabezado del negocio tomado de
  Configuración (nombre, dirección, RFC, teléfono, WhatsApp). Un dato vacío no
  deja su etiqueta. La nota no repite las opciones.
- `index.js`: `formatoDeDocumento()` nunca lanza; si algo falla, el trabajo
  sale sin `formato`. También arma la cancelación y la prueba de impresora.
- `opciones.js` guarda el diseño por negocio en `configuracion`, clave
  `impresion_formato` (JSON). `normalizarFormato()` valida todo lo que llega:
  un valor desconocido cae al de fábrica.

`impresionService` le pone el formato a cada trabajo: comanda de pedido y de
mesa, «Reenviar a cocina», cancelación, ticket y prueba. Lo arma al ancho de
la impresora destino y con el diseño de su negocio. La reimpresión agrega
«*** REIMPRESION ***» una sola vez.

### El documento v1

Cada renglón es uno de estos:
- `{ texto, tam, negrita, alinear, invertido, subrayado, aire }`;
- `{ linea: '=' | '-' }`;
- `{ espacio: n }`;
- `{ qr: { size, data } }`;
- `{ corte: true }`.

`tam` es normal, alto, ancho o doble. `aire` va de 0 a 4 puntos.

## Compatibilidad

- **Edge instalado hoy (v1.1.0):** no conoce `formato`, lo ignora e imprime
  como siempre. El payload de siempre viaja intacto. Lo prueba el caso 19
  con el renderer de la v1.1.0.
- **Edge nuevo sin `formato`, o con uno raro, o que falla al leerlo:**
  imprime el diseño de siempre (caso 18).
- **Documentos sin armador** (por ejemplo `corte_caja`): salen sin
  `formato`, como hoy.

## Diseño de fábrica y opciones

| Comanda | Fábrica | Opciones |
|---|---|---|
| nombre del negocio, cliente, mesero, estación | sí | sí / no |
| número de orden o mesa | letra doble | doble / alta |
| platillo | auto: doble si caben 24 letras, si no alta | doble / alta / normal |
| opciones del platillo | alta y negritas | alta / normal |
| aire entre letras | auto: 2 puntos con papel de 48 | 0 / 1 / 2 |
| «Salsa:» antes de la opción | sí | sí / no |
| nota | negritas | negritas / blanco sobre negro |

| Ticket | Fábrica | Opciones |
|---|---|---|
| nombre, dirección, RFC, teléfono, WhatsApp | sí (si están capturados) | sí / no cada uno |
| desglose de opciones | sí | sí / no |
| total | letra doble | doble / alta |
| pie | «Gracias por su visita» | texto libre, 160 caracteres |

## Pruebas

`node test/fase-formato-impresion.mjs`: 23 de 23 (20 sin base, 3 con
Postgres). Las secciones son:
- maquetador: barrido de tamaños, aires y anchos, sin pasarse ni perder
  palabras;
- opciones;
- comanda;
- ticket;
- intérprete del Edge: solo comandos propios, texto saneado, vuelve a
  envolver, vuelve a normal;
- compatibilidad;
- servidor.

En la rama pasan 22 suites de impresión, cobro, Mesas y Edge.

**Mordidas:** cada una de las 16 garantías, desactivada por separado, tumba
su caso.

| Se desactiva | Casos que caen |
|---|---|
| platillo siempre en letra alta | 7, 14 |
| nota de la comanda sin limpiar opciones | 8, 21 |
| cliente omitido | 6, 21 |
| etiqueta de WhatsApp vacía | 12 |
| nota del ticket sin limpiar | 13 |
| medir sin sanear | 2, 9 |
| importe recortable | 3 |
| opciones sin validar | 5 |
| Edge sin sanear | 15 |
| Edge sin volver a envolver | 16 |
| Edge sin volver a normal | 17 |
| revisión del formato fuera del `try` | 18 |
| pedido sin formato | 21 |
| ancho fijo 42 | 21, 22 |
| sin el diseño del negocio | 21 |
| reimpresión sin marca | 23 |

La mordida del `try` encontró una falla real: un formato tan raro que hasta
revisarlo fallaba tumbaba la impresión, en vez de caer al diseño de siempre.

## En el panel: «Diseño de ticket y comanda»

Configuración → «🧾 Diseño de ticket y comanda» (solo administradores). Hay dos
pestañas, Comanda de cocina y Ticket del cliente. Cada opción tiene palabras
del restaurante, la vista previa está a escala (58 mm, 80 mm u 80 mm a todo
lo ancho) y cada cambio se guarda solo («Guardado ✓»). También está «Volver
al diseño de fábrica».

- **`panel/disenoPapel.js`** es un archivo propio, para tocar lo menos
  posible `index.html`, que es componente protegido. `index.html` solo
  agrega la tarjeta, la sección, la línea que la abre desde `cfgIr` y la
  etiqueta con `?v=<huella>`. Configuración se ensancha a 1100 px mientras
  la sección está abierta y vuelve a 560 al salir.
- **`src/printing/formato/rutas.js`** (`/api/impresion/formato`, detrás de
  `requireAdminSeguro`):
  - `GET` devuelve el diseño vigente;
  - `PUT` valida y guarda;
  - `POST /vista-previa` usa el MISMO armado que el papel real, con un
    pedido de ejemplo.

`node test/fase-diseno-papel-panel.mjs`: 6 de 6. Cubre:
- la huella y la tarjeta;
- que cada opción de la pantalla exista y el servidor la acepte;
- que solo el administrador entre;
- que se valide lo guardado;
- la vista previa en 32, 42 y 48;
- en Chrome real: cambiar, ver la vista previa, «Guardado ✓», recargar, tablet
  sin desbordes, volver a fábrica y el ancho de Configuración.

Mordidas, todas muerden:
- huella vieja (1);
- rutas sin exigir administrador (3);
- guardar sin validar (4);
- la vista previa ignora el diseño (6);
- la pantalla no guarda (6);
- no refresca (6);
- falta una opción (2);
- la tarjeta no abre (6);
- el ancho no regresa (6).

## Instalador Xabor Edge 1.2.0

`XaborEdgeSetup.exe`, 29,166,647 bytes.
SHA256 `8E8A9AF4A63C750259E8E431315535B2970CB4A543C891891ED62C0D7091F8F6`.

(Reemplaza a una primera compilación del mismo día, D0F0AF04…, que no traía
la actualización automática y nunca se publicó.)

**Contenido:**
- `edge/` e `installer/` del commit d7f6b0f, exportados con `git archive`
  (sin archivos sueltos de la carpeta de trabajo);
- `ws` 8.21.0;
- `node.exe` 22.23.3, la misma versión de producción. El zip se verificó
  contra el `SHASUMS256.txt` oficial de nodejs.org;
- WinSW 2.12.0, de la versión oficial en GitHub. No trae firma digital y su
  release no publica huella; el tamaño coincide con el publicado;
- compilado con Inno Setup 6.7.3, con firma válida de Pyrsys B.V.

El script del instalador (`installer/XaborEdge.iss`) es el de la 1.1.0,
validada en piloto, con lo de la actualización automática: copia el
lanzador, el verificador y la clave pública, el servicio arranca el lanzador
en vez de `edge\index.js`, y al reinstalar o desinstalar borra lo que haya
dejado una actualización. Al instalarse encima, como antes, detiene el
servicio, conserva la vinculación sin pedir código y no toca la cola en
ProgramData.

```
ISCC.exe XaborEdge.iss /DAppVersion=1.2.0 /DOrigenApp=<export> /DOrigenNode=<carpeta con node.exe 22.23.3> /DOrigenWinSW=<WinSW-x64.exe> /DSalida=<salida>
```

**Cambia respecto a la 1.1.0:**
- el intérprete del formato v1;
- el diseño legible para los trabajos sin formato;
- la tabla WPC1252 (acentos);
- el saneado del texto;
- la migración de la cola JSON a SQLite. No se sabe qué Node trae la
  1.1.0: si es anterior a 22.5, su cola es JSON, y lo pendiente pasa a SQLite
  al arrancar (`test/fase-edge-migracion-cola.mjs`);
- la **actualización automática**: desde aquí las versiones nuevas del Edge
  llegan solas, firmadas (`docs/edge-actualizacion-automatica.md`).

Con el Node 22.23.3 del instalador pasan:
- `fase-edge-gate`, `fase-edge-e2e`, `fase-edge-chaos`, `fase-print-jobs`;
- `fase-formato-impresion`, `fase-edge-texto-termico`, `fase-edge-tcp`;
- `fase-edge-migracion-cola`;
- `fase-edge-actualizacion` (25/25, con el lanzador y el Edge real como
  procesos).

**Publicarlo:**
1. En GitHub crear la release `edge-v1.2.0` y subir el `.exe`, con su
   SHA256 en la descripción, como la 1.1.0.
2. Cambiar la variable de Railway `XABOR_EDGE_SETUP_URL` a
   `https://github.com/MapolatoPN/xabor-agent/releases/download/edge-v1.2.0/XaborEdgeSetup.exe`.

**En cada sucursal,** en la computadora de las impresoras:
1. Abrir el enlace y descargar.
2. Doble clic. Windows avisa «Windows protegió su PC», porque no está
   firmado: «Más información» → «Ejecutar de todas formas».
3. Siguiente → Instalar. No pide código, porque ya está vinculada.

Para comprobarlo, «Imprimir prueba» debe sacar el renglón de acentos bien y
las líneas «Letra alta» y «Letra doble».

**Reversa:** reinstalar la 1.1.0 desde su release. Ojo: si esa versión usa
la cola JSON, lo que estuviera pendiente en la SQLite no se ve; la nube
reenvía lo no confirmado de la última hora.

## Lo que sigue

1. **Edge v1.2,** con este intérprete y la actualización automática,
   distribuido con el instalador de siempre (doble clic, conserva la
   vinculación). Es la última vez que hay que tocar las PCs: el diseño del
   papel ya se cambia desde el panel, y el código del Edge llega solo.
