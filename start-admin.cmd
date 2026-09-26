@echo off
REM Starts the Northwind Realty website and editing panel.
REM
REM The server has no default password and will not start without one, so pass
REM it in or type it when asked:
REM   start-admin.cmd your-password
REM
REM The password is read with Read-Host -AsSecureString, so it is not echoed to
REM the screen, and travels in NW_ADMIN_PASSWORD rather than on the command line
REM (-Password takes a SecureString).

set NW_PORT=8001
if not "%~1"=="" goto given

REM No argument: prompt without echoing.
for /f "delims=" %%p in ('powershell -NoProfile -Command "$s=Read-Host 'Admin password' -AsSecureString; $b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s); [Runtime.InteropServices.Marshal]::PtrToStringBSTR($b)"') do set "NW_ADMIN_PASSWORD=%%p"
if not defined NW_ADMIN_PASSWORD goto nopassword
goto launch

:given
set "NW_ADMIN_PASSWORD=%~1"
goto launch

:nopassword
echo.
echo   No password entered, so nothing will start.
echo   Run:  start-admin.cmd your-password
echo.
pause
exit /b 1

:launch
echo.
echo   Northwind Realty - website and admin
echo   Website : http://localhost:%NW_PORT%/
echo   Admin   : http://localhost:%NW_PORT%/admin
echo   Password: supplied (not shown)
echo   Press Ctrl+C to stop
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0admin\server.ps1" -Port %NW_PORT%
