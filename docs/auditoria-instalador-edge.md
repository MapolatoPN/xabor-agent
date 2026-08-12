# Auditoría — Dos defectos reales del instalador de Xabor Edge

**Estado: diagnóstico con causa raíz confirmada por lectura de código.
Ninguna corrección implementada todavía — plan propuesto al final de cada
defecto, pendiente de aprobación. Sin deploy.**

Ambos defectos se observaron en instalaciones reales (2026-08-11) y ambos
tienen su causa raíz en `installer/XaborEdge.iss`, con un cómplice en
`installer/canjear.mjs` para el segundo.

---

## Defecto (a): el upgrade falla con "A service with ID 'XaborEdge' already exists"

### Síntoma

Ejecutar el instalador sobre un equipo que YA tiene Xabor Edge instalado
(el caso normal de actualización o reparación) termina con el error de
WinSW "A service with ID 'XaborEdge' already exists", el MsgBox crítico
del instalador y un `Abort`.

### Causa raíz (confirmada)

`CurStepChanged(ssPostInstall)` en `installer/XaborEdge.iss` ejecuta
**incondicionalmente**:

```
XaborEdgeService.exe install
```

WinSW `install` registra el servicio; si el servicio ya existe (upgrade),
falla con exactamente ese error y exit code ≠ 0. El script trata cualquier
código distinto de 0 como fallo fatal → MsgBox + `Abort`.

El instalador solo maneja el servicio en `[UninstallRun]` (al
desinstalar) — no hay ninguna rama de "ya instalado" en el camino de
instalación.

### Defecto secundario del mismo bloque (detectado en esta auditoría)

Durante la fase de copia de archivos de un upgrade, el servicio anterior
**sigue corriendo**: nadie lo detiene antes de copiar. `node.exe`,
`XaborEdgeService.exe` y el árbol `app\` están en uso por el proceso del
servicio, así que la copia puede fallar con archivos bloqueados o dejar
una mezcla de binarios viejos y nuevos hasta el siguiente reinicio. El
error del servicio "already exists" está enmascarando este segundo
problema: hoy nadie llega a verlo porque el Abort ocurre después, pero al
corregir (a) sin esto, el upgrade seguiría siendo defectuoso.

### Plan de corrección propuesto (no implementado)

1. En `PrepareToInstall` (después del canje, antes de la copia): si el
   servicio existe, detenerlo — `XaborEdgeService.exe stop` tolerando el
   fallo (puede estar detenido) — para liberar los binarios antes de que
   Inno copie encima. Detectar existencia con `sc.exe query XaborEdge`
   (exit 0 = existe, 1060 = no existe) para no depender de parsear texto
   localizado.
2. En `CurStepChanged(ssPostInstall)`: registrar el servicio **solo si no
   existe**; si ya existe, saltar el `install` y pasar directo al
   `start`. (Alternativa equivalente: `uninstall` + `install`
   incondicionales; se prefiere la condicional porque no toca la
   configuración de recuperación/estado que Windows guarda del servicio.)
3. Prueba nueva de instalador (nivel unitario sobre el .iss, mismo patrón
   que las suites que ya leen archivos fuente): verificar que el script
   contiene la detención previa a la copia y la rama condicional del
   `install` — el mismo estilo de prueba de contrato usado en
   `fase-edge-discovery-timeouts.mjs` casos 1/6/8.
4. Validación manual (checklist para el propietario): instalar sobre una
   instalación existente en una VM y confirmar que termina sin error, que
   el servicio queda corriendo con los binarios nuevos y que la
   vinculación se conserva.

---

## Defecto (b): el Setup de producción reutilizó una config con `ws://localhost:4300`

### Síntoma

Un Setup compilado para producción (UrlXabor = `https://xabor.mx`)
terminó "correctamente" en un equipo, pero el servicio quedó conectándose
a `ws://localhost:4300` — la URL de una instalación de PRUEBA anterior.

### Causa raíz (confirmada — cadena completa)

1. Una instalación de prueba anterior (compilada con
   `/DUrlXabor=http://localhost:4300`) escribió
   `ProgramData\Xabor\Edge\config\config.json` con
   `urlNube: "ws://localhost:4300/ws/print-agent"` (la URL se persiste
   por `canjear.mjs`, que la deriva de `--url`).
2. El Setup de producción evalúa `YaVinculado()` —
   `installer/XaborEdge.iss` — que devuelve `true` con la **mera
   existencia** del archivo `config.json`, sin mirar su contenido.
3. Con `YaVinculado = true`: la página del código se salta
   (`ShouldSkipPage`), `PrepareToInstall` sale sin canjear
   (`if YaVinculado then Exit`), y el servicio arranca leyendo la config
   vieja (`edge/config.js` → `XABOR_EDGE_WS_URL` ← `urlNube`).
4. `canjear.mjs` tiene la misma miopía como segunda línea de defensa
   fallida: acepta cualquier config previa con `terminalId` +
   `terminalToken` y sale con 0 ("se conservan sus credenciales") sin
   comparar `urlNube` contra la `--url` del instalador actual.

El diseño de "conservar la vinculación al reinstalar" es correcto para su
caso de uso (reparar el servicio en el MISMO entorno, sin gastar un
código de un solo uso). El defecto es que "hay una config" se usa como
sinónimo de "hay una config **de este mismo Xabor**".

### Riesgo adicional del mismo origen

Las credenciales (`terminalId`/`terminalToken`) de un entorno de prueba
no valen en producción: aunque la URL fuera correcta, un equipo con
config de prueba nunca autenticaría contra `xabor.mx`. La comparación
debe hacerse por URL de entorno, no solo por presencia de credenciales.

### Plan de corrección propuesto (no implementado)

1. `canjear.mjs`: al encontrar config previa, comparar el origen de
   `previa.urlNube` contra la `--url` recibida (normalizando `ws://`↔
   `http://` y `wss://`↔`https://`). Solo si coinciden, conservar y salir
   0. Si no coinciden, tratar como NO vinculado y canjear normalmente
   (guardando la config nueva). Mantener intacto el caso EACCES/EPERM
   (exit 6).
2. `XaborEdge.iss`: `YaVinculado` no puede leer JSON cómodamente desde
   Inno; la opción de menor riesgo es delegar la decisión en
   `canjear.mjs` (que ya corre con Node): eliminar el atajo
   `if YaVinculado then Exit` de `PrepareToInstall` y ejecutar SIEMPRE el
   canje, pasando la URL — `canjear.mjs` decide si conserva (mismo
   entorno) o canjea (entorno distinto). Para la página del código:
   mantener `ShouldSkipPage` pero con una verificación mínima de
   contenido (buscar la cadena del host de `UrlXabor` dentro del
   config.json con `LoadStringFromFile`/`Pos`) para no pedir código
   cuando de verdad es el mismo entorno.
   - Nota: si se elimina el atajo sin ajustar la página, un equipo con
     config ajena llegaría al canje sin código tecleado → `canjear.mjs`
     saldría 5 ("falta el código"). Por eso ambos cambios van juntos.
3. Pruebas nuevas (extender la suite existente del canje, si la hay, o
   crear `fase-instalador-canje.mjs` con `XABOR_EDGE_PROGRAMDATA`
   apuntando a un directorio temporal — el hook ya existe en
   `canjear.mjs`):
   - config previa del MISMO origen → conserva, exit 0, no llama a fetch;
   - config previa de OTRO origen (localhost) + código válido → canjea y
     sobrescribe con la URL nueva;
   - config previa de otro origen sin código → exit distinto de 0, nunca
     "éxito" silencioso;
   - EACCES → exit 6 intacto.
4. Validación manual: en una VM con config de prueba plantada, correr el
   Setup de producción y confirmar que PIDE código y que la config final
   apunta a `wss://xabor.mx/ws/print-agent`.

---

## Orden recomendado

Primero (b) — es el más peligroso: produce instalaciones que *parecen*
correctas y dejan al restaurante con un equipo que jamás se conectará.
Después (a), que al menos falla ruidosamente. Ambos caben en la misma
rama y la misma tanda de pruebas del instalador.
