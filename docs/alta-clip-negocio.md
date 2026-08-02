# Alta de Clip para un negocio — guía operativa

Esta guía describe cómo configurar Clip (o transferencia manual) como
proveedor de pago para un negocio ya existente en Xabor. No contiene
credenciales reales — todos los ejemplos usan placeholders. Ver también
[`docs/pagos-multiempresa.md`](./pagos-multiempresa.md) para el diseño
completo de la arquitectura.

Quien ejecute estos pasos necesita una sesión de **Superadmin** (no basta
con ser admin del negocio — configurar credenciales de proveedor es
exclusivo de Superadmin; el admin del negocio solo puede *ver* el estado y
administrar métodos de pago que no requieren credenciales, como
transferencia).

## Antes de empezar

- Confirma que el negocio ya existe en `/superadmin` → Negocios.
- Ten a la mano las credenciales reales de Clip del negocio (`apiKey` +
  `apiSecret`, obtenidas del panel de Clip del propio comercio — nunca
  reutilices las de otro negocio).
- Si el negocio no tiene Clip pero sí acepta transferencia bancaria, salta
  directo a la sección "Alta de transferencia manual" más abajo.

## 1. Abrir la ficha del negocio

`/superadmin` → Negocios → buscar por nombre o slug → clic en la fila.
Baja hasta la sección **"Integraciones de Pagos"**.

## 2. Agregar Clip

En la tarjeta "Clip", clic en **"Agregar proveedor"** (o "Reemplazar
credenciales" si ya existía una configuración previa). Se abre un
formulario con dos campos: `apiKey` y `apiSecret`.

- Pégalos tal cual los dio Clip — nunca se muestran de vuelta después de
  guardar (ni en esta pantalla ni en ninguna API).
- Marca "Ambiente producción" **solo** cuando el negocio ya vaya a cobrar
  de verdad. Mientras se hacen pruebas internas, déjalo en sandbox.
- Clic en **"Guardar"**.

La integración queda en estado `activo` con `principal = false` — todavía
no es la que el agente usará para generar enlaces.

## 3. Probar la conexión

Clic en **"Probar conexión"**. Esto **nunca genera un cargo real** — Clip
no expone un endpoint de "ping" público, así que la prueba valida
únicamente que `apiKey`/`apiSecret` tengan la forma esperada (no están
vacíos). Un resultado exitoso aquí no garantiza que las credenciales sean
válidas ante Clip — eso solo se confirma con el primer enlace real que un
cliente efectivamente pague.

## 4. Marcar como principal

Clic en **"Marcar como principal"**. Esto:

- Deja a Clip como el único proveedor de "enlace de pago" para ese
  negocio (si había otro proveedor principal antes, se desmarca
  automáticamente).
- **Habilita automáticamente** el método de pago `enlace_pago` en
  "Config → Métodos de pago" del panel del negocio — no hace falta ningún
  paso adicional ahí. Antes de este paso, el agente de WhatsApp/voz nunca
  ofrece "enlace de pago" a los clientes de este negocio (por diseño,
  reproduce y corrige el incidente del 2 de agosto de 2026 con Alora).

## 5. Confirmar en el panel del negocio (opcional, recomendado)

Como admin del negocio (no Superadmin): Config → "💳 Métodos de pago"
debe mostrar "Enlace de pago" como disponible. El admin del negocio no
puede editar este método directamente (por diseño — depende de que
Superadmin tenga un proveedor real configurado), pero sí puede confirmar
visualmente que ya está activo.

## Suspender o reemplazar Clip más adelante

- **Suspender**: pausa la integración sin borrar credenciales
  (`Suspender` en la ficha del negocio). Desmarca `principal`
  automáticamente — el agente deja de ofrecer "enlace de pago" de
  inmediato, sin ningún paso manual adicional.
- **Reactivar**: vuelve a estado `activo`, pero **no** restaura
  `principal` automáticamente — hay que volver a marcarlo como principal
  si se quiere que el agente lo use otra vez (paso 4).
- **Reemplazar credenciales**: mismo botón "Agregar proveedor" / "Reemplazar
  credenciales" del paso 2 — sobreescribe la credencial cifrada existente.
- **Eliminar integración**: borra el material cifrado por completo
  (irreversible) y desmarca `principal` si lo era. Usar solo si el negocio
  deja de usar Clip definitivamente.

## Alta de transferencia manual (sin Clip ni ninguna API)

Para un negocio que solo acepta transferencia bancaria (sin proveedor
online):

1. Como **admin del negocio** (no hace falta Superadmin): Config → "💳
   Métodos de pago" → activar el checkbox de "Transferencia bancaria".
2. Llenar titular, banco y CLABE/cuenta en el formulario que aparece
   debajo, y clic en "Guardar datos de transferencia".
3. Listo — el agente puede ofrecer transferencia a partir de este momento.
   No requiere ninguna configuración de Superadmin ni credenciales
   cifradas, porque no hay ninguna API involucrada.

Si en cambio se quiere que `manual_transfer` participe como "proveedor
principal" (para que quede un registro formal en `pagos` con estado
`requiere_revision` cuando el bot ofrece "enlace de pago" y el negocio no
tiene Clip), se configura igual que Clip desde Superadmin (pasos 1-2-4 de
esta guía, eligiendo la tarjeta "Transferencia manual" en vez de "Clip") —
esto es un caso más avanzado, normalmente no es necesario si el negocio ya
tiene el método `transferencia` habilitado en el paso anterior.

## Conciliar un pago por transferencia

Cuando un cliente dice que ya transfirió, el admin del negocio confirma
manualmente desde el pedido correspondiente en el panel (botón de
conciliación sobre el pago en estado "pendiente de revisión"). Esta acción
marca el pago como `pagado` — Xabor no tiene forma de verificar
automáticamente un depósito bancario, así que esta confirmación es
responsabilidad exclusiva del negocio. Si el cliente nunca transfirió, se
usa el botón de rechazo en su lugar (queda `cancelado`, nunca se
reintenta solo).
