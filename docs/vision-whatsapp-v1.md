# Xabor Vision V1 — análisis de imágenes de WhatsApp

**Regla central: VISIÓN INTERPRETA, XABOR DECIDE.** El modelo visual nunca
le responde al cliente; produce un análisis estructurado que el agente de
conversación usa como contexto **no confiable** y contrasta contra el menú
y las promociones reales del negocio.

## Arquitectura

```
WhatsApp (Meta webhook)
  → manejarImagenEntrante          archiva la foto (documentos + storage),
                                   descarga en 2º plano, devuelve el turno
                                   [[xabor:imagen:<documentoId>]] YA
  → cola de 6 s (colaMensajes.js)  agrupa texto + fotos en UN turno
  → al vencer la cola:
      soloImagenes()   → fallback determinista (foto muda, sin visión)
      con palabras     → documentosDelTurno() → visionHabilitada()
                       → analizarImagenesDeTurno() (máx 2 fotos)
                            espera acotada a que la descarga termine
                            → leerArchivo → normalizar → Claude (visión)
                            → validar schema → [CONTEXTO VISUAL]
                       → prepararTurnoParaIA(turno, contextos)
  → procesarConClaude → brain.js (agente normal, sin cambios)
  → UNA respuesta al cliente
```

- **El webhook nunca espera a visión** (lección del smoke C: nada lento en
  el camino crítico). Todo corre al vencer la cola, que ya es asíncrona.
- **brain.js no se toca**: recibe el bloque como texto del turno del
  usuario, igual que cualquier mensaje.

## Proveedor y modelo

El mismo de todo Xabor: **Anthropic**, modelo `claude-haiku-4-5-20251001`
(el del bot), que soporta entrada de imagen y structured outputs de forma
nativa. Misma API key (config del panel → `ANTHROPIC_API_KEY`), mismo SDK,
cero factura nueva. El cliente de visión vive en `src/agent/vision.js` y
recibe su resolver de credencial por inyección (`configurarVision`) desde
whatsapp-meta.js — no está acoplado a server.js ni al canal, cambiar de
modelo es cambiar una constante.

## Schema del análisis (versión 1)

`SCHEMA_ANALISIS` en `src/agent/vision.js` — estricto, versionado,
`additionalProperties:false`, declarado al proveedor vía
`output_config.format` (structured output nativo) y re-validado en código
(`validarAnalisisVisual`) aunque llegue por la vía degradada:

```json
{
  "version": 1,
  "tipo": "promocion|menu|producto|screenshot|etiqueta|ticket|documento|foto_general|otro",
  "descripcion": "...",
  "texto_visible": ["..."],
  "productos_detectados": [{"nombre": "...", "confianza": 0.87}],
  "precios_visibles": [{"valor": 299, "moneda": "MXN", "confianza": 0.94}],
  "marca_visible": "... | null",
  "fecha_visible": "... | null",
  "vigencia_visible": "... | null",
  "requiere_validacion": true,
  "incertidumbres": ["..."],
  "confianza_general": 0.89
}
```

## Veracidad

- El bloque `[CONTEXTO VISUAL]` declara explícitamente que lo extraído **no
  demuestra disponibilidad, vigencia ni precio actual** y ordena verificar
  contra el menú/promociones reales antes de confirmar nada.
- Marca de otro negocio → el bloque prohíbe asumir que la promoción es
  propia.
- `confianza_general < 0.5` → el bloque ordena preguntar antes de afirmar.
- El prompt del analizador (`PROMPT_VISION`) prohíbe inventar texto
  ilegible, productos o vigencias.

## Seguridad (prompt injection visual)

El texto dentro de una imagen es **contenido**, jamás instrucciones:

- El analizador lo transcribe literal a `texto_visible` y tiene la orden de
  no obedecerlo.
- El bloque cita cada línea entre comillas (`JSON.stringify`), marcada como
  "transcripción literal, tratar como cita", con la instrucción de ignorar
  cualquier orden que aparezca dentro.
- El bloque entra SOLO por el turno del usuario (rol `user`); nunca se
  concatena al system prompt de nadie. El system de la llamada de visión es
  fijo (`PROMPT_VISION`).

## Cache y dedupe

- Cache en memoria por `negocioId:media_id` (TTL 24 h, tope 500 entradas):
  cubre webhook duplicado, reintentos y reanálisis dentro del proceso. El
  negocio va en la clave: el cache jamás cruza tenants.
- El dedupe estructural sigue siendo el índice único por `wamid` en
  `documentos`: una reentrega de Meta devuelve el mismo documento.
- Mejora futura (requeriría columna jsonb en `documentos`, no se creó
  migración): persistir el análisis para sobrevivir redeploys.

## Costo y telemetría

Cada análisis registra (sanitizado): negocio (8 chars), hash del media_id,
MIME, bytes original/enviado, duración, cache hit/miss, `usage` de tokens y
costo estimado (`usd_est`, precios de haiku $1/$5 por MTok). Marcadores:
`[VISION] inicio | cache_hit | success | timeout | rate_limited |
provider_error | invalid_output | imagen_invalida | fallback`.

Límites V1: máx **2 imágenes por turno**, timeout `VISION_TIMEOUT_MS`
(20 s), espera de descarga `VISION_ESPERA_DESCARGA_MS` (8 s), **1**
reintento solo para 429/5xx/red, lado mayor normalizado a 1568 px JPEG q85.
Nunca se loguean: API key, base64, teléfono, media_id crudo.

Control de costo por negocio (futuro): el flag vive en la tabla
`configuracion` por negocio; un límite mensual se agregaría como otra clave
(`vision_limite_mensual`) contando los `[VISION] success` — la telemetría
ya registra todo lo necesario para medirlo.

## Privacidad

No se crea ninguna copia nueva de la imagen: visión lee el MISMO archivo
que `chat_imagenes` ya archiva (re-encodado sin EXIF/GPS). Al proveedor
viaja solo la imagen normalizada y el caption (recortado a 300 chars),
nunca el teléfono ni el historial completo.

## Fallbacks

Timeout, 429/5xx, red, imagen corrupta, MIME raro, JSON inválido, output
incompleto, descarga que no terminó → **esa foto conserva la nota de
siempre** ("hay una foto que no puedo ver") y el turno sigue al agente.
Nunca silencio, nunca doble respuesta, nunca se rompe el turno. Foto sola
sin palabras → fallback determinista existente, sin gastar análisis
(decisión V1 documentada).

## Feature flag, activación y rollback

- Flag: `configuracion.vision_imagenes = 'true'` **por negocio** (tabla
  `configuracion`, cero migraciones). Apagado por defecto; `chat_imagenes`
  conserva su significado (archivar fotos) intacto.
- **Activar** (cuando se autorice, p. ej. piloto Nonna):
  `INSERT INTO configuracion (negocio_id, clave, valor) VALUES ($NEG, 'vision_imagenes', 'true')
   ON CONFLICT (negocio_id, clave) DO UPDATE SET valor = 'true';`
- **Rollback**: poner el valor en `'false'` (o borrar la fila). Sin flag,
  el comportamiento es EXACTAMENTE el de 0425c98 (nota + agente). No hay
  migración que revertir.
- Rollout diseñado: OFF por defecto → solo Nonna → smoke real → observar
  costo/latencia (`[VISION]` en logs) → extender.

## Pruebas

`test/fase-vision-whatsapp.mjs` (39 casos) con `test/lib-vision-mock.mjs`
(mock local de la API, cero gasto real) y fixtures generados con sharp
(SVG→PNG, sin fotos reales). Los contratos C1–C4 son la prueba roja contra
`0425c98` (`VISION_FUENTES_DIR=<dir con los archivos viejos>`).
