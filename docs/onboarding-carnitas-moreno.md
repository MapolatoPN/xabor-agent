# Paquete de onboarding — Carnitas Moreno

Listo para ejecutarse **cuando el propietario confirme que Xiomar
respondió**. Nada de este documento se ejecuta sin esa autorización.
Estado al preparar (2026-08-06): invitación vigente hasta 21:27 UTC, sin
aceptar; sin menú, sin repartidores, sin red configurada.

---

## Etapa 1 — Cuenta
1. Verificar en Central de Operaciones → ficha de Carnitas el estado de la
   invitación (vigente / expirada / aceptada).
2. **Solo con autorización**: si expiró, "Reenviar invitación" desde la
   ficha (revoca la anterior y emite una nueva de 24 h).
3. Xiomar abre el enlace → crea su contraseña → primer inicio de sesión en
   `https://xabor.mx/login-negocio.html`.
4. Confirmación: la ficha muestra "con acceso" y el onboarding avanza solo
   a "Configuración en proceso".

## Etapa 2 — Información del negocio
Capturar en el panel (Configuración):
| Dato | Valor |
|---|---|
| Nombre comercial | Carnitas Moreno (confirmar) |
| Sucursal / dirección | __________________ |
| Teléfono | 8781192740 (confirmar) |
| Horarios de operación | __________________ |
| Responsable de operación | __________________ |
| Métodos de pago | efectivo/terminal ya habilitados — ¿transferencia? ¿enlace de pago (requiere proveedor)? |
| Políticas de entrega | zonas, mínimo de compra, tiempos __________________ |

## Etapa 3 — Menú
Por cada categoría (tabla para llenar con el cliente — no inventar):
| Categoría | Producto | Precio | Modificadores/complementos | Disponible | Tiempo prep. | Foto |
|---|---|---|---|---|---|---|
| | | | | | | |
Sugerencia de arranque para carnitas: por kilo/½/¼, tacos, consomé,
bebidas — validar con Xiomar, precios reales suyos.

## Etapa 4 — WhatsApp (no conectar sin autorización)
1. Número que se conectará al bot: __________ (¿el 8781192740 u otro?).
2. Verificar estado del número en Meta (¿ya usa WhatsApp Business App? — la
   migración a Cloud API desconecta la app: avisar antes, flujo estándar de
   Embedded Signup ya documentado en `docs/whatsapp-onboarding-piloto.md`).
3. Embedded Signup desde Superadmin → completar activación.
4. Configurar: horarios de atención del bot, respuestas frecuentes, cuándo
   interviene un humano, mensaje de bienvenida.
5. Prueba interna de conversación antes de anunciar el número.

## Etapa 5 — Repartidores y red
Alta de repartidores (usar la plantilla anti-duplicados de abajo):
| Nombre | Teléfono (521XXXXXXXXXX) | Vehículo | Ciudad | Zona | Estado |
|---|---|---|---|---|---|
| | | | | | |

Configuración de red (PUT /api/config/red-repartidores — vía sesión de
soporte o cuando exista pantalla):
- `red_activa`: true (al final de la etapa, no antes)
- `zonas`: colonias reales de Piedras Negras que SÍ atienden: __________
- `horario_inicio`/`horario_fin`: __________
- `costo_base`: $______ · `costo_por_km`: (dejar 0 — sin geocoding)
- `quien_absorbe`: negocio / cliente / compartido → __________
- `contacto`: teléfono del encargado para repartidores: __________
- `instrucciones_recogida`: __________
- `tiempo_preparacion_min`: ______
- `solicitud_automatica`: **false durante el piloto** (solicitud manual
  controlada), true al pasar a operación
- Notificaciones: `repartidor_notif_modo='piloto'` +
  `repartidor_notif_piloto_telefonos` con 1–2 repartidores de prueba +
  plantilla v2 activa.
- **No configurar**: radio_km / red_xabor / externas / reoferta automática
  (declarativos — el motor no los ejecuta todavía).

## Etapa 6 — Piloto (requiere autorización expresa para ejecutar)
1. Crear UN pedido controlado de domicilio (colonia dentro de zonas).
2. `POST /api/pedidos/:folio/solicitar-repartidor` (modo manual).
3. Verificar UNA oferta por repartidor de la whitelist (sin duplicados).
4. Un repartidor acepta por su enlace → verificar que el segundo recibe
   "ya fue tomado".
5. Marcar recogido → entregado (conversación del repartidor).
6. Verificar métricas D.1 (servicio ofrecido/aceptado/entregado, tiempos) y
   auditoría; verificar en Central de Reparto el ciclo completo.
7. **Criterio para pasar a automático**: una entrega de prueba completada,
   sin duplicidad, con métricas y auditoría correctas → entonces
   `solicitud_automatica=true` y, cuando haya confianza, modo `completo`.

---

## Formulario de levantamiento (enviar a Xiomar por WhatsApp — NO enviado)
> ¡Hola Xiomar! Para dejar Carnitas Moreno listo en Xabor, ¿me ayudas con
> estas respuestas? Puedes contestar aquí mismo, una por una:
1. ¿Nombre exacto del negocio como quieres que aparezca?
2. ¿Quién será la persona responsable del sistema día a día?
3. ¿Qué días y horarios abren?
4. ¿Dirección del local?
5. ¿Manejan pedidos para recoger, entrega a domicilio, o ambos?
6. ¿A qué colonias entregan?
7. ¿Cuánto cobran por el envío (o es gratis desde cierta cantidad)?
8. ¿Qué formas de pago aceptan? (efectivo, tarjeta, transferencia)
9. ¿Me pasas tu menú con precios? (foto o lista está perfecto)
10. ¿Qué número de WhatsApp quieren usar para recibir pedidos?
11. ¿Ese número ya usa WhatsApp Business (la app verde)?
12. ¿Cuántos repartidores tienen y me pasas sus nombres y teléfonos?
13. ¿Tienen impresora de tickets? ¿Qué marca/modelo?
14. ¿Hay promociones o reglas especiales que el asistente deba saber?
15. ¿Qué fecha te gustaría arrancar?

## Guion de llamada/reunión (15–20 min, comercial)
1. **Presentación** (1 min): quiénes somos, qué hace Xabor por un negocio
   de comida: recibe pedidos por WhatsApp solo, comanda a cocina, y
   coordina a tus repartidores.
2. **Su situación hoy** (3 min): ¿cómo reciben pedidos ahora? ¿quién
   contesta el WhatsApp? ¿qué se les complica más?
3. **Volumen** (1 min): ¿cuántos pedidos al día, y en hora pico?
4. **Menú** (2 min): qué venden, qué se pide más, si cambia el menú.
5. **WhatsApp** (2 min): qué número usan, aviso honesto de que al
   conectarlo la app verde deja de usarse en ese número y todo pasa por el
   panel (con humano cuando quieran intervenir).
6. **Entregas** (2 min): colonias, costos de envío, tiempos.
7. **Repartidores** (2 min): cuántos, cómo les avisan hoy; explicar que
   Xabor les manda la oferta al celular y el primero que acepta se lo lleva.
8. **Impresión** (1 min): si tienen impresora de tickets, la comanda sale
   sola en cocina.
9. **Demostración** (3 min): mostrar el panel con un negocio demo (nunca
   datos de otros clientes).
10. **Próximos pasos** (2 min): hoy — activar tu cuenta con el enlace;
    esta semana — menú + WhatsApp + repartidores; luego — un pedido de
    prueba juntos y arrancamos.
11. **Responsabilidades**: Xabor configura, acompaña y da soporte; el
    negocio comparte su información, atiende el panel y avisa cambios.
12. Cierre: acordar fecha objetivo y canal de comunicación.

## Plantilla de alta de repartidores (anti-duplicados)
Formato de captura (una fila por repartidor):
```
nombre_completo:   [Nombre Apellido — capitalización normal, sin apodos]
telefono:          [10 dígitos MX; se normaliza a 521XXXXXXXXXX; sin espacios ni guiones]
vehiculo:          [moto | bici | auto | a pie]
ciudad:            [Piedras Negras]
zona:              [zona/colonia base]
estado_inicial:    [disponible]
```
**Regla de revisión ANTES de crear el registro** (obligatoria):
1. Normalizar el teléfono (quitar espacios/guiones, anteponer 521 si son
   10 dígitos) y buscarlo en el roster del negocio Y en el roster global
   (Superadmin → Red de Repartidores → búsqueda; el sistema ya agrupa
   duplicados de distinto prefijo).
2. Buscar coincidencias aproximadas de nombre en el mismo negocio.
3. Si el teléfono ya existe en OTRO negocio: es válido (un repartidor puede
   servir a varios), pero se registra COMO NUEVA fila de este negocio —
   **nunca fusionar automáticamente**.
4. Si ya existe en ESTE negocio: no crear otro; corregir/reactivar el
   existente.
