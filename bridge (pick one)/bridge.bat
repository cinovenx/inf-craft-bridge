@echo off
REM ===========================================================================
REM  Infinite Craft Bridge by cinovenx
REM  https://github.com/cinovenx/inf-craft-bridge
REM
REM  This is the bridge only. For a guided tour run demo.bat instead.
REM
REM  Usage:
REM      bridge.bat                 start the bridge on port 4242
REM      bridge.bat 8080            start the bridge on port 8080
REM
REM  The PowerShell host lives in bridge.ps1 - keep both files together.
REM ===========================================================================
setlocal
set "BRIDGE_PS1=%~dp0bridge.ps1"
if not exist "%BRIDGE_PS1%" (
    echo.
    echo   bridge.ps1 is missing next to bridge.bat.
    echo   Keep bridge.bat and bridge.ps1 in the same folder.
    echo.
    pause
    exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%BRIDGE_PS1%" %*
exit /b %ERRORLEVEL%
