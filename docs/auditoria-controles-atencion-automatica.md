# Auditoría de controles de atención automática

## Hallazgos

| Control | Existe | Ubicación | Quién puede usarlo | Problema auditado | Corrección |
|---|---|---|---|---|---|
| Atención automática del negocio | Sí | `negocios.bot_whatsapp_activo`; migración 019; funciones `obtenerBotWhatsappActivoNegocio` y `actualizarBotWhatsappActivoNegocio` | Administrador propio y superadmin para escritura; staff solo lectura | En Configuración se llamaba “Bot de WhatsApp”, en chats “bot global”, y el banner se ocultaba a operadores | Se presenta como “Atención automática del negocio”, con estados Activa/Pausada; `GET /api/bot-whatsapp` expone el estado operativo a admin y staff sin dar permiso de escritura |
| Atención automática por conversación | Sí | `clientes.bot_pausado`; `getBotPausado`/`setBotPausado` | Admin y staff con módulo WhatsApp | El botón usaba textos ambiguos, no mostraba estado, asumía éxito, podía crear una conversación inexistente y devolvía 200 al intentar operar una ajena | Botones “Tomar conversación”/“Devolver al bot”, estado inline, errores inline, 403 para recurso ajeno y 404 para inexistente, actualización sin recarga y auditoría |
| Gate de respuestas automáticas | Sí | `src/channels/whatsapp-meta.js` | Automático | Debía preservarse el orden y confirmar que los mensajes se guardan antes del gate | Se conserva: guardar/broadcast/upsert/marcar leído; después negocio activo; después conversación no pausada; solo entonces se encola IA |
| Soporte superadmin del negocio | Sí | `/api/superadmin/negocios/:negocioId/bot-whatsapp` | Superadmin real | Sin cambio funcional requerido | Se conserva, aislado del panel del negocio |

## Endpoints y permisos auditados

- `GET /api/bot-whatsapp`: admin y staff del negocio; solo lectura.
- `GET|PATCH /api/admin/bot-whatsapp`: administrador propio; el `negocioId` procede de la sesión. Staff recibe 403.
- `GET|PATCH /api/superadmin/negocios/:negocioId/bot-whatsapp`: superadmin; negocio inexistente recibe 404.
- `GET /api/conversacion/:telefono/estado-bot`: admin/staff del negocio; devuelve pausa individual y estado maestro.
- `POST /api/conversacion/:telefono/pausar`: admin/staff propio; toma la conversación.
- `POST /api/conversacion/:telefono/reactivar`: admin/staff propio; devuelve la conversación al bot.
- En los controles por conversación: sin sesión 401, conversación de otro negocio 403 y conversación inexistente 404.

## Condiciones de interfaz auditadas

El botón por conversación ya estaba en `panel/index.html` y no tenía una condición de rol directa: aparecía al abrir un chat. El problema operativo era que los textos eran “Tomar control” y “Reactivar bot”, no había etiqueta de estado, el estado general no se consultaba para operadores y el frontend actualizaba optimistamente aun si el backend rechazaba la petición. El control maestro estaba dentro de la vista Config, que es `admin-only`, y el banner de chats además exigía `ROL === 'admin'`; por eso el operador nunca veía el estado general.

## Roles

- **Administrador:** puede tomar/devolver conversaciones y activar/pausar la atención automática del negocio.
- **Operador (`staff`):** puede tomar/devolver conversaciones y leer el estado general, pero no modificarlo.
- **Superadmin:** conserva el interruptor maestro de soporte. No se agregó suplantación de una sesión de negocio para controles individuales.
- **Staff sin módulo WhatsApp o membresía activa:** queda rechazado por los middlewares existentes (`requireModulo`/sesión), con control no disponible en el panel.

## Persistencia y auditoría

No se cambió el esquema. La pausa maestra continúa en PostgreSQL (`negocios.bot_whatsapp_activo`) y la individual en PostgreSQL (`clientes.bot_pausado`), por lo que sobreviven recargas y reinicios. Los cambios individuales ahora registran actor, fecha (por infraestructura), negocio, acción, teléfono y estados anterior/nuevo en `auditoria_plataforma`. Los cambios maestros ya utilizaban esa infraestructura.
