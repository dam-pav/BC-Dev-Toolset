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
		powershell.exe -NoProfile -Command "try { $process = Start-Process -FilePath '%~f0' -Verb RunAs -Wait -PassThru -ErrorAction Stop; exit $process.ExitCode } catch { Write-Error $_; exit 1 }"
	) else (
		powershell.exe -NoProfile -Command "try { $process = Start-Process -FilePath '%~f0' -ArgumentList '!ARGS!' -Verb RunAs -Wait -PassThru -ErrorAction Stop; exit $process.ExitCode } catch { Write-Error $_; exit 1 }"
	)
	exit /b %errorlevel%
)

echo Updating Microsoft PowerShell...
winget source update --name winget
if %errorlevel% neq 0 (
	echo Warning: Could not update the winget package source. Continuing with the currently cached source data.
)

winget upgrade --id Microsoft.PowerShell -e --source winget --include-unknown --force --accept-package-agreements --accept-source-agreements --disable-interactivity
if %errorlevel% neq 0 (
	echo PowerShell was not upgraded via winget. Trying forced installation...
	winget install --id Microsoft.PowerShell -e --source winget --force --accept-package-agreements --accept-source-agreements --disable-interactivity
	if !errorlevel! neq 0 (
		echo PowerShell upgrade or installation failed.
		set "EXIT_CODE=!errorlevel!"
		goto ExitWithPause
	)
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

set "LATEST_PWSH_VERSION="
for /f "usebackq delims=" %%V in (`powershell.exe -NoProfile -Command "try { ((Invoke-RestMethod -Uri 'https://api.github.com/repos/PowerShell/PowerShell/releases/latest' -Headers @{ 'User-Agent' = 'BC-Dev-Toolset' } -ErrorAction Stop).tag_name -replace '^v','') } catch { '' }"`) do set "LATEST_PWSH_VERSION=%%V"
if not "%LATEST_PWSH_VERSION%"=="" (
	powershell.exe -NoProfile -Command "if ([version]'%PWSH_VERSION%' -lt [version]'%LATEST_PWSH_VERSION%') { exit 1 }"
	if !errorlevel! neq 0 (
		echo Latest PowerShell release is %LATEST_PWSH_VERSION%, but winget installed %PWSH_VERSION%.
		echo The winget source may not have published the latest package yet. Try again later, or install the latest PowerShell release manually from GitHub.
		set "EXIT_CODE=1"
		goto ExitWithPause
	)
)
set "EXIT_CODE=0"

:ExitWithPause
echo.
pause
endlocal & exit /b %EXIT_CODE%
