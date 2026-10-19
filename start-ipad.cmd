@echo off
REM Levanta las tres piezas que hacen falta para rodar con el iPad:
REM
REM   1. el servidor web, que sirve la app al iPad por http
REM   2. el relevo, que pasa mensajes entre el iPad y este PC
REM   3. la pagina proveedora en Chrome, que pone el Bluetooth
REM
REM Por que http y no la URL de GitHub Pages: desde una pagina https el
REM navegador bloquea el WebSocket ws:// del relevo por contenido mixto, asi
REM que el iPad tiene que cargar la app desde este mismo equipo.

setlocal
cd /d "%~dp0"

set PORT=8080
set BRIDGE=8787

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo No encuentro Node.js en el PATH. Instalalo desde https://nodejs.org
  echo.
  pause
  exit /b 1
)

set BROWSER=
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%P set BROWSER=%%~P

if not defined BROWSER (
  echo.
  echo No encontre Chrome ni Edge. El proveedor NECESITA uno de los dos:
  echo es la pieza que habla Bluetooth, y Firefox no implementa Web Bluetooth.
  echo.
  pause
  exit /b 1
)

echo.
echo   RideFlow para iPad
echo   ------------------
echo.
echo   Levantando el relevo en el puerto %BRIDGE% y el servidor en el %PORT%.
echo   Se abrira la pagina del proveedor en el navegador: ahi veras que
echo   direccion tiene que abrir el iPad y podras conectar el rodillo.
echo.
echo   Cerra esta ventana para parar las tres piezas.
echo.

REM El relevo va en su propia ventana para poder ver su registro.
start "RideFlow relevo" /min cmd /c "node tools\bridge-server.mjs --port %BRIDGE% --backend relay"

start "" /min "%~dp0tools\open-browser.cmd" "http://localhost:%PORT%/provider.html" "%BROWSER%"

node tools\serve.mjs %PORT%
