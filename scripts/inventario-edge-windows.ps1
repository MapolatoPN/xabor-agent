# Inventario de la PC candidata a Xabor Edge y de sus impresoras.
#
# ================================ QUE NO HACE ================================
#
# ESTRICTAMENTE DE SOLO LECTURA. Solo usa cmdlets Get-* y Test-*. No instala
# nada, no crea ni borra impresoras, no cambia puertos ni IPs, no toca el
# firewall ni los servicios, no escribe en el registro, no toca Wansoft y
# NO IMPRIME UNA SOLA HOJA.
#
# Tampoco escanea la red: las unicas IPs que consulta son las que ya estaban
# configuradas en los puertos de impresora de esta misma PC. Si no hay
# ninguna, no consulta ninguna.
#
# Lo unico que escribe es un archivo markdown en el Escritorio.
#
# Se puede correr durante el turno, sin cerrar Wansoft y sin ser
# administrador. Lo que requiera permisos que no hay queda como PENDIENTE.
#
# ================================== USO ======================================
#
#   powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\inventario-edge-windows.ps1
#
# Funciona desde una carpeta copiada a mano (USB, Escritorio, lo que sea): no
# necesita el repo, ni Node, ni npm, ni internet.
#
# ============================= QUE NO DEDUCE =================================
#
# El script NO adivina cual impresora es Tickets, Chilaquiles, Cocina General
# o Bebidas. Que una se llame "POS-80" no dice donde esta ni que imprime. Esa
# asignacion se hace mirando la instalacion, y el reporte deja el hueco.

$ErrorActionPreference = 'Continue'

# El Escritorio puede estar redirigido a OneDrive; GetFolderPath lo resuelve.
# Si aun asi no existe, el perfil del usuario siempre esta.
$escritorio = [Environment]::GetFolderPath('Desktop')
if (-not $escritorio -or -not (Test-Path $escritorio)) { $escritorio = $env:USERPROFILE }
$salida = Join-Path $escritorio ("Xabor-Obispado-Inventario-{0}.md" -f (Get-Date -Format 'yyyyMMdd-HHmm'))

$lineas = New-Object System.Collections.ArrayList
$incidencias = New-Object System.Collections.ArrayList

function Escribir($texto) { [void]$lineas.Add($texto); Write-Host $texto }
function Campo($nombre, $valor) {
  if ($null -eq $valor -or "$valor".Trim() -eq '') { $valor = 'PENDIENTE' }
  Escribir ("- **{0}:** {1}" -f $nombre, $valor)
}
# Un cmdlet que falla no puede matar el inventario entero. Lo que no se pudo
# leer es PENDIENTE, no una excepcion: la visita a Obispado es cara y volver
# con medio reporte por un permiso faltante seria absurdo.
function Intentar($bloque) {
  try { & $bloque } catch { $null }
}
function Anotar($texto) { [void]$incidencias.Add($texto) }

Escribir "# Inventario Xabor Edge -- Mapolato Obispado"
Escribir ""
Escribir ("Generado: {0}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'))
Escribir ""
Escribir "> Solo lectura. Este reporte no cambio nada en esta PC ni en las impresoras."
Escribir ""

# =============================== PC =========================================
Escribir "## PC"
Escribir ""
$cs  = Intentar { Get-CimInstance Win32_ComputerSystem -ErrorAction Stop }
$os  = Intentar { Get-CimInstance Win32_OperatingSystem -ErrorAction Stop }
$cpu = Intentar { Get-CimInstance Win32_Processor -ErrorAction Stop | Select-Object -First 1 }
if (-not $cs) { Anotar 'No se pudo consultar WMI/CIM: faltan datos de hardware.' }

$esAdmin = Intentar {
  $id = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if ($id.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { 'si' } else { 'no' }
}

Campo 'hostname' $env:COMPUTERNAME
Campo 'Fabricante / modelo' $(if ($cs) { "$($cs.Manufacturer) $($cs.Model)" })
Campo 'Windows' $(if ($os) { $os.Caption })
Campo 'Version / build' $(if ($os) { "$($os.Version) (build $($os.BuildNumber))" })
Campo 'Arquitectura' $env:PROCESSOR_ARCHITECTURE
Campo 'CPU' $(if ($cpu) { "$($cpu.Name) -- $($cpu.NumberOfCores) nucleos" })
Campo 'RAM' $(if ($cs) { "{0:N1} GB" -f ($cs.TotalPhysicalMemory / 1GB) })
$disco = Intentar { Get-PSDrive C -ErrorAction Stop }
Campo 'Espacio libre en C:' $(if ($disco) { "{0:N1} GB libres de {1:N1} GB" -f ($disco.Free/1GB), (($disco.Free + $disco.Used)/1GB) })
Campo 'Usuario Windows' $env:USERNAME
Campo 'Corriendo como administrador' $esAdmin
Campo 'PowerShell' $PSVersionTable.PSVersion.ToString()

# Node no hace falta para ESTE script; se mira porque Edge si lo necesita.
$node = Intentar { (Get-Command node -ErrorAction Stop).Source }
Campo 'Node instalado (lo necesitara Edge, no este script)' $(if ($node) { "si -- $node" } else { 'NO' })
Campo 'Version de Node' $(if ($node) { Intentar { & node --version } })
Campo 'Version de npm'  $(Intentar { & npm --version })
Escribir ""
Escribir "- **Siempre encendida:** PENDIENTE (preguntar en sitio)"
Escribir "- **Carpeta prevista para Edge:** C:\Xabor\Edge (se creara en la fase de instalacion, no ahora)"
Escribir ""

# =============================== RED ========================================
Escribir "## Red"
Escribir ""
$adaptadores = Intentar { Get-NetIPConfiguration -ErrorAction Stop | Where-Object { $_.IPv4Address } }
if ($adaptadores) {
  foreach ($a in $adaptadores) {
    $perfil = Intentar { Get-NetConnectionProfile -InterfaceIndex $a.InterfaceIndex -ErrorAction Stop }
    $tipo = if ($a.InterfaceAlias -match 'Wi-?Fi|Wireless|inalambr') { 'Wi-Fi' } else { 'Ethernet / otro' }
    $dns = Intentar { ($a.DNSServer | Where-Object { $_.AddressFamily -eq 2 } | ForEach-Object { $_.ServerAddresses }) -join ', ' }
    Escribir ("- **{0}** ({1})" -f $a.InterfaceAlias, $tipo)
    Escribir ("  - IP: {0}/{1}" -f $a.IPv4Address.IPAddress, $a.IPv4Address.PrefixLength)
    Escribir ("  - Gateway: {0}" -f $(if ($a.IPv4DefaultGateway) { $a.IPv4DefaultGateway.NextHop } else { 'sin gateway' }))
    Escribir ("  - DNS: {0}" -f $(if ($dns) { $dns } else { 'PENDIENTE' }))
    Escribir ("  - Perfil de red: {0}" -f $(if ($perfil) { $perfil.NetworkCategory } else { 'PENDIENTE' }))
  }
} else {
  Escribir "- PENDIENTE: no se pudo leer la configuracion de red."
  Anotar 'Get-NetIPConfiguration no devolvio nada.'
}
Escribir ""
# Solo se mira si el firewall esta encendido. No se crea ni se modifica ninguna regla.
$fw = Intentar { Get-NetFirewallProfile -ErrorAction Stop | Where-Object { $_.Enabled } }
Campo 'Firewall activo en perfiles' $(if ($fw) { ($fw.Name) -join ', ' } elseif ($esAdmin -eq 'no') { 'PENDIENTE (puede requerir admin)' } else { 'ninguno' })
Escribir ""

# ============================= WANSOFT ======================================
Escribir "## Wansoft (NO TOCAR -- solo se registra que sigue ahi)"
Escribir ""
$rutas = @('C:\Program Files', 'C:\Program Files (x86)', 'C:\') | Where-Object { Test-Path $_ }
$wan = Intentar { Get-ChildItem $rutas -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Name -match 'wansoft|soft.?restaurant|national.?soft' } }
Campo 'Carpetas encontradas' $(if ($wan) { ($wan.FullName) -join ' | ' } else { 'ninguna' })
$svc = Intentar { Get-Service -ErrorAction Stop | Where-Object { $_.Name -match 'wansoft|nationalsoft|softrest' -or $_.DisplayName -match 'wansoft|national soft|soft restaurant' } }
Campo 'Servicios' $(if ($svc) { ($svc | ForEach-Object { "$($_.Name)=$($_.Status)" }) -join ' | ' } else { 'ninguno detectado' })
$proc = Intentar { Get-Process -ErrorAction Stop | Where-Object { $_.ProcessName -match 'wansoft|softrest|nationalsoft' } }
Campo 'Procesos corriendo' $(if ($proc) { ($proc.ProcessName | Sort-Object -Unique) -join ' | ' } else { 'ninguno detectado' })
Escribir ""

# ========================== CLASIFICACION ===================================
#
# Conservadora a proposito. "Candidato" nunca significa "compatible": eso solo
# lo dice una hoja de papel saliendo de la impresora correcta.
function Clasificar($impresora, $puerto) {
  $nombrePuerto = "$($impresora.PortName)"
  $driver = "$($impresora.DriverName)"

  if ($puerto -and $puerto.PrinterHostAddress) {
    switch ($puerto.Protocol) {
      1 { return @{ tipo = 'Standard TCP/IP (RAW)'; transporte = 'candidato tcp_raw';
                    falta = 'confirmar puerto real, ancho de papel y que sea ESC/POS' } }
      2 { return @{ tipo = 'Standard TCP/IP (LPR)'; transporte = 'REQUIERE SOPORTE LPR -- no implementado';
                    falta = 'nombre de la cola LPR' } }
      default { return @{ tipo = "Standard TCP/IP (protocolo $($puerto.Protocol))"; transporte = 'REVISAR';
                          falta = 'protocolo no reconocido' } }
    }
  }
  # Virtuales: PDF, XPS, OneNote, fax, AnyDesk, "imprimir a archivo". No son
  # termicas y no deben acabar en la lista de candidatas por descuido.
  if ($nombrePuerto -match '^(nul:|PORTPROMPT:|FILE:|SHRFAX:)$' -or
      $driver -match 'PDF|XPS|OneNote|Fax|AnyDesk|Send To') {
    return @{ tipo = 'virtual (no es una impresora fisica)'; transporte = 'ninguno -- ignorar';
              falta = 'nada: no aplica' }
  }
  if ($nombrePuerto -match '^WSD-' -or $nombrePuerto -match '^\{[0-9a-fA-F-]+\}$') {
    return @{ tipo = 'WSD'; transporte = 'REVISAR -- probablemente Windows spooler';
              falta = 'saber si el equipo tambien expone RAW TCP' }
  }
  if ($nombrePuerto -match '^\\\\' -or $impresora.Type -eq 'Connection') {
    return @{ tipo = 'cola de red / compartida'; transporte = 'REVISAR WINDOWS SPOOLER -- no implementado';
              falta = 'que PC hospeda la cola y si la impresora tiene IP propia' }
  }
  if ($nombrePuerto -match '^(USB|COM|LPT)') {
    return @{ tipo = "local por $($matches[1])"; transporte = 'REQUIERE WINDOWS SPOOLER -- no implementado';
              falta = 'saber si el modelo tiene puerto de red' }
  }
  return @{ tipo = "puerto no reconocido ($nombrePuerto)"; transporte = 'REVISAR';
            falta = 'inspeccionar el puerto a mano en Propiedades de impresora' }
}

# ========================= IMPRESORAS DE WINDOWS ============================
Escribir "## Impresoras de Windows"
Escribir ""
$impresoras = Intentar { Get-Printer -ErrorAction Stop }
$puertos    = Intentar { Get-PrinterPort -ErrorAction Stop }
$resumen    = New-Object System.Collections.ArrayList
$objetivos  = @{}

if (-not $impresoras) {
  Escribir "- PENDIENTE: Get-Printer no devolvio nada (spooler detenido, permisos, o Windows sin el modulo)."
  Anotar 'Get-Printer no devolvio nada: el inventario de impresoras quedo vacio.'
} else {
  foreach ($p in $impresoras) {
    # Cada impresora en su propio try: una que falle no puede tumbar el resto.
    try {
      $puerto = $null
      if ($puertos) { $puerto = $puertos | Where-Object { $_.Name -eq $p.PortName } | Select-Object -First 1 }
      $clase = Clasificar $p $puerto

      Escribir ("### {0}" -f $p.Name)
      Campo 'DriverName' $p.DriverName
      Campo 'PortName' $p.PortName
      Campo 'Shared' $p.Shared
      Campo 'ShareName' $p.ShareName
      Campo 'PrinterStatus' $p.PrinterStatus
      Campo 'WorkOffline' $(Intentar { (Get-CimInstance Win32_Printer -Filter "Name='$($p.Name -replace "'","''")'" -ErrorAction Stop).WorkOffline })
      Campo 'Location' $p.Location
      Campo 'Type' $p.Type
      Campo 'Clasificacion' $clase.tipo
      Campo 'Transporte Xabor sugerido' $clase.transporte
      Campo 'Dato que falta' $clase.falta

      if ($puerto -and $puerto.PrinterHostAddress) {
        # Sin PortNumber declarado, Windows usa 9100. Eso es un DEFECTO del
        # sistema, no una medicion: se dice tal cual en vez de afirmarlo.
        $num = if ($puerto.PortNumber) { "$($puerto.PortNumber)" } else { '(no declarado; Windows asume 9100 -- confirmar)' }
        $objetivos[$p.Name] = @{ ip = $puerto.PrinterHostAddress; puerto = $puerto.PortNumber }
        Campo 'HostAddress' $puerto.PrinterHostAddress
        Campo 'PortNumber' $num
      }
      Escribir ""
      [void]$resumen.Add([pscustomobject]@{ Nombre = $p.Name; Clase = $clase.tipo; Transporte = $clase.transporte; Falta = $clase.falta })
    } catch {
      Escribir ("### {0}" -f $p.Name)
      Escribir ("- **ERROR al inventariar esta impresora:** {0}" -f $_.Exception.Message)
      Escribir "- El resto del inventario continua."
      Escribir ""
      Anotar ("Fallo al inventariar '{0}': {1}" -f $p.Name, $_.Exception.Message)
    }
  }
}

# ============================== PUERTOS =====================================
Escribir "## Puertos de impresora"
Escribir ""
if (-not $puertos) {
  Escribir "- PENDIENTE: Get-PrinterPort no devolvio nada."
  Anotar 'Get-PrinterPort no devolvio nada.'
} else {
  Escribir "| Name | HostAddress | PortNumber | Protocol | Cola LPR | SNMP |"
  Escribir "|---|---|---|---|---|---|"
  foreach ($pt in $puertos) {
    $proto = switch ($pt.Protocol) { 1 { 'RAW' } 2 { 'LPR' } $null { '' } default { "codigo $($pt.Protocol)" } }
    $num = if ($pt.PortNumber) { "$($pt.PortNumber)" } elseif ($pt.PrinterHostAddress) { '(no declarado; Windows asume 9100 -- confirmar)' } else { '' }
    Escribir ("| {0} | {1} | {2} | {3} | {4} | {5} |" -f $pt.Name, $pt.PrinterHostAddress, $num, $proto, $pt.LprQueueName, $pt.SNMPEnabled)
  }
}
Escribir ""

# =========================== CONECTIVIDAD ===================================
Escribir "## Conectividad"
Escribir ""
Escribir "> Solo contra las IPs que ya estaban configuradas en esta PC. No se escanea la red."
Escribir ""
if ($objetivos.Count -eq 0) {
  Escribir "- Ninguna impresora tiene IP configurada: no hay nada que probar sin adivinar."
} else {
  foreach ($nombre in $objetivos.Keys) {
    $o = $objetivos[$nombre]
    # Muchas termicas no responden ICMP pero si aceptan TCP. Un ping fallido
    # NO significa que la impresora este muerta; por eso se reportan aparte.
    $ping = Intentar { Test-Connection -ComputerName $o.ip -Count 2 -Quiet -ErrorAction Stop }
    Escribir ("### {0} ({1})" -f $nombre, $o.ip)
    Campo 'Ping' $(if ($ping) { 'responde' } else { 'no responde (normal en muchas termicas, o ICMP bloqueado)' })
    if ($o.puerto) {
      $tcp = Intentar { Test-NetConnection -ComputerName $o.ip -Port $o.puerto -WarningAction SilentlyContinue -ErrorAction Stop }
      Campo ("TCP {0}" -f $o.puerto) $(if ($tcp -and $tcp.TcpTestSucceeded) { 'Succeeded' } else { 'Failed' })
      Campo 'Latencia' $(if ($tcp -and $tcp.PingReplyDetails) { "$($tcp.PingReplyDetails.RoundtripTime) ms" } else { 'PENDIENTE' })
    } else {
      Campo 'TCP' 'no probado: el puerto no esta declarado y no se adivina'
    }
    Escribir ""
  }
}

# ======================== RESUMEN DE CLASIFICACION ==========================
Escribir "## Resumen: que puede imprimir Xabor hoy"
Escribir ""
if ($resumen.Count -eq 0) {
  Escribir "- Sin datos."
} else {
  Escribir "| Impresora | Clasificacion | Transporte sugerido | Dato que falta |"
  Escribir "|---|---|---|---|"
  foreach ($r in $resumen) { Escribir ("| {0} | {1} | {2} | {3} |" -f $r.Nombre, $r.Clase, $r.Transporte, $r.Falta) }
  Escribir ""
  Escribir "**Candidato no es compatible.** Solo una hoja saliendo de la impresora correcta lo demuestra."
}
Escribir ""

# ====================== IDENTIFICACION FISICA (A MANO) ======================
Escribir "## Identificacion fisica -- llenar en sitio"
Escribir ""
Escribir "Ningun comando puede saber cual de las impresoras de arriba es cual."
Escribir "Hay que mirarlas. Un nombre como POS-80 no dice donde esta ni que imprime."
Escribir ""
foreach ($f in 'TICKETS', 'CHILAQUILES', 'COCINA GENERAL', 'BEBIDAS') {
  Escribir ("### Funcion: {0}" -f $f)
  Escribir "- Nombre de Windows al que corresponde: PENDIENTE"
  Escribir "- Marca: PENDIENTE"
  Escribir "- Modelo: PENDIENTE"
  Escribir "- Numero de serie: PENDIENTE"
  Escribir "- MAC: PENDIENTE"
  Escribir "- Ancho de papel (58 / 80 mm): PENDIENTE"
  Escribir "- ESC/POS: PENDIENTE"
  Escribir "- Ubicacion fisica: PENDIENTE"
  Escribir "- Cable (Ethernet / USB): PENDIENTE"
  Escribir "- Wansoft imprime aqui, y como: PENDIENTE"
  Escribir ""
}

# ============================= INCIDENCIAS ==================================
Escribir "## Incidencias del inventario"
Escribir ""
if ($incidencias.Count -eq 0) {
  Escribir "- Ninguna: todo lo consultable se pudo leer."
} else {
  foreach ($i in $incidencias) { Escribir ("- {0}" -f $i) }
  if ($esAdmin -eq 'no') { Escribir "- Nota: el script corrio SIN privilegios de administrador. Algunos campos pueden requerirlos." }
}
Escribir ""
Escribir "---"
Escribir ""
Escribir "Este reporte no contiene contrasenas, tokens ni credenciales. Las IPs de LAN son parte del inventario."

# UTF8 con BOM para que el markdown se lea bien en cualquier editor de Windows.
$lineas -join "`r`n" | Out-File -FilePath $salida -Encoding utf8
Write-Host ""
Write-Host "==========================================================="
Write-Host "Inventario guardado en:"
Write-Host "  $salida"
Write-Host "==========================================================="
