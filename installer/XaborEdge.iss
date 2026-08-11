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
Source: "{#OrigenApp}\node_modules\*"; DestDir: "{app}\app\node_modules"; Flags: recursesubdirs ignoreversion
Source: "{#OrigenApp}\package.json"; DestDir: "{app}\app"; Flags: ignoreversion

; Runtime privado de Node. El equipo del restaurante no tiene Node y no debe
; necesitarlo; si algun dia lo instalan, esto no se entera.
Source: "{#OrigenNode}\*"; DestDir: "{app}\node"; Flags: recursesubdirs ignoreversion

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
    'Entra a Xabor, ve a Config -> Impresoras -> Conectar equipo y escribe aqui el codigo que aparece en pantalla. El codigo vence a los pocos minutos.');
  PaginaVinculo.Add('Codigo de conexion:', False);
  PaginaVinculo.Add('Nombre de este equipo (opcional):', False);
  PaginaVinculo.Values[1] := 'Caja principal';
end;

function NextButtonClick(PaginaActual: Integer): Boolean;
begin
  Result := True;
  if PaginaActual = PaginaVinculo.ID then
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
  ExtractTemporaryFile('node.exe');
  ExtractTemporaryFile('canjear.mjs');

  Comando := '"' + ExpandConstant('{tmp}\canjear.mjs') + '"' +
             ' --codigo "' + Trim(PaginaVinculo.Values[0]) + '"' +
             ' --nombre "' + Trim(PaginaVinculo.Values[1]) + '"';

  if not Exec(ExpandConstant('{tmp}\node.exe'), Comando,
              ExpandConstant('{tmp}'), SW_HIDE, ewWaitUntilTerminated, Codigo) then
  begin
    Result := 'No se pudo ejecutar el paso de conexion con Xabor.';
    Exit;
  end;

  case Codigo of
    0: Result := '';   // vinculado (o ya lo estaba): se puede instalar
    2: Result := 'El codigo de conexion no es valido o ya vencio.' #13#13 'Genera uno nuevo en Xabor (Config -> Impresoras -> Conectar equipo) y vuelve a ejecutar el instalador.';
    3: Result := 'Este equipo no pudo contactar con Xabor.' #13#13 'Revisa la conexion a internet y vuelve a intentarlo.';
    4: Result := 'No se pudo guardar la configuracion.' #13#13 'Ejecuta el instalador como administrador.';
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

  if not Exec(ExpandConstant('{app}\XaborEdgeService.exe'), 'install',
              ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Codigo) or (Codigo <> 0) then
  begin
    MsgBox('El equipo quedo vinculado, pero no se pudo instalar el servicio de Windows.', mbCriticalError, MB_OK);
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
begin
  if PasoActual <> usPostUninstall then Exit;
  if MsgBox('Se quito Xabor Edge de este equipo.' #13#13
            'Quieres borrar tambien sus datos (cola de impresion pendiente, credenciales y registros)?' #13#13
            'Si respondes que NO, al reinstalar este equipo seguira vinculado y no hara falta un codigo nuevo.',
            mbConfirmation, MB_YESNO) = IDYES then
    DelTree(ExpandConstant('{#DirDatos}'), True, True, True);
end;
