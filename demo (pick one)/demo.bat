@echo off
REM ===========================================================================
REM  Infinite Craft Bridge by cinovenx - interactive demo
REM  https://github.com/cinovenx/inf-craft-bridge
REM
REM  Starts the bridge as a separate process, then lets you craft:
REM  you type the first element, then the second one, you get the result,
REM  and it asks again. Type 'q' at any prompt to quit.
REM
REM  Usage:
REM      demo.bat                 port 4242
REM      demo.bat 8080            another port
REM
REM  The PowerShell host lives in demo.ps1 - keep both files together.
REM ===========================================================================
setlocal
set "DEMO_PS1=%~dp0demo.ps1"
if not exist "%DEMO_PS1%" (
    echo.
    echo   demo.ps1 is missing next to demo.bat.
    echo   Keep demo.bat and demo.ps1 in the same folder.
    echo.
    pause
    exit /b 1
)
powershell -NoProfile -ExecutionPolicy Bypass -File "%DEMO_PS1%" %*
exit /b %ERRORLEVEL%
