@echo off
rem Starts ShotReady from this folder (the source code). Double-click it, or run it from a
rem command prompt. Anything after the name goes to ShotReady: start-windows.bat --demo
rem The first time, it installs ShotReady's packages and Electron, which needs the internet.
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto nonode

if exist "node_modules\electron\dist\electron.exe" goto run
echo First start: installing ShotReady's packages. This takes a minute or two.
call npm ci --ignore-scripts
if errorlevel 1 goto failed
call node node_modules\electron\install.js
if errorlevel 1 goto failed
if not exist "node_modules\electron\dist\electron.exe" goto failed

:run
rem Started on its own, so this window can close while ShotReady keeps running.
start "" "node_modules\electron\dist\electron.exe" . %*
exit /b 0

:nonode
echo ShotReady needs Node.js to run from the source code.
echo Install the LTS version from https://nodejs.org, then run this again.
pause
exit /b 1

:failed
echo Installing the packages did not work. Check the internet connection and run this again.
pause
exit /b 1
