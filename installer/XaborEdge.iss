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

// El canje y la instalacion del servicio, en el orden que importa.
procedure CurStepChanged(PasoActual: TSetupStep);
var
  Codigo: Integer;
  Comando: String;
begin
  if PasoActual <> ssPostInstall then Exit;

  // 1. Canjear. Se le pasa el codigo por argumento porque es de un solo uso y
  //    caduca en minutos; el TOKEN, en cambio, nunca viaja por linea de
  //    comandos: lo escribe canjear.mjs directamente en config.json.
  Comando := '"' + ExpandConstant('{app}\app\canjear.mjs') + '"' +
             ' --codigo "' + Trim(PaginaVinculo.Values[0]) + '"' +
             ' --nombre "' + Trim(PaginaVinculo.Values[1]) + '"';

  if not Exec(ExpandConstant('{app}\node\node.exe'), Comando,
              ExpandConstant('{app}\app'), SW_HIDE, ewWaitUntilTerminated, Codigo) then
  begin
    MsgBox('No se pudo ejecutar el paso de conexion con Xabor.', mbCriticalError, MB_OK);
    Abort;
  end;

  if Codigo <> 0 then
  begin
    case Codigo of
      2: MsgBox('El codigo de conexion no es valido o ya vencio.' #13#13 'Genera uno nuevo en Xabor (Config -> Impresoras -> Conectar equipo) y vuelve a ejecutar el instalador.', mbCriticalError, MB_OK);
      3: MsgBox('Este equipo no pudo contactar con Xabor.' #13#13 'Revisa la conexion a internet y vuelve a intentarlo.', mbCriticalError, MB_OK);
      4: MsgBox('No se pudo guardar la configuracion.' #13#13 'Ejecuta el instalador como administrador.', mbCriticalError, MB_OK);
    else
      MsgBox('No se pudo conectar este equipo con Xabor.', mbCriticalError, MB_OK);
    end;
    // Abort revierte la instalacion completa. NO queda servicio instalado.
    Abort;
  end;

  // 2. Solo ahora, con el equipo ya vinculado, se registra el servicio.
  if not Exec(ExpandConstant('{app}\XaborEdgeService.exe'), 'install',
              ExpandConstant('{app}'), SW_HIDE, ewWaitUntilTerminated, Codigo) or (Codigo <> 0) then
  begin
    MsgBox('El equipo quedo vinculado, pero no se pudo instalar el servicio de Windows.', mbCriticalError, MB_OK);
    Abort;
  end;

  // 3. Y se arranca. Si esto falla, el servicio queda instalado y en
  //    automatico: arrancara solo en el proximo reinicio, asi que no se
  //    aborta la instalacion por esto.
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
