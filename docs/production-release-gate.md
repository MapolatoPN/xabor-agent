# Barrera de liberación a producción

Esta barrera se ejecuta después de preparar un cambio y antes de ampliar el
tráfico. Es de solo lectura: no crea pedidos, no cambia estados y no imprime.

```powershell
$env:DATABASE_URL = '<conexion>'
$env:XABOR_SMOKE_NEGOCIO_ID = '<uuid del negocio canario>'
$env:XABOR_BASE_URL = 'https://xabor.mx'
$env:XABOR_SMOKE_EMAIL = '<usuario de humo>'
$env:XABOR_SMOKE_PASSWORD = '<contraseña>'
npm run release:gate
```

El proceso aborta si falla cualquiera de estas comprobaciones:

- el servidor terminó su arranque;
- la sesión pertenece al negocio esperado;
- el menú responde y contiene productos;
- el historial responde;
- existen las restricciones únicas para mensajes y confirmaciones;
- ningún checkout reciente quedó sin pedido;
- ningún pago reciente quedó sin derivar;
- no hay dos pedidos vivos idénticos de WhatsApp creados en cinco minutos.

Para diagnosticar solamente la base se puede usar `npm run release:gate --
--db-only`. Esa modalidad no sustituye la barrera completa.

El predeploy ejecuta automáticamente `--db-only --all-agent-businesses` para
todos los negocios con `mesero_agente_v1=true`; no requiere configurar un UUID
en Railway. El humo HTTP autenticado sigue usando un negocio concreto.

Railway también ejecuta las migraciones 084 y 085 en cada predeploy. Así el
binario del agente nunca arranca sin su libro durable de operaciones y su cola
de salida.
