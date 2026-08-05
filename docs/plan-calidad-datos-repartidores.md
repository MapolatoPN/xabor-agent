# Plan de calidad de datos — Red de Repartidores

**Estado: plan de diseño únicamente. Ninguna consulta de esta
investigación modificó producción — todas fueron `SELECT`. No se
implementó ninguna herramienta de fusión ni se corrigió ningún dato
real.**

## Hallazgos (investigación de solo lectura contra producción, 2026-08-05)

| Hallazgo | Dato real |
|---|---|
| Repartidores totales | 31 |
| Grupos de duplicados detectados (mismo teléfono normalizado a 10 dígitos) | **7 grupos**, los 7 con exactamente 2 filas cada uno, y los 7 dentro del mismo negocio (Nonna Maye) |
| Patrón de cada duplicado | Siempre el mismo par: una fila con teléfono a 13 dígitos (prefijo `521`) y otra con el mismo teléfono a 10 dígitos — nunca variantes de espacios/guiones/mayúsculas en este conjunto real, aunque el normalizador ya las soporta | 
| Repartidores sin `ciudad`/`zona`/`vehiculo` | 31 de 31 (100% — nunca se ha capturado esta metadata, es nueva y opcional desde la migración 035) |
| Pedidos entregados (`entrega a domicilio`) sin repartidor visible en `datos->>'repartidor_id'` | 32 |
| Pedidos entregados con repartidor visible | 14 |
| Pedidos elegibles para la red sin ninguna fila en `notificaciones_repartidor` | 43 de 46 |
| Rango de pedidos de entrega a domicilio | 2026-07-15 → 2026-08-05 |
| Rango de `notificaciones_repartidor` | 2026-08-04 → 2026-08-05 (¡solo ~1 día!) |

## Interpretación (sin asumir causas no verificables)

- Los 43 pedidos sin ninguna notificación son casi todos anteriores a que
  el modo `completo` de notificación por plantilla se activara de forma
  sostenida para Nonna Maye — **consistente** con que
  `notificaciones_repartidor` solo tiene datos desde el día anterior a
  esta investigación. Esto explica los "0/0/0" que vio el propietario:
  no es una falla de cálculo, es la ausencia real de intentos porque el
  pedido es anterior a la ventana de instrumentación.
- Los 32 pedidos entregados sin repartidor visible son **consistentes**
  con pedidos entregados antes de que existiera la asignación vía Red de
  Repartidores, o entregados por una vía distinta (presencial, o
  asignación manual anterior a este módulo). No hay evidencia en los
  datos para afirmar que sea un error — se documenta como observación,
  no como defecto confirmado.
- Los 7 duplicados son, con alta probabilidad, el mismo repartidor dado
  de alta dos veces con y sin código de país — el propio nombre coincide
  o es una variante reconocible en 6 de los 7 casos (`Alejandra Vazquez`/
  `Alejandra Vazquez`, `AnGiE`/`AnGiE`, `Flako444`/`Flako444`, `Gerardo
  Rodríguez`/`Gerardo Rodríguez`, y dos con variantes menores de
  capitalización/apodo: `Alfredo`/`freddy`, `Gerardo`/`Gerardo lara`,
  `Brandon Gutierrez`/`disponible Brandon Gutierrez` — este último con
  un prefijo "disponible" que sugiere un error de captura, posiblemente
  copiar el estado en el campo nombre).

## Propuesta de normalización telefónica (diseño, no implementación)

- Mantener `normalizarTelefonoMX` (`src/utils/telefono.js`) como única
  fuente de verdad para comparar — ya lo es, no se propone cambiarla.
- Para nuevas altas: validar en el formulario de alta de repartidor
  (Superadmin y negocio-admin) que el teléfono capturado se guarde
  siempre en un formato único (proponer: 10 dígitos sin prefijo de país,
  ya que es el formato mayoritario y el que usa Meta al recibir mensajes
  de México) — esto es un cambio de UI/validación, no de esquema.
- No normalizar retroactivamente los teléfonos ya almacenados como parte
  de esta fase — eso es exactamente el tipo de "corrección silenciosa de
  datos reales" que está prohibido sin un plan aprobado aparte.

## Propuesta de fusión segura de duplicados (diseño, no implementación)

1. **Nunca automática**: cualquier fusión requiere confirmación explícita
   de un Superadmin humano, mostrando ambas filas completas lado a lado.
2. **Selección de registro principal**: se sugiere conservar el ID con
   más actividad histórica (más notificaciones/servicios asociados vía
   `notificaciones_repartidor`/`pedidos_activos`), no automáticamente el
   más antiguo ni el más nuevo — mostrar ambos conteos al Superadmin para
   que decida.
3. **Mecanismo de fusión propuesto** (no implementado): en vez de
   eliminar la fila perdedora, marcarla `estado='baja'` (reutilizando el
   mecanismo ya existente de `cambiarEstadoRepartidor`, que nunca borra
   historial) y agregar una columna nueva `fusionado_en_id INTEGER
   REFERENCES repartidores(id)` (migración futura, fuera de esta fase) —
   así el historial de `notificaciones_repartidor`/`pedidos_activos` de
   la fila perdedora sigue siendo consultable y atribuible al repartidor
   real, sin reescribir esas tablas.
4. **Auditoría de la fusión**: registrar quién la ejecutó y cuándo (tabla
   de auditoría nueva o reutilizar un log ya existente si lo hay —
   pendiente de revisar en el momento de implementarlo).
5. **Conservación del historial**: ninguna fusión debe hacer `UPDATE` de
   `notificaciones_repartidor.repartidor_id` ni de
   `pedidos_activos.datos->>'repartidor_id'` — el historial apunta al ID
   original tal cual ocurrió; la fusión solo afecta la vista hacia
   adelante (nuevas notificaciones van al ID principal).
6. **Prevención de nuevos duplicados**: validar en el alta de repartidor
   (Superadmin y negocio-admin) si el teléfono normalizado ya existe en
   ese negocio, y advertir antes de crear una fila nueva — mismo criterio
   de comparación que `detectarDuplicadosRepartidor`, reutilizado como
   validación preventiva en el formulario de alta.

## Explícitamente fuera de esta fase

- No se implementa ninguna herramienta de fusión todavía — este documento
  es la propuesta de diseño para aprobación, no código.
- No se normalizan retroactivamente los teléfonos existentes.
- No se eliminan ni se fusionan los 7 grupos de duplicados reales
  encontrados — quedan documentados para que el propietario decida.
- No se asume que los 32 "entregados sin repartidor visible" sean un
  error — se presentan como observación, con la interpretación más
  simple y verificable disponible.

## Siguiente paso recomendado

Si el propietario aprueba el mecanismo de fusión propuesto (marcar
`estado='baja'` + `fusionado_en_id`), se implementaría como una fase
separada posterior a Fase D, con su propia migración, endpoint de
Superadmin, pruebas de conservación de historial, y aprobación explícita
antes de tocar cualquier repartidor real.
