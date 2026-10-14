@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM One-command local notification setup (Windows).
REM Run from the backend repo (propmv\):
REM   scripts\setup-notification-local.bat

set "SCRIPT_DIR=%~dp0"
set "BACKEND_DIR=%SCRIPT_DIR%.."

set "NOTIF_DIR="
if exist "%BACKEND_DIR%\..\notification-service\package.json" (
  set "NOTIF_DIR=%BACKEND_DIR%\..\notification-service"
) else if exist "%BACKEND_DIR%\..\propmv-notification-service\package.json" (
  set "NOTIF_DIR=%BACKEND_DIR%\..\propmv-notification-service"
) else if exist "%BACKEND_DIR%\notification-service\package.json" (
  set "NOTIF_DIR=%BACKEND_DIR%\notification-service"
)

set "START_RABBIT=1"
set "START_SERVICE=0"
if /I "%~1"=="--start" set "START_SERVICE=1"

cd /d "%BACKEND_DIR%"

echo.
echo === PropMv local notification setup (Windows) ===
echo.

if not exist "%BACKEND_DIR%\package.json" (
  echo [ERROR] propmv backend not found at %BACKEND_DIR%
  exit /b 1
)
if "%NOTIF_DIR%"=="" (
  echo [ERROR] notification-service not found next to propmv ^(expected ..\notification-service^)
  exit /b 1
)

call "%SCRIPT_DIR%setup-local-infra.bat" --with-rabbitmq
if errorlevel 1 exit /b 1

echo Syncing notification env from backend...
node "%SCRIPT_DIR%sync-notification-env.js"
if errorlevel 1 (
  echo [WARN] Env sync had issues - check notification-service\.env manually
)

echo Installing notification-service dependencies...
cd /d "%NOTIF_DIR%"
call npm ci
if errorlevel 1 (
  echo [ERROR] npm ci failed in notification-service
  exit /b 1
)

echo.
echo [OK] Setup complete.
echo.
echo   Backend dir      : %BACKEND_DIR%
echo   Notification env : %NOTIF_DIR%\.env
echo   Redis            : redis://127.0.0.1:6379
echo   RabbitMQ         : amqp://guest:guest@127.0.0.1:5672
echo.
echo Start the backend (terminal 1):  cd %BACKEND_DIR% ^&^& npm run dev
echo.

if "%START_SERVICE%"=="1" (
  echo Starting notification service on port 3000...
  call npm run dev
) else (
  echo Start the notification service (terminal 2):  cd %NOTIF_DIR% ^&^& npm run dev
)

echo.
exit /b 0
