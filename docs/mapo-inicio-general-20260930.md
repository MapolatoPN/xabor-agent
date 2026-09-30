# Mapo Bot — apertura general solicitada el 30 de septiembre de 2026

## Alcance

Solo Mapolato Obispado. El dueño solicita desplegar y atender todos los números.
No es una campaña: responde a contactos entrantes dentro de la ventana de Meta.
No se levantan pausas individuales ni se cambian otros negocios, pedidos o tarifas.

Un saludo sin carrito inicia una bienvenida por hora local y un menú de cuatro
opciones. Es una lista nativa, no cuatro botones de respuesta (límite: tres).
Un mensaje que ya pide productos, promociones o ayuda conserva su ruta; no se
obliga al cliente a empezar nuevamente. Un carrito en curso no se pierde por saludar.

| Opción | Resultado |
| --- | --- |
| Ordenar | Abre el Flow vigente por categorías, personalización y carrito. Respeta horario y confirmación final. |
| Facturación | Formulario fiscal y referencia de compra; captura durable y atención del personal. No timbra CFDI. |
| Servicio para eventos | Nombre, evento, fecha, hora, personas, lugar y necesidades; el personal cotiza. No agenda, vende ni reserva. |
| Otra duda | Pausa automática de esa conversación y entrega al personal. |

Facturación y eventos pueden recibirse fuera del horario de venta. Los datos no
se envían al modelo: se validan, almacenan y muestran en el historial del panel.
La validación fiscal es de formato, no acreditación ante el SAT. El personal
verifica compra, régimen, uso y emisión. Nunca se solicitan contraseñas/e.firma.

## Integración y riesgos revisados

- Archivos nuevos `inicioMapo.js` y `solicitudesServicio.js`; adaptaciones acotadas
  al canal del agente, reserva, persistencia, outbox e historial.
- No modifica los componentes protegidos de CLAUDE.md, impresión ni pagos.
- Migración 108 aditiva: amplía acciones y crea fichas de servicio. Se probó
  repetir 104–108 con tokens existentes, conservando el contrato ampliado.
- Captura, consumo del token, pausa y aviso durable se confirman juntos en SQL.
  Un reinicio no pierde la solicitud. Identidad, negocio, teléfono, contexto,
  huella, TTL y doble toque siguen validados.
- Única excepción a la pausa automática: acuse fijo de esa solicitud por dos
  minutos, con ventana de 24 horas válida. Una intervención humana posterior,
  un apagado maestro o texto diferente lo impiden. No autoriza al modelo.
- El Flow no reemplaza la disponibilidad real de personal. Las solicitudes
  requieren que Mapolato revise Chats y responda.
- Restricción WABA 141006 observada en Meta: conversaciones iniciadas por el
  negocio bloqueadas por método de pago. No se cambió facturación de Meta;
  esta entrega es para atención entrante, no campañas ni recontactos tardíos.
- El incidente de vigencia de la promoción del miércoles es independiente y
  no queda corregido por esta entrega. No se modificaron fechas, precios o
  condiciones de promociones para abrir la atención general.

## Evidencia local

Node 22.23.3, PostgreSQL local desechable, red externa bloqueada en pruebas.

- `npm run test:incident`: verde, incluido el chequeo nuevo de Mapo.
- `npm run mesero:tools`: 66/66.
- `npm run mesero:replay`: 26/26, cero invariantes críticas rotas.
- `test/fase-inicio-mapo-db.mjs`: 9/9.
- `test/fase-inicio-mapo-webhook.mjs`: verde; webhook firmado, dos procesos,
  número fuera de listas, menú, pedido, factura, duplicados y silencio al pasar
  al personal. Entradas posteriores permanecen pendientes para atención humana.
- `test/fase-flows-db.mjs`: 23/23.
- `test/fase-beta-hibrida-db.mjs`: 11/11.
- `test/fase-outbox-entrega-db.mjs`: 25/25.
- `git diff --check`: verde.

Una ejecución del fixture tropezó con una colisión de teléfono sintético en una
base reutilizada; la repetición completa pasó. Una aserción del E2E esperaba
erróneamente que entradas pausadas fueran turnos completados: se corrigió para
verificar conservación en historial, pausa y ausencia de respuesta.

## Publicación y activación

1. Publicar los dos Flow JSON validados por Meta sin errores:
   facturación `1465791332088956`; eventos `957762156770578`.
2. Desplegar código y migración; verificar SHA en Railway y en proceso.
3. Ejecutar `node scripts/activar-inicio-mapo.mjs <negocio> <SHA> activar`.
   Verifica master, módulo, capacidades, formularios publicados y conserva
   respaldo de las siete claves cambiadas. Elimina la restricción de lista
   del agente y habilita porcentaje 100; mantiene listas antiguas de Flows/beta
   para respaldo, pero la bandera general explícita permite todos los números.
4. Verificar estado final y pedir al dueño una conversación nueva de prueba.
   Las pruebas simuladas no certifican el aspecto en el teléfono real.

Rollback de configuración: mismo script con `revertir`, sin enviar mensajes ni
tocar pausas. Rechaza sobrescribir si alguien cambió esas claves después.
El respaldo queda en `whatsapp_inicio_mapo_respaldo_20260930`; no contiene secretos.

Estado al preparar este documento: pruebas verdes, apertura general todavía
apagada. El despliegue y la activación se registran al terminar.
