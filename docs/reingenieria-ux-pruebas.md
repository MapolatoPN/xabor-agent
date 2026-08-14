# Reingeniería UX — Evidencia de pruebas (revisión 2, 2026-08-14)

Reproducible en cualquier máquina con la DB de pruebas Docker levantada
(`docker start pg-restv2`, Postgres en `localhost:55453/edged1`).

## Comando exacto

```sh
cd C:/xabor-print
export DATABASE_URL='postgresql://postgres:testpass@localhost:55453/edged1'
export PANEL_SECRET=test-panel-secret-fixed SESSION_SECRET=test-session-secret-fixed
export ADMIN_PASSWORD=test-admin-pass PANEL_PASSWORD=test-panel-pass
export INTEGRATIONS_ENCRYPTION_KEY='z+QXvnnTVTsL3HCrY/siK6VHJW4JmpH9BPcTl8oYs8U='   # llave del entorno LOCAL de pruebas
export META_EMBEDDED_SIGNUP_MOCK=true
for s in fase-reingenieria-ux fase-controles-atencion-frontend \
  fase-impresion-autoservicio fase-impresion-self-service \
  fase-whatsapp-menu-automatico fase-menu-multiimagen \
  fase-asistente-comercial-4-panel fase-chat-imagenes \
  fase-comanda-edge-exclusiva fase-cotizaciones-iva fase-documentos-pdf \
  fase-ticket-final-contrato fase-whatsapp-coexistence \
  fase-panel-html-render fase-pos-modificadores-restaurante-ui \
  fase-pos-envios fase-seguridad-transaccional \
  fase-p0-aislamiento-pedidos fase-folio-concurrencia \
  fase-c-bot-global fase-checklist-activacion-bot \
  fase-pagos-multiempresa fase-restaurante-activacion-ui \
  fase-c-embedded-signup; do node "test/$s.mjs" || exit 1; done
```

## Resultados (ejecución del 2026-08-14 sobre esta rama)

| Suite | Tests pasados | Fallidas | Exit code |
|---|---|---|---|
| fase-reingenieria-ux | 19 | 0 | 0 |
| fase-controles-atencion-frontend | 10 | 0 | 0 |
| fase-impresion-autoservicio | 44 | 0 | 0 |
| fase-impresion-self-service | 56 | 0 | 0 |
| fase-whatsapp-menu-automatico | 55 | 0 | 0 |
| fase-menu-multiimagen | 16 | 0 | 0 |
| fase-asistente-comercial-4-panel | 7 | 0 | 0 |
| fase-chat-imagenes | 38 | 0 | 0 |
| fase-comanda-edge-exclusiva | 23 | 0 | 0 |
| fase-cotizaciones-iva | 13 | 0 | 0 |
| fase-documentos-pdf | 13 | 0 | 0 |
| fase-ticket-final-contrato | 10 | 0 | 0 |
| fase-whatsapp-coexistence | 24 | 0 | 0 |
| fase-panel-html-render | 21 | 0 | 0 |
| fase-pos-modificadores-restaurante-ui | 28 | 0 | 0 |
| fase-pos-envios | 18 | 0 | 0 |
| fase-seguridad-transaccional | 18 | 0 | 0 |
| fase-p0-aislamiento-pedidos | 29 | 0 | 0 |
| fase-folio-concurrencia | 23 | 0 | 0 |
| fase-c-bot-global | 24 | 0 | 0 |
| fase-checklist-activacion-bot | 18 | 0 | 0 |
| fase-pagos-multiempresa | 48 | 0 | 0 |
| fase-restaurante-activacion-ui | 12 | 0 | 0 |
| fase-c-embedded-signup | 31 | 0 | 0 |
| **TOTAL (24 suites)** | **598** | **0** | **0** |

## Contratos nuevos de la revisión (test/fase-reingenieria-ux.mjs, 19 casos)

Selector de modalidad (4 rutas + gating por módulo), capturas sin nav propia,
mod-header con regreso y chips en ambas capturas, envTipo sincroniza chips,
Pagos sin duplicación (único metodos-pago-form en su sección, notas de reglas
en el slot de Pagos, Operación sin campos de pago), gating de bnav-corte
(data-modulo="caja"), navegación de staff (admin-only intacto, Inicio/Pedidos
operables), pos-empty eliminado como id, y wa-progreso fijado como par de
ramas excluyentes dentro del renderer congelado de WhatsApp.

## Verificación funcional adicional (server local, sesiones reales firmadas)

- Flujo modal → Domicilio/Recoger/Para llevar: vista correcta, chip activo
  correcto, tipo interno de Envíos sincronizado, "← Pedidos" regresa al
  tablero con la pestaña activa.
- guardarReglas disparado desde el bloque de Pagos: PUT /api/config OK,
  feedback "✓ Guardado correctamente" reflejado en ambos bloques.
- Sesión staff: sin Config/Ventas, sin tarjetas admin de Inicio, con
  "+ Nuevo pedido" operable; modal sin Restaurante si el módulo no está.
- Responsive desktop / tablet (768) / móvil (375): sin scroll horizontal;
  bottom-nav móvil = Comandas · Nuevo · Chats · Más (Corte oculto sin módulo
  caja); chips visibles y regreso funcional en móvil.
