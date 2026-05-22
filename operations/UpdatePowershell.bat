@echo off
setlocal enabledelayedexpansion

net session >nul 2>&1
if %errorlevel% neq 0 (
	powershell.exe -NoProfile -Command "Write-Host ''; Write-Host 'WARNING: Updating Microsoft PowerShell can disrupt active VS Code sessions, integrated terminals, and running toolset operations that use pwsh.' -ForegroundColor Red; Write-Host 'Save your work and close or restart affected terminals after the update completes.' -ForegroundColor Red; Write-Host ''"
	choice /C YN /N /M "Continue and request administrator privileges? [Y/N] "
	if errorlevel 2 (
		echo PowerShell update cancelled.
		exit /b 1
	)
	echo Requesting administrator privileges...
	set "ARGS=%*"
	if "!ARGS!"=="" (
		powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
	) else (
		powershell.exe -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '!ARGS!' -Verb RunAs"
	)
	exit /b
)

echo Updating Microsoft PowerShell...
winget uninstall --id Microsoft.PowerShell -e >nul 2>&1
if %errorlevel% neq 0 (
	echo Existing PowerShell package not removed via winget ^(already absent or different source^). Continuing...
)

winget install --id Microsoft.PowerShell -e --source winget --accept-package-agreements --accept-source-agreements
if %errorlevel% neq 0 (
	echo PowerShell installation failed.
	set "EXIT_CODE=%errorlevel%"
	goto ExitWithPause
)

echo PowerShell update completed.
where pwsh >nul 2>&1
if %errorlevel% neq 0 (
	echo pwsh executable not found after installation.
	set "EXIT_CODE=1"
	goto ExitWithPause
)

for /f "usebackq delims=" %%V in (`pwsh -NoLogo -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"`) do set "PWSH_VERSION=%%V"
echo Installed PowerShell version: %PWSH_VERSION%
set "EXIT_CODE=0"

:ExitWithPause
echo.
pause
endlocal & exit /b %EXIT_CODE%
