# Actualización automática de Xabor Edge

Desde la 1.2.0, el Edge (el programa de las impresoras en la PC de cada
sucursal) se actualiza solo. El instalador 1.2.0 es la última vez que alguien
tiene que tocar esas PCs para cambiar el código del Edge. Las siguientes
versiones llegan con un despliegue del servidor, como cualquier otro cambio.

## Cómo funciona

```
computadora del dueño          servidor (Railway)             PC de la sucursal
  firma la versión X     →     la publica y avisa     →     el Edge comprueba la firma,
  (clave privada)              «existe la X»                baja el paquete, lo verifica,
                                                            espera a que la cola esté
                                                            quieta y se reinicia
                                                                  ↓
                                                            el lanzador aplica la X y
                                                            la deja «a prueba» hasta que
                                                            se conecta con la nube
```

1. El dueño firma la versión nueva en su computadora
   (`scripts/edge/firmar-actualizacion.mjs`). La firma se hace con una clave
   privada que solo existe ahí.
2. El paquete firmado entra al repositorio (`edge-actualizaciones/`) y sale
   con un despliegue normal.
3. Al conectarse, cada Edge dice su versión. Si es menor que la vigente, la
   nube le manda el manifiesto: versión, SHA-256, tamaño y firma.
4. El Edge comprueba la firma con la clave pública que trae su instalador.
   Si no es la del dueño, no baja nada. Si lo es, baja el paquete del MISMO
   servidor configurado (nunca de una dirección que venga en el mensaje), y
   comprueba tamaño, SHA-256 y que cada archivo vaya dentro de `edge/`.
5. Espera a que la cola esté quieta: nada listo para imprimir, nada a medio
   enviar y ningún trabajo recibido en los últimos 30 segundos (con un tope
   de 15 minutos, por si una impresora apagada deja trabajos en reintento).
6. Se detiene en orden y sale con el código 75. Windows reinicia el servicio,
   igual que cuando el Edge se cae.
7. Al arrancar, el lanzador aplica la versión nueva y guarda la anterior.
   La nueva queda **a prueba** hasta que se conecta con la nube.

**Regresa sola a la versión anterior** si la nueva:
- no se puede cargar (un archivo roto): en ese mismo arranque;
- se cae al arrancar 3 veces seguidas: al cuarto arranque;
- no se conecta con la nube en 10 minutos.

Esa versión queda **rechazada** en esa PC y no se vuelve a instalar sola. La
copia que falló queda en `edge.fallida-<versión>` para revisarla. Una versión
más nueva sí se instala.

## Las piezas

| Archivo | Qué hace | ¿Se actualiza solo? |
|---|---|---|
| `installer/lanzador.mjs` | lo que arranca el servicio: aplica, prueba y revierte | **no** |
| `installer/actualizador.mjs` | comprueba firma, SHA-256, tamaño, rutas y versión | **no** |
| `installer/clave-publica-actualizaciones.pem` | con ella se comprueba la firma | **no** |
| `edge/actualizacion.js` | recibe la oferta, baja, espera la cola, pide reiniciar | sí |
| `edge/version.js` | la versión del código | sí |
| `src/printing/actualizacionesEdge.js` | la nube: ofrece y sirve el paquete | (servidor) |
| `scripts/edge/generar-clave-actualizaciones.mjs` | crea el par de claves, una vez | — |
| `scripts/edge/firmar-actualizacion.mjs` | firma una versión | — |

Las tres primeras van con el instalador. Un paquete firmado solo puede traer
la carpeta `edge/`: lo que decide si una versión es del dueño, y lo que la
revierte si falla, no lo puede cambiar una actualización.

Lo que **sigue necesitando instalador:** cambiar Node, WinSW, el lanzador, el
verificador o la clave. Y los Edges 1.1.0 no se actualizan solos: les falta
el lanzador. Por eso la 1.2.0 se instala a mano una vez.

## La clave privada

Está en `%USERPROFILE%\.xabor\clave-privada-actualizaciones-edge.pem` de la
computadora del dueño, generada el 20-oct-2026. Nunca va al servidor ni a GitHub (`.gitignore`
ignora `clave-privada*` por si acaso).

- **Respaldarla** (USB o gestor de contraseñas). Si se pierde, las PCs ya
  instaladas no aceptan versiones firmadas con otra clave: habría que hacer
  un instalador nuevo con la clave pública nueva y pasar por cada PC.
- **No compartirla.** Quien la tenga puede instalar código en las PCs de los
  restaurantes. El servidor, aunque lo comprometieran, no puede: sin la clave
  solo puede avisar de versiones que el Edge rechaza.

## Publicar una versión nueva del Edge

1. Subir `VERSION_EDGE` en `edge/version.js` (por ejemplo `1.2.1`) y hacer
   commit con el cambio del Edge.
2. Firmar, primero para una sola PC:
   ```
   node scripts/edge/firmar-actualizacion.mjs --version 1.2.1 --terminales <terminalId>
   ```
   Toma `edge/` del commit (no de la carpeta de trabajo) y, antes de escribir
   nada, lo comprueba con el mismo verificador y la misma clave pública del
   instalador. Escribe `edge-actualizaciones/edge-1.2.1.json`,
   `edge-1.2.1.manifiesto.json` y `vigente.json`.
3. Commit de `edge-actualizaciones/` y despliegue del servidor (a la rama de
   despliegue, como siempre).
4. Comprobar en los logs de Railway:
   - `[Edge] actualización ofrecida terminal=… de=1.2.0 a=1.2.1`;
   - `estado=preparada`, `estado=reiniciando`;
   - `Terminal autenticada … version=1.2.1`;
   - `estado=confirmada`.

   Imprimir una prueba desde el panel.
5. Para todas: quitar la lista `terminales` de
   `edge-actualizaciones/vigente.json` (queda `{ "version": "1.2.1" }`),
   commit y despliegue. No se vuelve a firmar: el script se niega a firmar
   una versión que no sea mayor que la vigente.

Si una PC rechaza la versión, el log dice `estado=rechazada motivo=…`.

## Pruebas

`node test/fase-edge-actualizacion.mjs`: 25 de 25 (17 sin base, 8 con el
servidor real y Postgres), con Node 24 y con el Node 22.23.3 del
instalador; tres corridas seguidas sin intermitencias.
- **A. Verificador (1–4):** firma, paquete exacto, rutas, versiones.
- **B. Lanzador (5–13),** como proceso de verdad:
  - aplica y confirma;
  - revierte tras caídas, si no carga y si no se conecta;
  - rescata `edge/` tras un apagón;
  - no aplica un `edge.nueva` ajeno;
  - solo la misma versión se confirma;
  - el plazo para conectarse cuenta desde cada arranque.
- **C. Edge (14–17):**
  - de dónde baja;
  - sin lanzador no hace nada;
  - no reinicia con la cola ocupada (salvo el tope);
  - un trabajo recién llegado aplaza el reinicio.
- **D. Servidor real (18–25):**
  - sirve solo el paquete exacto y ofrece solo a quien toca;
  - de punta a punta: ofrece, verifica, baja, prepara y pide reiniciar;
  - la versión a prueba se confirma al conectarse;
  - un manifiesto de otra clave se rechaza sin bajar nada;
  - un paquete cambiado en el servidor no se instala;
  - un Edge sin lanzador no se toca;
  - **25:** el lanzador y el Edge real como procesos: sale con 75, el
    siguiente arranque aplica la versión y la nube la ve confirmada.

Lo que estas pruebas NO cubren es el reinicio que hace Windows tras la salida
con 75: el caso 25 vuelve a lanzar el proceso a mano. Es el mismo mecanismo
que ya levanta al Edge cuando se cae (WinSW no reporta parada limpia con una
salida distinta de 0), pero la primera versión debe ir a una sola PC.

**Mordidas:** las 34 garantías, desactivadas una por una, tumban al menos un
caso.

| Se desactiva | Casos que caen |
|---|---|
| verificar la firma | 1, 22 |
| comparar el SHA-256 | 2, 23 |
| comparar la versión de adentro del paquete | 2 |
| revisar las rutas | 3 |
| exigir `index.js` | 3 |
| exigir versión mayor | 4 |
| recordar las rechazadas | 4, 7 |
| confirmar solo la misma versión | 12 |
| revertir tras 3 caídas | 7 |
| revertir si no carga | 8 |
| el vigía de 10 minutos | 9, 12 |
| revertir una versión vencida | 9, 12 |
| rescatar `edge/` | 10 |
| revisar el `.version` de `edge.nueva` | 11 |
| plazo por arranque (no desde que se aplicó) | 13 |
| quitar credenciales de la URL | 14 |
| apagada sin lanzador | 15 |
| esperar el envío en curso | 16 |
| esperar la cola lista | 16 |
| el tope de espera | 16 |
| esperar tras un trabajo recién llegado | 17 |
| la ruta solo sirve `edge-X.Y.Z.json` | 18 |
| ofrecer solo a versiones menores | 19 |
| no ofrecer a un Edge sin versión (las dos defensas) | 19 |
| respetar la lista de terminales | 19 |
| el Edge atiende la oferta | 20, 22, 23, 25 |
| el Edge manda su versión | 20, 22, 23, 25 |
| la nube ofrece | 20, 22, 23, 25 |
| la nube registra el estado | 20, 22, 23, 25 |
| el Edge informa a la nube | 20, 22, 23, 25 |
| confirmar al conectarse | 21, 25 |
| verificar el manifiesto antes de bajar | 22 |
| salir con 75 (no con 0) | 25 |
| el lanzador le pasa el verificador | 5–13, 25 |
