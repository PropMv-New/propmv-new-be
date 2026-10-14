@echo off
setlocal EnableExtensions EnableDelayedExpansion

REM PropMv local infrastructure: Redis + optional RabbitMQ
REM Run from propmv\:
REM   scripts\setup-local-infra.bat
REM   scripts\setup-local-infra.bat --with-rabbitmq

set "SCRIPT_DIR=%~dp0"
set "BACKEND_DIR=%SCRIPT_DIR%.."
cd /d "%BACKEND_DIR%"

set "START_RABBIT=0"
if /I "%~1"=="--with-rabbitmq" set "START_RABBIT=1"
if /I "%~1"=="rabbitmq" set "START_RABBIT=1"

echo.
echo === PropMv local infra setup (Windows) ===
echo.

where docker >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker is not installed or not on PATH.
  echo Install Docker Desktop: https://docs.docker.com/desktop/setup/install/windows-install/
  exit /b 1
)

docker info >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Docker is installed but the engine is not running.
  echo Start Docker Desktop and wait until it is ready, then re-run this script.
  exit /b 1
)

echo Starting Redis on 127.0.0.1:6379 ...
docker inspect propmv-redis >nul 2>&1
if errorlevel 1 (
  docker run -d --name propmv-redis --restart unless-stopped -p 6379:6379 redis:7-alpine >nul
  if errorlevel 1 (
    echo [ERROR] Failed to start Redis container.
    exit /b 1
  )
) else (
  docker start propmv-redis >nul
)

set "REDIS_OK=0"
for /L %%I in (1,1,20) do (
  docker exec propmv-redis redis-cli ping 2>nul | findstr /I "PONG" >nul
  if not errorlevel 1 (
    set "REDIS_OK=1"
    goto :redis_ready
  )
  timeout /t 1 /nobreak >nul
)
:redis_ready
if "%REDIS_OK%"=="0" (
  echo [ERROR] Redis started but did not become ready.
  exit /b 1
)
echo [OK] Redis is ready at redis://127.0.0.1:6379

if "%START_RABBIT%"=="1" (
  echo Starting RabbitMQ on 127.0.0.1:5672 ...
  docker inspect propmv-rabbitmq >nul 2>&1
  if errorlevel 1 (
    docker run -d --name propmv-rabbitmq --restart unless-stopped -p 5672:5672 -p 15672:15672 -e RABBITMQ_DEFAULT_USER=guest -e RABBITMQ_DEFAULT_PASS=guest rabbitmq:3-management-alpine >nul
  ) else (
    docker start propmv-rabbitmq >nul
  )
  echo [OK] RabbitMQ container started ^(management UI http://127.0.0.1:15672^)
) else (
  echo Skipping RabbitMQ. The notification service can run without it.
  echo To also start RabbitMQ: scripts\setup-local-infra.bat --with-rabbitmq
)

echo.
echo Set REDIS_URL=redis://127.0.0.1:6379 in .env.local and notification-service\.env
echo.
exit /b 0
