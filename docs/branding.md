# Identidad visual de Xabor

Rama `feat/branding-sincronizado` (base de producción 207d912). **Sin
migración, sin cambios de lógica**: esto es marca y marcado (`<link>`,
`<img>`), nada más.

## Por qué seguía viéndose la marca vieja

La causa no era un archivo desactualizado, sino la **ausencia de
declaración**: de las doce superficies con HTML propio, **solo las dos de la
landing** declaraban `<link rel="icon">`. Las otras diez (panel, Superadmin,
Finanzas, login, crear/restablecer contraseña, Restaurante, estación de
meseros, repartidor) no declaraban ninguno, así que el navegador caía en la
convención: pedir **`/favicon.ico`** — que **respondía 404**. Sin respuesta,
la pestaña se queda con el icono que tuviera guardado, y ese icono podía ser
de cualquier despliegue anterior.

Encima, la marca gráfica estaba copiada a mano en cada pantalla: cuatro
pantallas de acceso usaban un **emoji de taco (🌮)** como logotipo, y ninguna
usaba el isotipo real. La identidad correcta es la **X naranja** del logotipo
del negocio junto a la palabra **XABOR**.

## Fuente única

Todo vive en **`public/brand/`** y se sirve bajo `/public/brand/`:

| Archivo | Qué es |
|---|---|
| `xabor-icono.svg` | **isotipo**: la X de Xabor en `#FF6B35`, redibujada del logotipo original del negocio. La fuente de todo lo demás |
| `xabor-logo.svg` | **logotipo**: isotipo + palabra "Xabor" |
| `xabor-icono-32/180/192/512.png` | derivados para favicon PNG, apple-touch-icon y manifest |
| `favicon.ico` | contenedor ICO con el PNG de 32 px, para lo que pide `.ico` a la fuerza |
| `xabor-social-v3.png` | **vista previa social vigente** 1200×630 |
| `xabor-social-v2.png` | vista previa anterior — sin consumidores |
| `xabor-social.png` (+ `.svg`) | vista previa original — sin consumidores |
| `site.webmanifest` | nombre, colores e iconos de la app |

Los PNG, el `.ico` y la imagen social **se generan** del SVG con
`node scripts/generar-assets-marca.mjs`; se versionan en el repo para que
arrancar no dependa de generarlos. Si la marca cambia, se edita el SVG y se
vuelve a correr el script — no se retoca ningún PNG a mano.

Se eliminó `public/landing/favicon.svg`: era una **segunda copia** del mismo
isotipo y es justo lo que hace que las marcas se desincronicen.

Color de marca: **`#FF6B35`** — el del logotipo que entregó el negocio, que
resultó ser el mismo naranja que el panel ya usaba. El `#C96220` que traía la
landing era una reconstrucción anterior y quedó retirado.

## Qué declara cada pantalla

Las doce superficies llevan el mismo bloque en el `<head>`:

```html
<link rel="icon" type="image/svg+xml" href="/public/brand/xabor-icono.svg?v=3">
<link rel="icon" type="image/png" sizes="32x32" href="/public/brand/xabor-icono-32.png?v=3">
<link rel="apple-touch-icon" sizes="180x180" href="/public/brand/xabor-icono-180.png?v=3">
<link rel="manifest" href="/public/brand/site.webmanifest?v=3">
<meta name="theme-color" content="#FF6B35">
```

Y el servidor responde las tres direcciones que los navegadores piden **sin
mirar el HTML**: `/favicon.ico`, `/apple-touch-icon.png` (y su variante
`-precomposed`) y `/site.webmanifest`. No son copias: sirven los mismos
archivos de `public/brand/`.

## Caché

El favicon se cachea con fuerza, así que reemplazar el archivo no basta:

- Los `<link>` llevan **`?v=3`**. Al subir ese número el navegador considera
  que es otra URL y vuelve a pedirla. **Es el único paso necesario** cuando la
  marca cambie en el futuro.
- `/favicon.ico` no admite query (el navegador pide esa ruta exacta), así que
  se sirve con `Cache-Control: public, max-age=86400`: como mucho un día para
  que todo el mundo tenga el icono nuevo.

**Quien ya tenía Xabor abierto** puede seguir viendo el icono anterior en esa
pestaña hasta que la cierre o haga una recarga forzada; una pestaña nueva ya
recibe el correcto. No hay que pedirle a nadie que limpie su caché.

## Lo que NO se tocó

- **`/logo.png`** (`panel/logo.png`) **no es la marca de Xabor**: es el
  logotipo que se imprime en el **ticket del negocio**, oculto en pantalla y
  en escala de grises al imprimir. Cambiarlo pondría la marca de Xabor en el
  ticket que recibe el cliente del restaurante. Se deja como está.
  *(Pendiente aparte: hoy es un archivo único para todos los negocios, así que
  todos imprimen el mismo logotipo. Es un asunto de multi-tenant, no de
  marca.)*
- **Los colores de la interfaz.** El panel ya usaba `#FF6B35`, así que con el
  logotipo real quedó alineado solo. Restaurante sigue con `#f97316`:
  unificarlo cambiaría el color de sus botones y es trabajo de la fase de
  design tokens, no de un intercambio de assets.
- Pedidos, Restaurante, meseros, POS, pagos, folios, arranque, impresión,
  autenticación (más allá del logotipo en el marcado) y migraciones.

## Correos

Las plantillas no traían logotipo antiguo — no traían ninguno. Se dejó el
texto igual y solo se cambió el botón principal de negro genérico a
**`#FF6B35`**, para que el correo se parezca al producto. No se incrusta el
isotipo como imagen: los clientes de correo bloquean imágenes remotas por
omisión y un logotipo roto se ve peor que ninguno.

## Pruebas

`test/fase-branding.mjs` (10 casos) le pide las páginas al servidor y
comprueba lo que recibiría un navegador: que el isotipo canónico se sirva y
sea la marca aprobada, que existan todos los derivados, que `/favicon.ico` ya
no dé 404, que el manifest sea válido y apunte a iconos que existen, que las
doce superficies declaren icono/apple-touch/manifest/theme-color con versión,
que no quede ningún resto de la identidad anterior, que **ningún asset
referenciado responda 404** y que nadie sirva marcas fuera de
`/public/brand/`.

## Cambiar la identidad a propósito

`test/fase-scope-marca.mjs` fija la identidad canónica (isotipo, iconos,
manifest, `theme-color`, versión y wordmark) en una sola constante y
comprueba que **todas** las superficies del producto la declaren igual.

Eso significa que la marca **sí se puede cambiar**, pero ya no de forma
invisible: hay que editar `IDENTIDAD` en esa prueba, y ese cambio aparece en
el diff de la rama. Nació de un caso real: una rama cuyo objetivo era
rediseñar la landing acabó cambiando también el favicon y el `theme-color`
de `/app`, Superadmin, Restaurante y la estación de meseros. Fue una decisión
consciente y autorizada —el isotipo anterior era una reconstrucción, no el
logotipo del negocio—, pero no se notó hasta la revisión.

La prueba también vigila la frontera contraria: que los estilos y la
estructura de la landing **no** se filtren a ninguna pantalla del producto.

## Vista previa social

`public/brand/xabor-social-v3.png` (1200×630) es lo que ven WhatsApp,
Facebook, LinkedIn y X cuando alguien comparte https://xabor.mx/. No se
genera con `generar-assets-marca.mjs`: es arte terminado, entregado por el
dueño; el repositorio solo lo reescala a la medida de Open Graph y reescribe
la banda de precio.

### El copy aprobado de la banda

La v2 decía **"$990 al mes · Promoción agosto y septiembre"**, que se lee
como $990 en agosto *más* otros $990 en septiembre. No es la oferta. El copy
vigente, en este orden de jerarquía:

1. **$990 TOTAL**
2. **Agosto + septiembre**
3. **Instalación incluida · Después $990/mes**

Importa porque mucha gente ve la imagen en WhatsApp y nunca abre la página:
la promoción tiene que entenderse sin contexto. La tarjeta de precio de la
landing dice lo mismo, y `fase-landing-v2` comprueba que no se separen.

`scripts/banda-social-v3.mjs` reescribe esa banda sobre el arte original a
resolución completa y reescala a 1200×630. Lleva anotada la geometría medida
del original (banda `x 63..776, y 702..819`, icono en `(122,761)`), de modo
que el marco y el icono se conservan intactos y solo cambia el texto. La
tipografía de la banda es **Century Gothic**, la geométrica más cercana a la
del arte; el resto de la imagen conserva su tipografía original.

### El nombre cambia en cada versión

Las redes cachean la vista previa *por URL* y no vuelven a pedirla durante
días aunque el archivo cambie. Por eso `-v2` y luego `-v3`: **cambiar la
imagen social significa cambiar el nombre del archivo**, nunca sobrescribirlo.

`xabor-social.png`, `xabor-social.svg` y `xabor-social-v2.png` **ya no los
referencia ninguna página**. Se conservan como histórico; retirarlos es una
limpieza aparte, no un cambio de marca.

Esto no toca el favicon, el isotipo, el manifest ni el `theme-color`: son
cosas distintas, y `fase-scope-marca` lo comprueba.
