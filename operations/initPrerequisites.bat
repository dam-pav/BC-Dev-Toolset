@echo off
setlocal enabledelayedexpansion

rem Resolve script folder and PowerShell script path
set "SCRIPT_DIR=%~dp0"
set "PS_SCRIPT=%SCRIPT_DIR%initPrerequisites.ps1"

rem Choose PowerShell executable: prefer pwsh if available
where pwsh >nul 2>&1
if %errorlevel%==0 (
    set "PS_EXE=pwsh"
) else (
    where powershell.exe >nul 2>&1
    if %errorlevel%==0 (
        set "PS_EXE=powershell.exe"
    ) else (
        echo Error: No PowerShell executable found in PATH.
        exit /b 1
    )
)

rem If not running as administrator, relaunch this batch file elevated
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting administrator privileges...
    set "ARGS=%*"
    if "%ARGS%"=="" (
        powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
    ) else (
        powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%ARGS%' -Verb RunAs"
    )
    exit /b
)

echo Running initPrerequisites.ps1 with bypassed execution policy...
"%PS_EXE%" -NoProfile -ExecutionPolicy Bypass -NoLogo -File "%PS_SCRIPT%" %*
endlocal
