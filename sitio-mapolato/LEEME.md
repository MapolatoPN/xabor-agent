# Páginas de Xabor para www.mapolato.com

El sitio www.mapolato.com NO se sirve desde este repositorio: es un sitio
estático en el hosting de Mapolato (nginx), que se actualiza subiendo archivos.
Esta carpeta guarda las páginas que ese sitio aloja y que hablan con Xabor.

## thanksgiving/ — pedidos de Thanksgiving por horario

`thanksgiving/index.html` es el formulario público. Se sube tal cual al
hosting como carpeta `thanksgiving`, junto al `index.html` del sitio:

```
www.mapolato.com/
  index.html
  assets/...
  thanksgiving/
    index.html      ← este archivo
```

Queda en `https://www.mapolato.com/thanksgiving/`. No necesita nada más del
sitio: el logo y el ícono se piden con su URL completa.

### Cómo funciona

- Los horarios y los pedidos viven en Xabor. La página pregunta a
  `https://xabor.mx/api/temporada/<clave>` y agenda con
  `POST https://xabor.mx/api/temporada/<clave>/pedidos`.
- Xabor solo acepta esas llamadas desde `https://www.mapolato.com` y
  `https://mapolato.com` (variable `TEMPORADA_ORIGENES` en Railway si algún
  día cambia el dominio).
- El cupo lo hace cumplir el servidor: por cada horario, un máximo de
  platillos (cocina, recoger + domicilio juntos) y un máximo de pedidos a
  domicilio. Si dos personas piden el último lugar al mismo tiempo, solo una
  entra; la otra ve los horarios actualizados.
- Reenviar el mismo formulario (doble clic, se cayó la red) no duplica el
  pedido.

### Sucursales

Al principio del `<script>` está la lista `SUCURSALES`, con la **clave
pública** de cada campaña:

| Sucursal | Clave |
|---|---|
| Mapolato Obispado (Piedras Negras) | `mapolato-obispado-thanksgiving-2026` |
| Mapolato Acuña | `mapolato-acuna-thanksgiving-2026` |

La clave tiene que ser idéntica a la de la campaña en Xabor
(`https://xabor.mx/temporada` → Configuración → Clave pública). Una campaña
apagada o que no existe no aparece en la página; si solo hay una encendida, la
página no pregunta sucursal.

### Encender la campaña

1. Entrar a `https://xabor.mx/temporada` con la cuenta de administrador de la
   sucursal.
2. «Crear campaña de Thanksgiving»: trae fecha (cuarto jueves de noviembre),
   9:00 a 16:00 en ventanas de 60 min, 40 platillos y 10 domicilios por
   ventana, y cierre el día anterior a las 20:00. Ajustar precio y texto.
3. Revisar que la clave pública coincida con la tabla de arriba.
4. Marcar «Recibiendo pedidos» y guardar.

### Probar en una computadora

Con Xabor corriendo en local (`dev-local.cmd`) y la campaña creada en esa
base, servir esta carpeta en `localhost` y abrir
`http://localhost:<puerto>/thanksgiving/?api=http://localhost:3000`. El
parámetro `api` solo funciona en `localhost`; en el sitio publicado se ignora.
Para que el navegador deje pasar la llamada, el Xabor local necesita
`TEMPORADA_ORIGENES=http://localhost:<puerto>`.
