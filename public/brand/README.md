# Xabor — Brand Assets

## Estado actual
Los archivos reales del logotipo (PNG completo + isotipo) están pendientes de
recepción como archivos descargables. Esta carpeta está lista para recibirlos.

## Estructura esperada
- `xabor-logo-full.png` / `.webp` — logotipo completo (isotipo + wordmark)
- `xabor-isotype.png` / `.webp` — solo la X
- `favicon-16.png`, `favicon-32.png`, `favicon-48.png`
- `icon-192.png`, `icon-512.png` — íconos PWA
- `apple-touch-icon-180.png`
- `source/` — archivos originales SIN MODIFICAR, nunca editados directamente

## Reglas (no negociables)
1. Nunca redibujar ni deformar el logotipo — solo remover el fondo blanco
   para generar variantes transparentes.
2. Conservar proporción, geometría y el naranja original exactos.
3. No existe todavía una versión oscura de las letras — para fondos oscuros,
   usar el isotipo naranja solo, o el logotipo sobre una superficie clara.
4. Los originales en `source/` nunca se tocan; todo derivado se genera a
   partir de una copia.

## Pendiente al recibir los archivos
- [ ] Colocar originales en `source/`
- [ ] Generar variantes transparentes (solo remoción de fondo blanco)
- [ ] Generar WebP optimizados
- [ ] Generar favicons 16/32/48
- [ ] Generar íconos PWA 192/512
- [ ] Generar apple-touch-icon 180
- [ ] Evaluar máscara/ícono monocromático (solo si no altera la marca)
- [ ] Documentar tamaño mínimo y márgenes de seguridad
- [ ] Sustituir favicon.svg actual y las referencias en landing/panel
