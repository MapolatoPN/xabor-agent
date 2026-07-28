# Migración 008 — Infraestructura de mapeo canal → negocio

Rama: `feature/multitenancy-fase-0`

## Contexto

Primer commit de la fase de aislamiento operativo multiempresa (Fase 5).
Objetivo único de esta migración: crear la tabla que permitirá, en una
fase posterior explícitamente autorizada, resolver a qué negocio
pertenece un pedido entrante de WhatsApp/Rappi/voz **sin** conectar
todavía ningún canal a este esquema. `whatsapp-meta.js`, `rappi.js`,
`voice.js` y `print-agent.js` no se tocaron — siguen funcionando
exactamente igual que antes de este commit.

## Archivos

| Archivo | Propósito |
|---|---|
| `008_integraciones_canal.sql` | Migración up: crea `integraciones_canal` con FKs, índices y trigger `updated_at` |
| `008_integraciones_canal_seed.sql` | Seed idempotente: solo Rappi/Nonna Maye (identificador confirmado en código) |
| `008_check_integraciones_canal.sql` | Validación de solo lectura: PK, FKs, índices, constraints, trigger, seed, ausencia de secretos |
| `008_integraciones_canal_down.sql` | Rollback: elimina únicamente la tabla nueva |

## Diagnóstico previo del backfill (migraciones 005 y 007)

Verificado contra Postgres efímero (nunca contra producción), no asumido
por lectura de SQL:

- **Migración 005** (`usuario_negocios`): backfill correcto y sigue
  siéndolo — cada usuario existente se replica como `admin` de su
  `usuarios.negocio_id` original, `ON CONFLICT DO NOTHING`. No hay
  contradicción: no existe ningún flujo en vivo que cree usuarios sin
  pasar por `crearUsuarioConPassword`, que sí exige `negocioId`.

- **Migración 007** (negocio_id en 15 tablas operativas): la columna
  existe, es `nullable`, tiene FK `RESTRICT` e índice en las 15 tablas
  verificadas (`clientes`, `pedidos`, `pedidos_activos`, `mensajes`,
  `pedidos_programados`, `transcripciones_voz`, `caja_fondos`,
  `repartidores`, `campanas`, `rewards_config`, `rewards_accounts`,
  `rewards_movements`, `eventos`, `perfiles_clientes`, `oportunidades`).
  El backfill hacia Nonna Maye funcionó correctamente para las filas que
  existían **en el momento de correr la migración**.

  **Contradicción confirmada entre migración y código**: el backfill de
  007 es un evento de una sola vez. Ninguna de las funciones que los
  canales en vivo usan hoy (`upsertCliente`, `guardarPedido`,
  `guardarPedidoActivo`, `guardarMensaje`, `guardarTranscripcionVoz`,
  `guardarPedidoProgramado`) acepta ni escribe `negocio_id` en su
  `INSERT`. Se comprobó de forma directa: contra una base recién migrada
  con 007, se llamó a `upsertCliente`, `guardarPedido`,
  `guardarPedidoActivo` y `guardarMensaje` exactamente como lo hace
  `whatsapp-meta.js` hoy — las 4 filas nuevas quedaron con
  `negocio_id = NULL`. Es decir: el comentario de 007 que dice "backfill
  hacia Nonna Maye" es correcto para el pasado, pero **no es una
  invariante** — cualquier pedido/cliente/mensaje nuevo desde que 007 se
  aplicó (en cualquier entorno donde se haya aplicado) queda sin
  `negocio_id`, silenciosamente. No se verificó si 007 fue aplicada
  contra Railway/producción — no se tiene acceso ni autorización para
  comprobarlo — pero el hallazgo estructural es válido independientemente
  de eso: el código nunca puebla `negocio_id` en escritura.

  Este hallazgo es exactamente el que motivó, en el diseño de la fase
  anterior, no filtrar todavía las lecturas de pedidos/clientes/ventas
  por `negocio_id` — sigue vigente y sin resolver; esta migración no lo
  resuelve, solo prepara la infraestructura para poder resolverlo después.

## Diseño de `integraciones_canal`

- `canal` sin `ENUM` ni `CHECK IN (...)`: se usa
  `CHECK (canal ~ '^[a-z][a-z0-9_]*$')` para permitir agregar canales
  futuros (sms, instagram, messenger) sin necesitar otra migración.
- `sucursal_id` nullable a propósito: las tablas `sucursales`/`terminales`
  existen desde la migración 003 pero **no las usa ningún archivo de la
  aplicación** (confirmado por búsqueda en todo `src/`) — hoy cada
  negocio opera como una sola ubicación implícita. La columna queda lista
  para cuando eso cambie, sin bloquear el uso actual.
- `UNIQUE (canal, identificador)`: garantiza que el mismo store_id de
  Rappi, phone_number_id de WhatsApp o número de Twilio nunca pueda
  apuntar a dos negocios a la vez — es la protección central contra
  mezclar pedidos entre negocios.
- `configuracion JSONB`: reservado para metadatos no sensibles (nombre
  visible, cooking_time, etc.). Explícitamente **nunca** para tokens,
  secrets o credenciales — esos siguen en variables de entorno o en la
  tabla `configuracion` existente con sus propias protecciones.
- `updated_at`: reutiliza `set_updated_at()` (creada en 003), mismo
  patrón que ya usa `usuario_negocios` (005).

## Seed

Solo se sembró **Rappi**: `store.internal_id = '1930419809'`, confirmado
en `src/services/rappi-api.js:15` (comentario `// PROD: 1930419809`) y en
`src/channels/rappi.js:92` (orden productiva real ya recibida por esa
tienda). No es un secreto — es un identificador de tienda usado para
enrutar webhooks, equivalente a un número de sucursal.

**WhatsApp y Voz quedan sin sembrar a propósito** — no existe ningún
`phone_number_id` ni número de Twilio real en el repositorio, solo los
nombres de las variables de entorno que los contendrían
(`META_PHONE_NUMBER_ID`/`WHATSAPP_PHONE_ID`, `TWILIO_PHONE_NUMBER`) sin
valor. Inventar un valor aquí sería exactamente el tipo de "fallback
silencioso" que esta fase busca evitar. Pendiente: leer esos
identificadores reales desde la configuración de Meta/Twilio/Railway
(fuera del alcance de esta sesión — requeriría acceso a producción) antes
de poder completar esos dos `INSERT`.

## Fallback en producción — restricción de diseño para la fase siguiente

Esta migración no implementa ninguna resolución de negocio en los
canales (eso es explícitamente la fase siguiente, no autorizada todavía).
Se deja documentado aquí el requisito ya aprobado para cuando se
implemente: un `identificador` no encontrado en `integraciones_canal`
debe, en `NODE_ENV=production`, generar un log claro y no crear cliente,
no crear pedido, no emitir al panel, no imprimir, no acumular rewards, y
responder de forma técnicamente correcta a cada webhook sin mezclar
datos. El fallback a un negocio por defecto (Nonna Maye) solo podría
existir bajo `NODE_ENV=test` o `development`, nunca en producción.

## Rollback

`008_integraciones_canal_down.sql` elimina únicamente la tabla
`integraciones_canal` (`DROP TABLE` arrastra su trigger e índices
automáticamente). No toca `set_updated_at()` — la siguen usando
`negocios`, `sucursales`, `terminales`, `usuarios`, `usuario_sucursales`
y `usuario_negocios`.

## Alcance de esta fase

- No se tocó `src/server.js`, `src/services/database.js`,
  `whatsapp-meta.js`, `rappi.js`, `voice.js`, `print-agent.js` ni
  `panel/index.html`.
- No se ejecutó ninguna migración contra Railway/producción — todo se
  probó contra Postgres efímero local.
- No se agregó ninguna dependencia nueva ni se modificó `package.json`.
- No se guardó ningún secreto, token ni credencial en esta tabla.
