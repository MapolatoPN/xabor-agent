# Xabor Print Agent — instalación en Windows

Paquete de instalación local para `print-agent.js` (agente autenticado de
impresión por terminal). Instala una copia **aislada** — no el repositorio
completo — en una carpeta como `C:\Xabor Print Agent\`.

No incluye tokens, terminalId, URLs reales, nombres reales de impresora,
`DATABASE_URL` ni ningún archivo `.env`. Toda la configuración se guarda
como variables de entorno de Windows.

## Requisitos

- Windows (probado en Windows 11).
- Node.js **18 o superior** instalado y en `PATH`.
- La terminal debe existir ya en la base de datos, creada previamente con
  `scripts/crear-terminal-impresion.js` (fuera del alcance de este
  paquete) — este instalador nunca crea terminales ni se conecta a ninguna
  base de datos.

## Qué se instala

```
C:\Xabor Print Agent\
  print-agent.js              (copia aislada, no un symlink al repo)
  package.json                (mínimo: { "type": "module" })
  node_modules\ws\             (única dependencia externa real)
  iniciar-print-agent.ps1
  detener-print-agent.ps1
  verificar-print-agent.ps1
  desinstalar-print-agent.ps1
  logs\
    print-agent.log
    print-agent-error.log
  dedup\
    print-agent-jobs.json
  agente.pid                  (se crea al iniciar)
  estado.json                 (metadatos no sensibles: último inicio, PID)
```

No se copia el repositorio completo, ni `node_modules` completo (solo
`ws`, que es la única dependencia externa de `print-agent.js` — el resto
son módulos nativos de Node: `crypto`, `fs`, `path`, `url`, `os`,
`child_process`).

## Instalación

Desde una PowerShell **normal** (no requiere administrador si usas el
ámbito `User`, que es el valor por defecto):

```powershell
cd installer\windows
.\instalar-print-agent.ps1
```

El instalador pedirá interactivamente:
- `XABOR_WS_URL`
- `XABOR_TERMINAL_ID`
- `XABOR_TERMINAL_TOKEN` (con `Read-Host -AsSecureString` — **nunca se
  muestra en pantalla, ni se guarda en ningún archivo**)
- Nombre exacto de la impresora (se listan las impresoras instaladas con
  `Get-Printer`; nunca se asume una por defecto)

También acepta parámetros para instalación no interactiva:

```powershell
.\instalar-print-agent.ps1 `
  -RutaInstalacion 'C:\Xabor Print Agent' `
  -WsUrl 'wss://tu-backend.up.railway.app' `
  -TerminalId '<terminalId-real>' `
  -PrinterName '<nombre-exacto-de-Get-Printer>' `
  -CrearInicioAutomatico
```

(El token, si no se pasa por `-TerminalTokenSeguro` como `SecureString`,
siempre se pide interactivamente y oculto.)

**Importante:** si tenías una ventana de PowerShell abierta antes de
instalar, ábrela de nuevo — las variables de entorno de nivel
Usuario/Máquina no se propagan a sesiones ya abiertas.

### Modo simulación

```powershell
.\instalar-print-agent.ps1 -Simular
```

Ejecuta todas las validaciones (Node, impresora, variables) y muestra qué
haría, sin copiar archivos, sin guardar variables, sin tocar el
Programador de tareas.

## Uso diario

```powershell
cd 'C:\Xabor Print Agent'
.\iniciar-print-agent.ps1     # inicia (rechaza una segunda instancia)
.\verificar-print-agent.ps1   # muestra estado, sin secretos
.\detener-print-agent.ps1     # detiene solo el proceso correcto
```

## Inicio automático con Windows

Por defecto **no se activa**. Para activarlo, agrega la bandera al
instalar:

```powershell
.\instalar-print-agent.ps1 -CrearInicioAutomatico
```

Esto registra una tarea programada `XaborPrintAgent`:
- se ejecuta al encender Windows, con 30 segundos de retraso;
- reintenta hasta 3 veces si falla;
- nunca permite instancias múltiples (`MultipleInstances IgnoreNew`, más
  el propio archivo `agente.pid` como segunda barrera).

Para quitarlo:

```powershell
Unregister-ScheduledTask -TaskName 'XaborPrintAgent' -Confirm:$false
```

(o usa `desinstalar-print-agent.ps1 -EliminarTareaProgramada`).

## Desinstalación

```powershell
.\desinstalar-print-agent.ps1
```

Por defecto **conserva** `dedup\`, `logs\`, las variables de entorno y la
tarea programada. Usa `-EliminarDatos`, `-EliminarVariables` y/o
`-EliminarTareaProgramada` explícitamente si de verdad quieres borrarlos.
Pide confirmación escrita (`desinstalar`) antes de tocar nada.

## Protección del token

- Se captura con `Read-Host -AsSecureString` (nunca aparece en pantalla ni
  en el historial de PowerShell como texto plano).
- Se descifra únicamente en memoria del proceso instalador, el tiempo
  mínimo necesario para llamar a `[Environment]::SetEnvironmentVariable`,
  y la variable local se limpia inmediatamente después.
- Se guarda **solo** como variable de entorno de Windows — nunca en un
  archivo `.env`, nunca en un commit, nunca en un log.
- `verificar-print-agent.ps1` solo reporta si la variable está definida
  (sí/no), nunca su valor, e incluye un filtro defensivo adicional que
  redacta cualquier línea de log que mencione `token:` antes de
  mostrarla — aunque `print-agent.js` ya no lo registre nunca (verificado
  en la fase anterior).

**Nota sobre el nivel de protección real:** una variable de entorno de
usuario en Windows vive en el registro (`HKCU:\Environment`) en texto
plano, legible por cualquier proceso que corra como ese mismo usuario.
Esto es un compromiso aceptado y documentado para un agente local de un
solo propósito — no es equivalente a un gestor de secretos dedicado. Si en
el futuro se requiere mayor aislamiento, considerar Windows Credential
Manager o un servicio dedicado con su propia cuenta de sistema.

## Logs

`logs\print-agent.log` y `logs\print-agent-error.log`. Rotación simple:
si el log supera 5 MB **en el momento de iniciar el agente**, se rota a
`.1`, `.2`, ... hasta conservar 5 archivos. No es una rotación continua
mientras el proceso corre — reinicios frecuentes con logs pequeños no
acumulan historial entre reinicios; esto es deliberadamente simple, no un
sistema de logging robusto.

`print-agent.js` no escribe logs a archivo por sí mismo — nunca se
modificó para esto. La redirección ocurre completamente desde
`iniciar-print-agent.ps1` (stdout/stderr del proceso `node`), sin tocar el
código del agente.

## Legacy

Este paquete **no cambia `print_agent_legacy_activo`** para ningún
negocio. Nonna Maye permanece en modo legacy hasta que se autorice
explícitamente el cambio, en una fase separada.
