# Fixtures de Rappi

Aquí van los JSON de webhooks **reales** (anonimizados) de Rappi. Las suites
`fase-rappi-mapeo.mjs` y `fase-rappi-pos-obispado.mjs` cargan automáticamente
todo archivo `*.real.json` de esta carpeta y comprueban que:

- `normalizarSobreRappi()` lo reconoce como orden;
- cada item se resuelve contra el catálogo (o queda `sin_resolver` de forma
  explícita, nunca perdido);
- el flujo completo del webhook lo convierte en un pedido de Xabor.

## Cómo capturar la orden real de Mapolato Obispado

1. Con el store de Obispado ya vinculado (`PUT
   /api/superadmin/negocios/:id/integraciones/rappi`), el webhook guarda el
   sobre completo en `pedidos_externos.payload`:

   ```sql
   SELECT payload FROM pedidos_externos
    WHERE canal = 'rappi' AND negocio_id = '5de544d8-9a0a-4972-9c92-fd48ff22de66'
    ORDER BY recibido_at DESC LIMIT 1;
   ```

2. Guardarlo como `mapolato-obispado-<order_id>.real.json` **anonimizando**:
   - `customer.first_name`, `customer.last_name` → nombres ficticios;
   - `customer.phone_number` → `"0000000000"`;
   - `order_detail.delivery_information.*` → dirección ficticia;
   - conservar TAL CUAL `order_detail.items` (sku, name, quantity, price,
     comments, subitems), `totals`, `delivery_method`, `payment_method` y
     `store.internal_id` — son lo que las pruebas necesitan.

3. Anotar en `fixtures.json` (opcional) el `negocioId` y los `producto_id`
   esperados por SKU para que la suite compruebe el mapeo exacto.

## Lo que hay hoy

- `ejemplo-doc-rappi.json`: el ejemplo de la documentación pública de Rappi
  (dev-portal, sección Orders). **No es una orden real**: sirve solo para fijar
  la forma del contrato (`quantity`, `comments`, `subitems`, `store.internal_id`).
  Por eso NO lleva sufijo `.real.json` y las pruebas de mapeo lo usan únicamente
  para la forma, no como prueba definitiva.
