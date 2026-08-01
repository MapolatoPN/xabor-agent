# Onboarding de WhatsApp para pilotos — guía operativa

Esta guía describe el proceso para conectar el WhatsApp de un negocio piloto a
Xabor y empezar a operar de forma segura. No contiene nombres, teléfonos, IDs
ni secretos reales — todos los ejemplos usan placeholders (`<negocio>`,
`<numero>`, etc.). Quien la ejecute debe sustituirlos por los datos reales del
piloto en el momento, sin copiarlos a ningún documento compartido.

Los pasos 1–4 y 10–14 se hacen desde el panel del negocio y desde
`/superadmin`. Los pasos 5–9 requieren coordinarse con el dueño del negocio,
ya que involucran su teléfono real.

## Antes de empezar

- Confirma que el negocio tiene módulo `whatsapp` contratado
  (`negocio_modulos.estado` en `activo` o `configurado` — ver pestaña
  Módulos en `/superadmin`).
- Ten a la mano: nombre comercial, horario, al menos un producto/servicio
  cargado en el menú, métodos de pago aceptados, y modalidades de entrega o
  recolección. El checklist de activación del bot (paso 10) los vuelve a
  pedir explícitamente — tenerlos listos de antemano agiliza el piloto.

## 1. Crear negocio

Desde `/superadmin` → "Nuevo negocio". Define nombre comercial, slug,
propietario, plan y estado inicial (`pendiente` mientras dure el onboarding).

## 2. Crear administrador

El modal de creación del negocio genera automáticamente el primer
administrador y produce un enlace de invitación de un solo uso. Cópialo de
inmediato — no se vuelve a mostrar — y compártelo por un canal seguro
directamente con el propietario, nunca por WhatsApp del propio número que se
está por migrar.

## 3. Configurar permisos

Con el administrador ya activo, crea las cuentas de staff necesarias desde
"Usuarios" en el panel del negocio, cada una con el rol mínimo que necesite
(`staff` para operación diaria, `admin` solo para quien deba tocar
configuración y facturación).

## 4. Confirmar bot apagado

Antes de tocar Meta, verifica en `/superadmin` → negocio → "Bot de
WhatsApp" que el estado sea **Bot apagado**. Es el valor por defecto
(`bot_whatsapp_activo = false`) para cualquier negocio nuevo — no debe
activarse manualmente en este punto.

## 5. Abrir Embedded Signup

Desde `/superadmin` → negocio → integración de WhatsApp → "Conectar con
Meta". Antes de que se abra el diálogo real de Meta, el panel muestra un
aviso obligatorio: qué implica la migración, que el bot iniciará apagado, y
que el historial local del teléfono podría no transferirse. Debe aceptarse
explícitamente (checkbox + botón) para continuar — la aceptación queda
auditada (negocio, usuario, fecha, versión del aviso), nunca el número ni
credenciales.

Coordina este paso con el dueño del negocio: necesita tener el teléfono a la
mano para el siguiente paso.

## 6. Verificar el número por SMS o llamada

Meta solicita verificar el número durante el flujo de Embedded Signup, por
SMS o por llamada telefónica automatizada, según el tipo de línea. Ver la
sección dedicada a teléfonos fijos más abajo si el número del piloto es una
línea fija sin capacidad de recibir SMS.

## 7. Confirmar credenciales

Al completar el flujo, Xabor guarda las credenciales cifradas
(`integraciones_canal_credenciales`) y marca el estado técnico de la
integración como `activo`. Confírmalo en `/superadmin` → negocio →
integración de WhatsApp → "Estado técnico".

## 8. Probar mensaje entrante

Pide al dueño del negocio (o a alguien de su equipo) que envíe un mensaje de
prueba al número recién conectado, desde un celular distinto. Confirma que
aparece en la pestaña "Chats" del panel del negocio, con fecha/hora y
marcado como mensaje de cliente.

## 9. Probar respuesta manual

Desde el mismo chat, responde manualmente ese mensaje de prueba. Con el bot
todavía apagado, el envío depende únicamente de las credenciales ya
configuradas — si Meta las rechaza, el panel muestra un error claro
("WhatsApp no configurado" u otro mensaje específico), nunca una pantalla en
blanco ni un error genérico.

## 10. Configurar negocio

Completa en el panel del negocio: nombre, horario, menú (productos y
precios), métodos de pago aceptados y modalidades de entrega/recolección.
Estos mismos datos alimentan el checklist de activación del bot (paso 12) —
no hay una segunda captura por separado.

## 11. Probar bot de forma controlada

Si se quiere validar el comportamiento del bot antes de activarlo para
todos los clientes, puede probarse puntualmente pausando/reactivando
conversaciones específicas y observando las respuestas generadas, sin
activar el interruptor global. El interruptor global es la única forma de
que el bot responda de forma no supervisada — no lo actives todavía.

## 12. Activar bot

En `/superadmin` → negocio → "Bot de WhatsApp" se muestra el checklist de
activación: integración conectada, bot actualmente apagado, nombre del
negocio, horarios, al menos un producto/servicio, métodos de pago,
modalidades de entrega y reglas operativas configuradas, más tres
confirmaciones manuales (mensaje inicial revisado, prueba manual
confirmada, aceptación del administrador). El botón "Activar" permanece
deshabilitado mientras falte cualquiera de estos puntos.

Nota: este checklist es asesor a nivel de panel — guía la activación y dejó
constancia de qué falta, pero la API que enciende el bot no lo bloquea de
forma dura, precisamente para no arriesgar dejar sin forma de reactivarse a
un negocio que ya estuviera operando antes de que existiera este checklist.
Para un piloto nuevo, complétalo de todas formas: es la única guía que
tenemos de que el negocio está listo.

## 13. Monitorear las primeras 24 horas

Con el bot activo, revisa periódicamente durante el primer día:

- Que las respuestas del bot sean coherentes con el menú y las reglas
  configuradas.
- Que no haya mensajes de error de envío repetidos en los logs del servidor.
- Que el dueño del negocio pueda pausar una conversación puntual y tomar
  control manual sin fricción (botón "Tomar control" en el chat).
- Que no aparezca ningún mensaje ni conversación de otro negocio en este
  panel (aislamiento por negocio).

## 14. Rollback y criterios de detención

Apagar el bot es siempre una acción segura e inmediata: `/superadmin` →
negocio → "Bot de WhatsApp" → "Apagar" (o el mismo control desde el panel
del propio negocio, si el administrador tiene el módulo). No borra
credenciales, no pierde historial, no requiere ningún checklist.

Criterios sugeridos para apagar el bot y volver a atención 100% manual:

- El bot responde con información incorrecta sobre productos, precios o
  disponibilidad.
- El bot ignora una conversación pausada individualmente o responde cuando
  no debería.
- El dueño del negocio reporta confusión o quejas de sus clientes por las
  respuestas automáticas.
- Cualquier señal de que el envío a Meta está fallando de forma consistente
  (revisar `/superadmin` → integración → "Estado técnico").

Si el problema es más profundo que el comportamiento del bot (p. ej. la
integración misma quedó en estado `error`), usa "Suspender" en el estado
técnico de la integración en vez de solo apagar el bot — esto bloquea el
uso de las credenciales de inmediato sin borrarlas, permitiendo investigar
con calma antes de reactivar.

## Teléfonos fijos verificados por llamada

Algunos negocios piloto usan una línea fija como su número de WhatsApp
Business. Puntos específicos para este caso:

- En el paso 6, Meta ofrece verificación por llamada automatizada en vez de
  SMS (las líneas fijas no reciben SMS). Selecciona explícitamente esa
  opción en el flujo de Embedded Signup.
- La llamada de verificación lee un código en voz; quien esté frente al
  teléfono físico del negocio debe estar disponible en el momento exacto en
  que se ejecuta el paso 6 — coordínalo antes de iniciar el flujo, no
  durante.
- Si la línea tiene un conmutador o IVR propio del negocio, confirma de
  antemano que la llamada de Meta pueda llegar a un teléfono físico y no
  quede atrapada en un menú automatizado.
- Después de verificar, el número sigue siendo una línea fija normal para
  llamadas de voz — la migración a Xabor solo afecta los mensajes de
  WhatsApp, nunca la telefonía del negocio.
- Si la verificación por llamada falla repetidamente, no reintentes más de
  2-3 veces seguidas; espera y coordina un horario con menos ruido en la
  línea antes de reintentar.
