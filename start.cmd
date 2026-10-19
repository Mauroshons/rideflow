@echo off
REM Arranca RideFlow en este PC y lo abre en Chrome o Edge.
REM
REM Se sirve desde localhost a proposito: Web Bluetooth y la instalacion de
REM la PWA exigen un origen seguro, y localhost cuenta como tal aunque sea
REM http. Una IP de red local, no.

setlocal
cd /d "%~dp0"

set PORT=8080
if not "%~1"=="" set PORT=%~1

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo No encuentro Node.js en el PATH. Instalalo desde https://nodejs.org
  echo.
  pause
  exit /b 1
)

set URL=http://localhost:%PORT%/index.html

REM %%~P quita las comillas: asi la variable guarda la ruta pelada y las
REM comillas se ponen solo donde hacen falta.
set BROWSER=
for %%P in (
  "%ProgramFiles%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
  "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe"
  "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe"
) do if not defined BROWSER if exist %%P set BROWSER=%%~P

echo.
echo   RideFlow  ·  %URL%
echo.
echo   Rodillo: Ajustes -^> Rodillo -^> "Rodillo Bluetooth (FTMS)". Si no
echo   aparece el Tacx, probar "Tacx FE-C". Encende el rodillo y pedalea un
echo   par de segundos ANTES de darle a Conectar.
echo.

if defined BROWSER (
  echo   Navegador: %BROWSER%
) else (
  echo   No encontre Chrome ni Edge. Firefox y Safari no implementan Web
  echo   Bluetooth, asi que desde ahi el rodillo no va a conectar.
)

echo.
echo   Cerra esta ventana para parar el servidor.
echo.

REM El navegador lo abre un proceso aparte que espera a que el puerto este
REM levantado; el servidor se queda en primer plano para que cerrar la
REM ventana lo pare.
start "" /min "%~dp0tools\open-browser.cmd" "%URL%" "%BROWSER%"

node tools\serve.mjs %PORT%
