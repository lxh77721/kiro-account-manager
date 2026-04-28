@echo off
setlocal

set "DATA_DIR=%~1"
set "WEB_PORT=%~2"
set "PROXY_PORT=%~3"
set "LOG_FILE=%~4"

if "%DATA_DIR%"=="" exit /b 2
if "%WEB_PORT%"=="" set "WEB_PORT=3180"
if "%PROXY_PORT%"=="" set "PROXY_PORT=5680"
if "%LOG_FILE%"=="" set "LOG_FILE=%DATA_DIR%\web-proxy.console.log"

set "KIRO_USER_DATA_PATH=%DATA_DIR%"
set "KIRO_WEB_HOST=127.0.0.1"
set "KIRO_WEB_PORT=%WEB_PORT%"
set "KIRO_PROXY_HOST=127.0.0.1"
set "KIRO_PROXY_PORT=%PROXY_PORT%"

cd /d G:\project\kiro-account-manager
node out\web-proxy\web-proxy\server.js > "%LOG_FILE%" 2>&1
