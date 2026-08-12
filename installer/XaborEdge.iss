; Instalador de Xabor Edge para Windows -- Inno Setup 6.
;
; La experiencia que tiene que dar, completa:
;
;   doble clic -> UAC -> escribir el codigo que da Xabor -> Instalar -> listo
;
; Sin PowerShell, sin instalar Node, sin editar archivos. Cuando termina, el
; servicio ya esta corriendo y el equipo aparece conectado en el panel.
;
; El emparejamiento ocurre DENTRO del instalador, en una pagina propia, y no
; en una segunda aplicacion: una tecnologia menos que mantener y una ventana
; menos que explicar por telefono.
;
; Orden deliberado: primero se canjea el codigo, y SOLO si el canje funciona
; se instala y arranca el servicio. Si el codigo esta vencido, el instalador
; aborta y no deja un servicio hablando con nadie.
;
; ─── Que hace falta para compilar ──────────────────────────────────────────
;
; Este script NO asume rutas de desarrollo. Todo lo que depende de la maquina
; de build se pasa por linea de comandos:
;
;   ISCC.exe XaborEdge.iss ^
;     /DAppVersion=1.0.0 ^
;     /DOrigenApp="C:\ruta\al\repo" ^
;     /DOrigenNode="C:\ruta\a\node-vXX-win-x64" ^
;     /DOrigenWinSW="C:\ruta\a\WinSW-x64.exe" ^
;     /DSalida="C:\ruta\de\salida"
;
; Sin esos parametros el script no compila, a proposito: es preferible un
; error claro a un instalador construido con la carpeta equivocada.

#ifndef AppVersion
  #error Falta /DAppVersion (ej: /DAppVersion=1.0.0)
#endif
#ifndef OrigenApp
  #error Falta /DOrigenApp: carpeta del repo de donde se copian edge/ y node_modules/
#endif
#ifndef OrigenNode
  #error Falta /DOrigenNode: carpeta del runtime de Node a empaquetar (debe contener node.exe)
#endif
#ifndef OrigenWinSW
  #error Falta /DOrigenWinSW: ruta al ejecutable de WinSW
#endif
#ifndef Salida
  #define Salida "."
#endif
; A que Xabor se conecta este instalador. Por defecto el de verdad; se puede
; apuntar a otro para PROBAR el canje sin tocar produccion, que es la unica
; forma de validar una instalacion completa de punta a punta.
;   /DUrlXabor=http://192.168.1.50:4300
#ifndef UrlXabor
  #define UrlXabor "https://xabor.mx"
#endif

#define AppName "Xabor Edge"
#define Publisher "Xabor"
#define ServicioId "XaborEdge"
#define DirDatos "{commonappdata}\Xabor\Edge"

[Setup]
AppId={{8F3C6A11-2C7E-4C6D-9E2B-7A1D5B0E4C22}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher={#Publisher}
DefaultDirName={autopf}\Xabor\Edge
DefaultGroupName=Xabor
DisableProgramGroupPage=yes
DisableDirPage=yes
OutputDir={#Salida}
OutputBaseFilename=XaborEdgeSetup
Compression=lzma2/max
SolidCompression=yes
; El servicio se instala a nivel de maquina y escribe en ProgramData: hace
; falta elevacion. Windows pedira UAC al abrir el instalador.
PrivilegesRequired=admin
ArchitecturesInstallIn64BitMode=x64compatible
ArchitecturesAllowed=x64compatible
WizardStyle=modern
; Sin firma digital todavia: SmartScreen avisara. Es aceptable para el piloto
; interno y esta documentado en el reporte de entrega.

[Languages]
Name: "es"; MessagesFile: "compiler:Languages\Spanish.isl"

[Files]
; El agente. Se excluye todo lo que no hace falta en el equipo del cliente:
; pruebas, datos de desarrollo y el .env local (que podria traer credenciales
; de otra instalacion).
Source: "{#OrigenApp}\edge\*"; DestDir: "{app}\app\edge"; Flags: recursesubdirs ignoreversion; \
  Excludes: "datos\*,.env,*.log"
; SOLO ws. Es la unica dependencia externa del agente -- comprobado sobre los
; imports de edge/ completo -- y no tiene dependencias propias. Copiar
; node_modules entero meteria cientos de megas del servidor Cloud en la caja de
; un restaurante, incluyendo cosas que ahi no pintan nada.
Source: "{#OrigenApp}\node_modules\ws\*"; DestDir: "{app}\app\node_modules\ws"; Flags: recursesubdirs ignoreversion
Source: "{#OrigenApp}\package.json"; DestDir: "{app}\app"; Flags: ignoreversion

; Runtime privado de Node. El equipo del restaurante no tiene Node y no debe
; necesitarlo; si algun dia lo instalan, esto no se entera.
; SOLO node.exe. El zip oficial de Node trae ademas npm entero, corepack y sus
; dependencias: unos 100 MB que en el equipo de un restaurante no se van a usar
; jamas -- el agente no instala paquetes, ya viene con lo suyo. node.exe es
; autocontenido.
Source: "{#OrigenNode}\node.exe"; DestDir: "{app}\node"; Flags: ignoreversion

; El wrapper del servicio y su configuracion. El .exe y el .xml tienen que
; llamarse igual: asi es como WinSW encuentra su configuracion.
Source: "{#OrigenWinSW}"; DestDir: "{app}"; DestName: "XaborEdgeService.exe"; Flags: ignoreversion
Source: "XaborEdgeService.xml"; DestDir: "{app}"; Flags: ignoreversion

; El canje del emparejamiento, que corre durante la instalacion.
Source: "canjear.mjs"; DestDir: "{app}\app"; Flags: ignoreversion

; Y las MISMAS dos piezas, extraibles a temporal. El canje ocurre en
; PrepareToInstall, antes de copiar un solo archivo al disco, asi que ahi
; todavia no existe ni {app}\node\node.exe ni {app}\app\canjear.mjs. Con
; dontcopy quedan dentro del Setup sin instalarse, disponibles para
; ExtractTemporaryFile, y Windows limpia {tmp} al terminar.
Source: "{#OrigenNode}\node.exe"; Flags: dontcopy noencryption
Source: "canjear.mjs"; Flags: dontcopy noencryption

[Dirs]
; Los datos viven fuera de {app} para sobrevivir a una reinstalacion. La cola
; SQLite en particular puede tener comandas sin imprimir.
Name: "{#DirDatos}"
Name: "{#DirDatos}\config"
Name: "{#DirDatos}\data"
Name: "{#DirDatos}\logs"

[Icons]
Name: "{group}\Ver registros de Xabor Edge"; Filename: "{#DirDatos}\logs"

[Run]
; Nada aqui: la instalacion del servicio se hace en CurStepChanged, para poder
; abortar si el canje falla ANTES de dejar un servicio instalado.

[UninstallRun]
; Detener y desregistrar el servicio antes de borrar los binarios. Sin esto,
; Windows deja un servicio fantasma apuntando a archivos que ya no existen.
Filename: "{app}\XaborEdgeService.exe"; Parameters: "stop"; Flags: runhidden waituntilterminated; RunOnceId: "DetenerXaborEdge"
Filename: "{app}\XaborEdgeService.exe"; Parameters: "uninstall"; Flags: runhidden waituntilterminated; RunOnceId: "DesinstalarXaborEdge"

[Code]
var
  PaginaVinculo: TInputQueryWizardPage;

procedure InitializeWizard;
begin
  PaginaVinculo := CreateInputQueryPage(wpWelcome,
    'Conectar con Xabor',
    'Vincula este equipo con tu restaurante',
#if UrlXabor == "https://xabor.mx"
    'Entra a Xabor, ve a Config -> Impresoras -> Conectar equipo y escribe aqui el codigo que aparece en pantalla. El codigo vence a los pocos minutos.');
#else
    'ATENCION: compilacion de PRUEBA. Se conectara a {#UrlXabor}, no a Xabor. No usar en un restaurante.');
#endif
  PaginaVinculo.Add('Codigo de conexion:', False);
  PaginaVinculo.Add('Nombre de este equipo (opcional):', False);
  PaginaVinculo.Values[1] := 'Caja principal';
end;

// Un equipo YA vinculado A ESTE MISMO XABOR no tiene por que pedir nada.
//
// Reinstalar para reparar el servicio es un caso normal, y el codigo de
// emparejamiento es de un solo uso: exigirlo obligaria a generar uno nuevo en
// Xabor por un problema que no tiene nada que ver con el emparejamiento.
//
// Pero la existencia del archivo NO basta. En Acuna, el Setup de produccion
// encontro la config de una instalacion de PRUEBA (ws://localhost:4300), se
// salto el emparejamiento y termino "correctamente" con un servicio hablando
// con nadie. Antes de saltar la pagina hay que comprobar que la config apunte
// a la MISMA URL con la que se compilo este instalador. La decision final de
// conservar o re-emparejar vive en canjear.mjs (que si sabe leer JSON); esta
// comprobacion solo decide si se muestra la pagina del codigo.
function UrlNubeEsperada: String;
var
  U: String;
begin
  U := '{#UrlXabor}';
  StringChangeEx(U, 'https://', 'wss://', True);
  StringChangeEx(U, 'http://', 'ws://', True);
  Result := U;
end;

function ConfigDelMismoEntorno: Boolean;
var
  Contenido: AnsiString;
begin
  Result := False;
  if not FileExists(ExpandConstant('{#DirDatos}\config\config.json')) then Exit;
  // Si no se puede leer, NO se asume mismo entorno: se muestra la pagina y
  // canjear.mjs -- que distingue "protegida" de "ausente" -- tiene la ultima
  // palabra. Un codigo tecleado de mas no se gasta: el canje conserva la
  // config del mismo entorno ANTES de llamar a Xabor.
  if not LoadStringFromFile(ExpandConstant('{#DirDatos}\config\config.json'), Contenido) then Exit;
  Result := Pos(UrlNubeEsperada, String(Contenido)) > 0;
end;

function ShouldSkipPage(PaginaActual: Integer): Boolean;
begin
  Result := (PaginaActual = PaginaVinculo.ID) and ConfigDelMismoEntorno;
end;

function NextButtonClick(PaginaActual: Integer): Boolean;
begin
  Result := True;
  if (PaginaActual = PaginaVinculo.ID) and (not ConfigDelMismoEntorno) then
  begin
    if Trim(PaginaVinculo.Values[0]) = '' then
    begin
      MsgBox('Escribe el codigo de conexion que te dio Xabor.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

// ─── El canje, ANTES de tocar el disco ──────────────────────────────────────
//
// Estaba en ssPostInstall, que se ejecuta DESPUES de copiar los archivos. Un
// Abort ahi no deshace la copia: Inno solo revierte si el fallo ocurre
// durante la instalacion de archivos, no despues. Un codigo vencido habria
// dejado 107 MB en Archivos de programa, una entrada en Agregar o quitar
// programas y ningun servicio -- una instalacion muerta que el restaurante no
// sabe que tiene.
//
// PrepareToInstall corre ANTES de esa fase. Si devuelve un texto, Inno
// cancela y no ha escrito nada todavia: no hay residuos que limpiar porque
// nunca se creo ninguno. El runtime y el script se sacan a la carpeta
// temporal del instalador, que Windows borra sola.
function PrepareToInstall(var NecesitaReinicio: Boolean): String;
var
  Codigo: Integer;
  Comando: String;
begin
  Result := '';

  // El canje corre SIEMPRE: canjear.mjs es el unico que decide si la config
  // existente se conserva (mismo Xabor: sale 0 sin gastar codigo) o si hace
  // falta re-emparejar (otro entorno: canjea con el codigo tecleado). Antes
  // habia aqui un atajo -- "si existe config.json, no canjear" -- que fue
  // exactamente el agujero por el que un Setup de produccion reutilizo una
  // config de prueba apuntando a localhost.
  ExtractTemporaryFile('node.exe');
  ExtractTemporaryFile('canjear.mjs');

  Comando := '"' + ExpandConstant('{tmp}\canjear.mjs') + '"' +
             ' --codigo "' + Trim(PaginaVinculo.Values[0]) + '"' +
             ' --nombre "' + Trim(PaginaVinculo.Values[1]) + '"' +
             ' --url "{#UrlXabor}"';

  if not Exec(ExpandConstant('{tmp}\node.exe'), Comando,
              ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Codigo) then
  begin
    Result := 'No se pudo ejecutar el paso de conexion con Xabor.';
    Exit;
  end;

  case Codigo of
    0: Result := '';   // vinculado (o ya lo estaba, al mismo Xabor): se puede instalar
    2: Result := 'El codigo de conexion no es valido o ya vencio.' #13#13 'Genera uno nuevo en Xabor (Config -> Impresoras -> Conectar equipo) y vuelve a ejecutar el instalador.';
    3: Result := 'Este equipo no pudo contactar con Xabor.' #13#13 'Revisa la conexion a internet y vuelve a intentarlo.';
    4: Result := 'No se pudo guardar la configuracion.' #13#13 'Ejecuta el instalador como administrador.';
    // 5 llega si la config de este equipo apunta a OTRO Xabor y no se
    // escribio ningun codigo (la pagina no debio saltarse, pero es la red de
    // seguridad si ambas comprobaciones divergen).
    5: Result := 'La configuracion de este equipo pertenece a otra instalacion de Xabor.' #13#13 'Genera un codigo de conexion en Xabor (Config -> Impresoras -> Conectar equipo) y vuelve a ejecutar el instalador.';
    6: Result := 'La configuracion existente esta protegida y no se pudo leer.' #13#13 'Ejecuta el instalador como administrador.';
  else
    Result := 'No se pudo conectar este equipo con Xabor.';
  end;
end;

// El servicio, ya con los archivos en su sitio y el equipo vinculado.
procedure CurStepChanged(PasoActual: TSetupStep);
var
  Codigo: Integer;
begin
  if PasoActual <> ssPostInstall then Exit;

  // Si el servicio no se puede registrar, el equipo YA quedo vinculado y el
  // codigo de emparejamiento ya se consumio: es de un solo uso y no se puede
  // volver a escribir. Por eso este mensaje dice lo unico que le importa a
  // quien esta delante -- que NO necesita pedir otro codigo.
  //
  // La config se conserva a proposito. canjear.mjs detecta que ya existe y
  // sale con 0 sin volver a canjear, asi que ejecutar el instalador otra vez
  // repara la instalacion sin tocar la vinculacion. Borrarla aqui obligaria a
  // generar un codigo nuevo por un fallo que no tiene nada que ver con el
  // emparejamiento.
  if not Exec(ExpandConstant('{app}\XaborEdgeService.exe'), 'install',
              ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Codigo) or (Codigo <> 0) then
  begin
    MsgBox('Este equipo quedo vinculado con Xabor, pero no se pudo instalar el servicio de Windows.' #13#13
           'Vuelve a ejecutar el instalador como administrador: NO hace falta un codigo nuevo, la vinculacion se conserva.',
           mbCriticalError, MB_OK);
    Abort;
  end;

  // Si arrancar falla, el servicio ya quedo registrado y en automatico:
  // arrancara solo en el proximo reinicio. No se aborta por esto.
  if not Exec(ExpandConstant('{app}\XaborEdgeService.exe'), 'start',
              ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Codigo) or (Codigo <> 0) then
    MsgBox('Xabor Edge se instalo pero no arranco todavia. Se iniciara solo al reiniciar el equipo.', mbInformation, MB_OK);
end;

// Al desinstalar: los binarios se van, los datos NO se borran solos.
//
// En la cola SQLite puede haber comandas sin imprimir, y las credenciales
// permiten reinstalar sin pedir un codigo nuevo. Borrarlas en silencio seria
// destruir informacion que el restaurante no sabe que existe. Se pregunta.
procedure CurUninstallStepChanged(PasoActual: TUninstallStep);
var
  Botones: array of String;
begin
  if PasoActual <> usPostUninstall then Exit;
  // Botones con texto propio y el seguro por defecto.
  //
  // Antes eran los Si/No de Windows, con el foco en 'Si'. Justo antes de este
  // cuadro, Inno muestra el suyo -- 'Esta seguro de que desea quitar Xabor
  // Edge?' -- tambien Si/No, y hay que decir Si para llegar hasta aqui. Dos
  // cuadros identicos seguidos que significan cosas distintas: quien acaba de
  // confirmar la desinstalacion vuelve a pulsar Si por inercia y se lleva por
  // delante la vinculacion y las comandas sin imprimir. Paso de verdad.
  //
  // Ahora los botones dicen que hacen, y el predeterminado conserva.
  // El array va en una variable y no en linea: Inno lee un '[' a principio de
  // linea como el comienzo de una seccion y aborta la compilacion.
  SetArrayLength(Botones, 2);
  Botones[0] := 'Conservar datos (recomendado)';
  Botones[1] := 'Borrar todo, incluida la vinculacion';
  if TaskDialogMsgBox('Conservar la configuracion de este equipo?',
        'Xabor Edge ya se quito. La vinculacion con el restaurante y las comandas pendientes siguen guardadas.',
        mbConfirmation, MB_YESNO, Botones, IDYES) = IDNO then
    DelTree(ExpandConstant('{#DirDatos}'), True, True, True);
end;
