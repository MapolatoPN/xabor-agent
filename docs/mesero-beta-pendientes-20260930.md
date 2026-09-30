# Cierre de pendientes locales de la beta — 30 septiembre 2026

Base: `8713641`, rama `feat/mesero-beta-hibrido-20260930`.
Encargo: implementar los pendientes y revisar antes de desplegar.
**Esta entrega es local. No hubo push, despliegue ni cambios en producción.**

Actualización posterior, autorizada por el dueño: la migración a Node 22 y
Puppeteer 25 ya está implementada y probada localmente, con cero alertas npm
en la imagen nueva. Ver [reporte de migración](mesero-node22-20260930.md).
Los resultados Node 20 y las cuatro alertas descritas abajo se conservan
como evidencia del checkpoint anterior; ya no son el estado local actual.

Commits desde PowerShell: `c0b760a` (continuidad, recuperación y diagnóstico)
y `e6b0ebc` (archivos, dependencias y verificación de Chromium).
Diff de implementación para revisión:

```powershell
git diff 8713641..e6b0ebc
```

Este documento actualiza los pendientes de `mesero-beta-hibrido-20260930.md`
y `mesero-beta-seguimiento-20260930.md`; no reescribe la evidencia histórica.
No declara implementadas todas las funciones posibles de Meta.

## Qué queda implementado

### Preguntar y pedir en el mismo mensaje

La corrección previa permitía ejecutar el cambio, pero la vista canónica del
pedido podía sustituir la respuesta informativa. Ahora se añade información
verificada al final de la composición, después de generar botones/formulario.

- Horarios habituales y aviso de cierre especial, ubicación configurada,
  modalidades de envío y tiempos estimados salen de datos de Xabor.
- No se usa la prosa del modelo para fijar horarios, direcciones, precios o
  autorización comercial. Si falta información, se indica que no está verificada.
- Envío usa las mismas modalidades efectivas del canal; no se anuncia $60 ni
  otra tarifa sin pasar por las reglas de envío.
- La respuesta se conserva también en el cuerpo del Flow. Si no cabe en
  1024 caracteres, no se trunca: se conserva texto y se omite ese Flow.
- Está limitado a la beta y excluye atención humana, fuera de horario,
  eventos y estados terminales/inciertos.

Prueba: el modelo simulado propone dos cafés y luego inventa un total de
$9999 y cierre a las 17:37. Xabor conserva el alta válida y emite el horario
de la fixture, sin esos números inventados. Otro caso conserva la respuesta
dentro del formulario de opciones de chilaquiles pendientes.

**Límite:** cubre preguntas operativas comunes reconocidas por las reglas;
no certifica entender cualquier frase compuesta ni cualquier consulta de menú.
La calidad de conversación con un modelo y cliente reales sigue pendiente.

### Recuperar la primera selección del formulario

«Seguir pedido» ya no exige un carrito comercial con platillos. Puede abrir
un formulario nuevo y recuperar también la selección inicial recibida por el
servidor (`repetible_v1`), además del editor (`carrito_v1`).

- Mismo negocio, teléfono/sesión, ciclo, huella y foto completa.
- Hasta 30 minutos; pregunta disponible, enviada y con acuse de salida.
- Recuperación dentro de la transacción del nuevo turno.
- Si cambian precio, opciones, productos, Flow o pedido, no mezcla el borrador.
- El token viejo sigue inválido; navegar no confirma, cobra ni crea pedido.
- No recupera campos que nunca salieron del teléfono.

### Diagnóstico local del catálogo nativo

`scripts/revisar-mapa-catalogo-nativo.mjs` comprueba una foto local del mapa y
la carta publicada de WhatsApp: productos disponibles, opciones exactas,
precio base más extras y personalizaciones obligatorias aún pendientes.
Comparte la resolución con el receptor, sin duplicar el cálculo de precios.

Uso, con un archivo local preparado para revisión:

```powershell
node scripts/revisar-mapa-catalogo-nativo.mjs C:\ruta\foto-catalogo.json
```

Entrada: `{ "cfg": { "whatsapp_catalogo_meta_id": "...",
"whatsapp_catalogo_meta_mapa": "JSON del mapa" }, "catalogo": [] }`.
`catalogo` debe contener la carta PUBLICADA para WhatsApp, no el menú del POS.
Salida `ok` solo valida esa foto local; siempre devuelve `metaVerificado:false`.
No consulta DB, publica productos, envía mensajes ni cambia banderas.

**No completado:** activo real, asociación/permisos, sincronización y envío
del catálogo, configuración y prueba móvil. El receptor preparado no equivale
a una tienda nativa lista. El catálogo debe seguir apagado hasta completar eso.

### Seguridad y compatibilidad de archivos

Se actualizaron dependencias compatibles con Node 20 y sus transitivas:
`file-type`, `sharp`, `pdfjs-dist`, `adm-zip`, Express/body-parser, qs,
ip-address y js-yaml. Se retiró `fast-xml-parser`, sin consumidores en el repo.

Imágenes/PDF rechazan firmas ajenas antes del detector general. Un archivo
truncado se rechaza sin propagar el error. La firma identifica formato; no
certifica la integridad completa de un PDF. El lector valida su estructura.

El build ahora abre y cierra Chromium después de instalar dependencias:
una descarga incompleta deja de pasar como build correcto.

`npm audit --omit=dev`: de 16 alertas del análisis local previo a **4 altas,
0 moderadas y 0 críticas** en esta ejecución. El build Linux también reportó
4 altas. No se compara como si fuera la misma ejecución con las 18 del build
productivo anterior, ni se equiparan alertas con explotabilidad demostrada.

Las cuatro pendientes pertenecen a la cadena `extract-zip` /
`@puppeteer/browsers` / `puppeteer-core` / `puppeteer`. npm propone
`puppeteer@25.12.0`, cuyo motor exige Node >=22.12.0. **No se migró el runtime**:
requiere una entrega con pruebas generales de Node 22 y decisión del dueño.
No se ejecutó `npm audit fix --force` ni se suprimieron alertas.

Referencias del mantenedor consultadas:
[file-type / ASF](https://github.com/sindresorhus/file-type/security/advisories/GHSA-5v7r-6r5c-r473),
[sharp / libheif](https://github.com/lovell/sharp/security/advisories/GHSA-rgj7-g3m4-5g8c).

## Pruebas finales

Código montado de solo lectura sobre imagen local `xabor-beta-cierre:20260930`,
Node 20/Linux y dependencias nuevas. Las suites SQL/HTTP usaron Postgres 18.4
local, bases `test_botones_` separadas y bloqueo de destinos externos. Las
pruebas puras y de archivos se ejecutaron con `--network none`.

| Prueba | Resultado |
| --- | --- |
| `npm run test:incident` | Verde; gate obligatorio y canónico 19/19. Incluye beta pura 9 grupos. |
| `test/fase-beta-hibrida-db.mjs` | 11/11, incluida respuesta en Flow y recuperación inicial. |
| `test/fase-beta-hibrida-webhook.mjs` | Verde: firma, dos procesos, reinicio, dedup, prioridad de texto y barreras. |
| `test/fase-flows-db.mjs` | 23/23. |
| `test/fase-flows-webhook.mjs --carrito` | Verde: categorías, tacos, mixtos, notas, bajas múltiples, cantidades, deshacer y confirmación separada. |
| `test/fase-outbox-entrega-db.mjs` | 25/25. |
| `npm run mesero:tools` | 66/66. |
| `npm run mesero:replay` | 26/26; cero invariantes críticas rotas. |
| `npm run test:archivos` | 4 grupos: ASF/truncados, JPEG/PNG/WebP, ZIP y generación/lectura real de PDF. |
| Build Docker y arranque de Chromium | Correctos. |
| Sintaxis y `git diff --check` | Sin errores. |

La confirmación de la suite Flow crea un único pedido sintético **LOCAL** de
$420. No se envían mensajes, cobros ni tickets reales. Estos resultados no
sustituyen una prueba con Meta y el teléfono del dueño.

Incidentes del banco, sin ocultarlos:

- El primer build devolvió éxito con un ZIP de Chrome truncado. La prueba de
  PDF lo detectó. Se probó primero con la caché local verificada de la misma
  versión y después con una nueva descarga. El build con comprobación de
  arranque y la prueba de archivos pasaron sin montar aquella caché auxiliar.
- La primera prueba HTTP agotó el arranque de 15 s sin salida mientras había
  build y suites concurrentes. Pasó al repetirla sola, sin ampliar el timeout.
  No hay evidencia suficiente para atribuirlo a un defecto productivo.
- El nuevo caso de consulta dentro del Flow empezó con fixture sin ID de
  configuración y obtuvo correctamente una lista. Se completó la fixture;
  pasó comprobando el cuerpo real del Flow persistido.

## Lo que falta y no debe confundirse con un despliegue

1. Revisar este diff local y el HEAD productivo vigente; repetir el gate sobre
   el candidato integrado. No requiere migración DB ni una definición Flow nueva.
2. Node 22/Puppeteer: aprobado e implementado localmente después de este
   checkpoint; ver `mesero-node22-20260930.md`. Falta integrarlo y verificar
   el build al desplegar, no decidir la migración nuevamente.
3. Probar en el teléfono del dueño: consulta+alta, interrumpir primera selección,
   retomar, duplicar, eliminar varios, total y confirmación. Mantener al resto
   de clientes en manual, sin ampliar las listas de piloto.
4. Resolver por separado el activo y experiencia de catálogo nativo de Meta.
   El aviso WABA 141006 del informe anterior no se verificó ni resolvió aquí;
   no se modificó facturación. La prueba debe comenzar con mensaje del dueño.
5. Repetir pedidos históricos, reutilizar dirección/ubicación, audio,
   fidelización, campañas y nuevos pagos siguen fuera de los objetivos de
   salida de esta beta. No se presentan como implementados en esta entrega.

No se tocaron `whatsapp-meta.js`, `brain.js`, `orderManager.js`, `panel/index.html`,
rutas protegidas de pedidos ni `outbox.js`. No se cambiaron horarios, tarifas,
pausas o datos comerciales. El `node_modules` compartido de Windows no se
reinstaló: la verificación de dependencias nuevas se hizo en Docker aislado.

`STATUS_CODEX: PENDIENTES_BETA_LOCALES_PROBADOS_SIN_DEPLOY_CON_LIMITES_ABIERTOS`
