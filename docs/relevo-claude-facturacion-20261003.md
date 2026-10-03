# Corrección del centro de facturación — 2026-10-03

Rama: `fix/facturacion-listado-20261003`. Base productiva: `23cf762`.

## Evidencia

Consulta de producción de solo lectura: XAB-1113 existe, total $1,180, emitida el
2 de octubre. Facturapi confirmó `valid`, `livemode: true`, UUID
`39995F19-EA5B-4F88-9D71-0AF7501AE9DC`. No hay que emitirla nuevamente.
El listado cargaba 100 de 570 registros y luego buscaba solo en ese subconjunto.
La búsqueda del servidor sí encontraba el folio.

Otros seis recibos abiertos tenían emisión registrada y válida en Facturapi:
XAB-0812, XAB-1042, RM-F6C73320-0, RM-72D08A06-0, RM-E3C38671-0,
RM-5F0A416A-0. El listado priorizaba el recibo abierto sobre el ledger de emisión.

## Cambios

- El panel recorre las páginas de ventas y servicios antes de buscar, filtrar o
  contar. Un fallo intermedio se muestra como error, sin presentar datos parciales.
- Los filtros Timbradas y Canceladas aceptan los estados de ventas y servicios.
- Una respuesta de una consulta anterior no pisa filtros más recientes.
- Contadores anteriores se limpian mientras se carga y ante errores.
- La consulta de recibos y su resumen comparten la misma proyección: cuando hay
  factura con identificador y UUID en el ledger del negocio, un recibo abierto,
  creando o con error se muestra facturado y permite descargar el documento.
  No se cambia el estado de recibos cancelados o globales. No se hacen llamadas
  al proveedor ni escrituras al consultar. La proyección no verifica cancelaciones
  remotas nuevas: eso sigue siendo responsabilidad del flujo de sincronización.
- Desempate por ID en la paginación de servicios.

El panel es un archivo protegido; el cambio se limita a lectura y presentación,
autorizadas para corregir este incidente. No se modifica emisión, pago, timbrado
ni datos de producción. No requiere migración.

## Pruebas

Node 22.23.3 y PostgreSQL local, bloqueo de red externa:

- `test/fase-facturacion-listado.mjs`: regresión SQL y ejecución del controlador
  del panel con DOM/API simulados. 570 ventas, búsqueda fuera de primera página,
  contadores completos, servicios timbrados, fallo parcial visible, aislamiento
  entre negocios y conservación del estado persistido.
- `test/fase-facturacion-por-negocio.mjs`: 53 aprobadas, 0 fallidas. Clave de
  cifrado exclusivamente de prueba. La aserción de ruta del panel se adaptó al
  nuevo cargador paginado; la prueba funcional cubre la carga real simulada.

## Pendientes y límite

Preparado para revisión e integración; no desplegado. El cambio carga el historial
completo en lotes de 100 para conservar la búsqueda por cliente/RFC y los contadores
del periodo existentes. Para historiales muy grandes conviene migrar los filtros
y agregados a un endpoint unificado; no se simula una búsqueda completa con un
límite silencioso. La carga falla explícitamente si excede el límite del endpoint.
No se hizo prueba visual en navegador ni emisión real.
