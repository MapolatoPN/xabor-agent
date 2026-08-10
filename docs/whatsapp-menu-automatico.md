# Menú automático de WhatsApp

Cada negocio sube su menú desde su propio panel, y Xabor lo envía solo cuando
un cliente lo pide por WhatsApp.

## Qué sube el negocio

**Una imagen** con su menú. Nada más. No hay PDF, ni varias páginas, ni
carrusel, ni video en esta versión.

Formatos aceptados: **JPG, PNG y WEBP**. El formato se verifica leyendo los
primeros bytes del archivo y decodificándolo, no por la extensión: un `.jpg`
que en realidad es un SVG, un HTML o un ZIP se rechaza aunque se llame como
una foto.

Tamaño máximo: el que fije `MEDIA_MAX_IMAGE_MB` (8 MB por defecto). Antes de
guardarla, Xabor la redimensiona a un máximo de 2048 px por lado y la
re-codifica: eso reduce el peso y, de paso, elimina los metadatos EXIF —una
foto del menú tomada con el celular puede llevar dentro la ubicación GPS del
local—.

## Dónde se guarda

En el mismo almacenamiento privado que ya usan los PDF de chat y las imágenes
de conversación (`src/services/almacenamiento.js`). En producción eso es
**Cloudflare R2** (`STORAGE_DRIVER=s3`, bucket `xabor-production-files`), que
sobrevive a cualquier redeploy o reinicio del contenedor. En desarrollo y
pruebas, disco local.

La imagen **nunca** tiene una URL pública. La vista previa del panel la sirve
el propio backend revalidando la sesión en cada petición, y para mandarla por
WhatsApp los bytes viajan directo del almacenamiento privado a Meta.

## Cómo se activa

Panel del negocio → **Config** → sección **Menú automático**.

1. Subir la imagen.
2. Revisar la vista previa.
3. Ajustar las frases si hace falta.
4. **Activar**.

No se puede activar sin imagen: un menú "activo" que no manda nada es peor que
uno apagado, porque el negocio cree que funciona.

Solo el **administrador** del negocio puede ver y cambiar esta sección. Mesero,
staff y repartidor reciben 403 — tanto en el panel como si llamaran la API
directamente.

## Frases

Xabor no gasta una llamada de IA para adivinar si alguien pidió el menú:
compara el mensaje contra una lista de frases que el negocio controla.

Por defecto: `menu`, `menú`, `carta`, `precios`, `lista de precios`,
`que venden`, `qué venden`, `que tienen`, `qué tienen`.

Antes de comparar, el mensaje se normaliza: minúsculas, sin acentos, sin signos
de puntuación y sin espacios de más. Así `"¿Me mandas el MENÚ?"` y
`"me mandas el menu"` son lo mismo.

Una frase dispara solo si aparece como palabra completa: `menu` responde a
"me mandas el menu" pero no a "quiero unas menudencias". Y los comentarios en
pasado no cuentan: *"el menú estuvo muy bueno ayer"* no manda nada.

Las frases son texto, nunca expresiones regulares. Escribir `.*` como frase no
convierte el menú en un comodín.

## Qué recibe el cliente

Primero el texto:

> Claro 👇 Te comparto nuestro menú.

y enseguida la imagen. Una sola vez: cuando el menú automático responde, el
mensaje ya no pasa por la IA, así que el cliente no recibe además otra
respuesta distinta.

## Qué pasa si falla

Si la imagen no se puede leer o Meta rechaza el envío, **Xabor no finge que lo
mandó**. El cliente recibe:

> No pude enviar el menú en este momento. En un momento te ayudamos.

y el fallo queda en los logs con el prefijo `[Menu WA]` y el negocio afectado.
El webhook responde normal y el proceso sigue vivo: un menú que falla no puede
tumbar la atención de WhatsApp.

## Cómo reemplazar el menú

Subir una imagen nueva desde el panel. **La siguiente solicitud ya recibe la
nueva** — no hace falta deploy, ni reiniciar, ni avisarle a nadie.

Xabor no guarda el `media_id` de Meta entre envíos: sube la imagen en cada
solicitud. Es una llamada extra a Meta por menú enviado, y a cambio no existe
la posibilidad de que un cliente reciba el menú viejo porque quedó cacheado.
La imagen anterior se borra del almacenamiento después de que la nueva ya está
registrada, nunca antes.

**Quitar imagen** desactiva el menú automático y borra el archivo. Se puede
volver a subir cuando el negocio quiera.

## Nota sobre el menú anterior

Hasta esta versión, el bot mandaba siempre el mismo archivo:
`public/menu.png`, versionado dentro del repositorio y servido en una URL
pública. Era el mismo para todos los negocios, así que cualquiera que no fuera
el dueño de ese PNG estaba mandando el menú equivocado.

Ese camino ya no existe. Mientras un negocio no suba su menú, Xabor no manda
ninguna imagen — responde con texto, como siempre, pero nadie recibe el menú de
otro. El archivo `public/menu.png` quedó sin usar y puede borrarse una vez que
los negocios activos hayan subido el suyo.
