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
5. Para todas: volver a firmar sin `--terminales` (o editar `vigente.json`
   quitando la lista), commit y despliegue.

Si una PC rechaza la versión, el log dice `estado=rechazada motivo=…`.

## Pruebas

`node test/fase-edge-actualizacion.mjs`: 23 de 23 (16 sin base, 7 con el
servidor real y Postgres).
- **A. Verificador:** firma, paquete exacto, rutas, versiones.
- **B. Lanzador:** como proceso de verdad. Aplica y confirma; revierte tras
  caídas, si no carga y si no se conecta; rescata `edge/` tras un apagón; no
  aplica un `edge.nueva` ajeno; solo la misma versión se confirma.
- **C. Edge:** de dónde baja, sin lanzador no hace nada, no reinicia con la
  cola ocupada (salvo el tope), un trabajo recién llegado aplaza el reinicio.
- **D. Servidor real:** sirve solo el paquete exacto; ofrece solo a quien
  toca; de punta a punta ofrece, verifica, baja, prepara y pide reiniciar; la
  versión a prueba se confirma al conectarse; un manifiesto de otra clave se
  rechaza sin bajar nada; un paquete cambiado en el servidor no se instala;
  un Edge sin lanzador no se toca.

**Mordidas:** (se completa al terminar la corrida)
