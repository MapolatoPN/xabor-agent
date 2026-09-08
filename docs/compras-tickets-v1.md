# Compras V1 — tickets y comprobación de fondos

Rama: `feature/compras-tickets`

## Problema que resuelve

El responsable de compras recibe dinero para abastecer el negocio, compra en distintos proveedores y hoy captura los tickets manualmente en Excel. Compras V1 separa dos hechos que no deben contarse dos veces:

1. **Fondo entregado**: dinero transferido al responsable de compras.
2. **Compra comprobada**: gasto real soportado por un ticket/registro revisado.

Una transferencia de fondo **no es un gasto** por sí sola. El gasto entra al resumen cuando una compra pasa de `borrador` a `confirmada`.

## Flujo por fotografía

1. Usuario autenticado abre `/compras.html`.
2. Toma/sube foto JPG/PNG/WEBP.
3. Backend valida bytes reales, re-encoda para eliminar EXIF/GPS y la guarda privada.
4. La imagen se envía a Anthropic como **DATA no confiable** con structured output estricto.
5. IA propone proveedor, fecha, cifras, renglones y categorías.
6. Backend crea un **borrador**, nunca una compra confirmada.
7. Persona revisa/corrige.
8. `Confirmar compra` exige proveedor, fecha y total > 0.
9. Solo las confirmadas alimentan el resumen semanal.

La IA no determina `estado_factura`. Ese dato siempre es humano.

## Resumen semanal

- `transferido`: SUM fondos del periodo.
- `comprobado`: SUM compras confirmadas del periodo.
- `saldo_por_comprobar`: max(transferido - comprobado, 0).
- `excedente_compras`: max(comprobado - transferido, 0).
- monto/conteo sin factura.
- monto/conteo comprado a crédito.

`tipo_pago=credito` no cambia el importe de la compra; solamente la clasifica. Los pagos posteriores al proveedor quedan fuera de V1 para no duplicar el gasto.

## Multi-tenant / seguridad

- El navegador **nunca envía `negocio_id` como autoridad**.
- Las rutas usan `requireAuthSeguro` de `server.js`; `req.negocioId` viene de sesión/membresía.
- Todas las consultas de compra/fondo filtran por ese `negocioId`.
- El archivo del ticket es privado. El endpoint de descarga vuelve a validar tenant antes de leer bytes.
- Nombres originales no forman la ruta de storage; se guardan solo como metadata saneada.
- El checksum SHA-256 se calcula sobre la imagen normalizada. Índice único `(negocio_id, ticket_checksum)` evita duplicar el mismo ticket dentro del negocio.
- La imagen se re-encoda antes de persistir para remover metadatos EXIF/GPS.
- La IA recibe el ticket como contenido no confiable; texto impreso en la imagen nunca se trata como instrucciones.

## Integración aislada

`server.js` no se modifica. Para no interferir con el trabajo paralelo del bot, el registrador existente de Tienda Online quedó copiado byte-a-byte como `tiendaRutasCore.js`; `tiendaRutas.js` es ahora un wrapper pequeño que monta Tienda + Compras. Antes de merge, si `main` movió `tiendaRutas.js`, hay que rebasar/recrear este punto de composición conscientemente, no copiarlo a ciegas.

## Migración

La rama agrega `069_compras_operativas.sql`. **Antes de merge hay que volver a verificar el último número de migración de `main`**: otro desarrollo paralelo puede ocupar 069. Si ocurre, renumerar esta migración antes de integrar.

No reutilizar `compras_reales`: esa tabla pertenece a compras/pedidos de clientes y promociones de primera compra.

## Fuera de V1

- Inventario automático a partir de ticket.
- Contabilidad fiscal / deducibilidad.
- Conciliación automática ticket ↔ CFDI/XML.
- Libro de pagos posteriores a proveedores a crédito.
- Exportación contable.
- Edición de compras confirmadas salvo futuras acciones explícitas de factura/pago.

## Gate antes de merge/deploy

1. Reconciliar la rama contra el `main` vigente y renumerar migración si hace falta.
2. `node --check` en archivos JS nuevos/modificados.
3. Ejecutar `node test/fase-compras-tickets.mjs`.
4. Aplicar migración en DB desechable.
5. Smoke con dos negocios: un tenant jamás puede leer compra/ticket del otro.
6. Smoke móvil con foto real: analizar → corregir → confirmar.
7. Volver a subir el mismo ticket: debe responder 409 `TICKET_DUPLICADO`.
8. Confirmar que un borrador no mueve `comprobado` y una compra confirmada sí.
9. Confirmar que una transferencia aumenta `transferido`, no `comprobado`.
10. Sin cambios en bot/WhatsApp, Facturación, promociones, Edge/impresión.

No desplegar esta rama mientras el gate no esté completo.
