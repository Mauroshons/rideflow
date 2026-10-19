@echo off
REM Espera a que el servidor esté escuchando y abre la app.
REM Vive en su propio archivo para no tener que anidar comillas dentro de
REM un cmd /c, que en Windows es la via rapida a un script que no funciona.
REM
REM   open-browser.cmd <url> [ruta-del-navegador]

setlocal
set URL=%~1
set BROWSER=%~2

timeout /t 2 /nobreak >nul

if "%BROWSER%"=="" (
  start "" "%URL%"
) else (
  REM --app: ventana sin barra de direcciones, parecida a la app instalada.
  start "" "%BROWSER%" --app=%URL%
)
