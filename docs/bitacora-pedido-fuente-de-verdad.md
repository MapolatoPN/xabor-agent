# Bitácora — fuente de verdad del pedido

Trabajo en `fix/pedido-fuente-de-verdad`, partiendo de `c859e72` (PR 8, lo que
hoy corre en producción). **No se despliega ni se fusiona a main.**

Esta bitácora existe para poder retomar si se corta la sesión. Se actualiza
conforme avanza, no al final.

## Estado verificado al empezar (2026-09-12)

- `origin/main` = `c859e72` — PR 8 de Codex, fusionado hoy 09:25 y desplegado.
  Confirmado que **todo el trabajo del 11-sep sigue dentro** (`9cea9d7` es
  ancestro). No se revirtió nada de nadie.
- Ramas con trabajo fuera de producción: `integracion/obispado-personal` (49),
  `personal/mvp` (3), `mantenimiento/entorno-local-y-eol` (4). Ninguna es de
  este alcance.
- Codex dejó en producción: `session.aclaracionProducto` (instantánea del
  borrador durante UNA aclaración), `continuarAclaracionProducto`,
  `solicitudPersona.js`, y `variantePorLoPedido` reescrito para usar
  `buscarOpcionPorMencion` en vez de comparación de texto propia.

## Diagnóstico unificado

### Confirmadas por Codex, reproducidas localmente

| # | Falla | Dónde |
|---|---|---|
| A | Un ID contradictorio sustituye al producto nombrado | `validadorOrden.resolverProducto` |
| B | Una mención genérica autoriza una opción específica | respaldo de selecciones |
| C | Responder un dato operativo borra el segundo platillo | `brain.js`: el borrador del modelo es la única fuente |

### Encontradas por mí el 11-sep (ya en producción)

Negativas falsas por ambigüedad de producto; negativas sin platillo resuelto;
ambigüedad de opción nombrando grupos en vez de opciones; borrador ilegible
tumbando el turno; pausa eterna; botón de devolver al bot inservible.

### Causa común

En cada turno, **el borrador que emite el modelo ES el pedido**. Todo lo demás
—identidad, cantidades, selecciones— se deriva de esa emisión. Si el modelo
omite, contradice o resuelve de más, el sistema lo toma por la voluntad del
cliente. `aclaracionProducto` tapa un tramo (la elección de presentación) pero
se limpia en `brain.js:692` y el ciclo vuelve a depender del modelo.

## Decisión de diseño

Un **carrito estructurado** que vive todo el ciclo y sobrevive reinicios. El
modelo propone; el carrito se reconcilia. Omitir no borra. Quitar exige
evidencia del cliente. Los datos operativos no tocan artículos.

## Avance

- [x] Leer los tres artefactos de Codex
- [x] Verificar estado real de git y producción
- [x] Rama propia creada
- [x] Portar las reproducciones como suite obligatoria y verlas fallar
      (`test/fase-pedido-fuente-de-verdad.mjs`, 13 casos, dos negocios)
- [x] Identidad de producto contra ID contradictorio (falla A)
- [x] Evidencia que distinga entre opciones hermanas (falla B)
- [x] Carrito persistente (falla C) — `src/orders/carritoDelPedido.js` +
      enganche en `brain.js`, limpieza en `session.js`, foto en `sesionDurable.js`
- [ ] Conversaciones completas: sustitución, respuestas cortas, apodos y erratas,
      respuestas en prosa, mensajes agrupados, reentregas, dos instancias
- [ ] Regresión de las suites vecinas (confirmación, agrupada, continuidad,
      Compras por WhatsApp)
- [ ] Auditoría de producción en solo lectura
- [ ] PR

## Pruebas de mordida (2026-09-12)

Cada corrección se desactivó por separado y se comprobó que la suite vuelve a
fallar exactamente donde debe. Sin esto, verde no significa nada.

| Mordida | Qué se desactivó | Falla |
|---|---|---|
| A | `if (concuerdan)` → `if (true)` | A1, A2 |
| B | `distingueLaEleccion(...)` → `{distingue:true}` | B1, B2 |
| C | el bloque de reconciliación → `if (false)` | C1, C2, C3, D2 |

## Notas de entorno

La base local no tenía aplicadas las migraciones 076/077/078
(`conversacion_estado`, `whatsapp_entradas`, `whatsapp_conversaciones`), y sin
ellas el arranque que `brain.js` arrastra —importa `server.js`— muere antes de
la primera prueba. La suite ahora aplica esos tres `.sql` al empezar: son
idempotentes y así no depende del estado de la máquina.
