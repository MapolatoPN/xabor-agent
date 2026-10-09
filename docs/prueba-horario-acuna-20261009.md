# Prueba temporal del formulario de Acuña fuera de horario

El dueño solicitó habilitar su prueba después de comprobar que su «Hola» recibía el aviso de cierre y los saludos repetidos quedaban en silencio. La excepción de horario permite que ese chat reciba el menú y abra el formulario durante dos horas. El horario semanal de Acuña y la disponibilidad de la tienda no cambian.

La bandera `whatsapp_prueba_horario_v1` contiene el negocio, teléfono, inicio y vencimiento. El adaptador productivo la evalúa por turno. Exige canal WhatsApp, modo formulario completo con alcance de prueba, `bot_whatsapp_solo_prueba=true`, teléfono coincidente con la excepción y presente en el canario. El intervalo debe ser válido y no superar dos horas; al vencer deja de aplicar sin depender de un job. No afecta pausas manuales ni la barrera que excluye otros teléfonos.

No se modifica el estado persistido de la conversación para salir del aviso de cierre. La prueba contra PostgreSQL recorre aviso de cierre, activación, otro saludo con las tres opciones, selección de Ordenar ahora y recepción del Flow. También comprueba que una excepción vencida vuelve a responder cerrado, sin llamar al modelo ni registrar un pedido.

Validación con Node 22.23.3 y PostgreSQL local aislado (`test_botones_horario_20261009`), transporte simulado y red externa bloqueada:

- Excepción de horario: 24 verificaciones de identidad, sucursal, canal, modos y vencimiento.
- Recepción pura: 189 casos pasados.
- Recepción contra PostgreSQL: 44 casos pasados, incluido el recorrido nuevo.
- `check-inicio-mapo.mjs` y los 12 grupos de `check-modo-ia.mjs`: correctos.
- Gate de producción en solo lectura: 12 comprobaciones por negocio, cero fallos en Acuña y Obispado.

Base verificada: `67546ad770c9c489c708d5c137869e33135bc17d`, despliegue activo de Railway al preparar este cambio. Se conserva la funcionalidad del banner publicada en esa base. Solo el adaptador del Mesero incorpora la excepción; no se modifican el webhook, brain, registro de pedidos ni rutas protegidas del servidor.

La operación `scripts/activar-prueba-horario-acuna-20261009.mjs` se inspecciona primero en solo lectura y, después del despliegue, guarda el respaldo y la auditoría del dueño en una transacción que escribe únicamente la bandera de prueba y su respaldo. No envía mensajes. La prueba visual del envío y la apertura en WhatsApp real corresponde al propietario.
