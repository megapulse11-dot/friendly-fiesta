@echo off
REM Starts the Northwind Realty website and editing panel.
REM Change the password by editing the line below, or run:
REM   set NW_ADMIN_PASSWORD=your-password
REM   powershell -ExecutionPolicy Bypass -File admin\server.ps1
REM -Password takes a SecureString, so the password travels in the
REM NW_ADMIN_PASSWORD environment variable instead of on the command line.

set NW_PORT=8001
if "%~1"=="" goto run
set NW_ADMIN_PASSWORD=%~1
set NW_PASSWORD=%~1
goto launch

:run
set NW_PASSWORD=northwind

:launch
echo.
echo   Northwind Realty - website and admin
echo   Website : http://localhost:%NW_PORT%/
echo   Admin   : http://localhost:%NW_PORT%/admin
echo   Password: %NW_PASSWORD%
echo   Press Ctrl+C to stop
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0admin\server.ps1" -Port %NW_PORT%
