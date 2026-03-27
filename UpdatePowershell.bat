@echo off
setlocal

echo Updating Microsoft PowerShell...
winget uninstall --id Microsoft.PowerShell -e >nul 2>&1
if %errorlevel% neq 0 (
	echo Existing PowerShell package not removed via winget ^(already absent or different source^). Continuing...
)

winget install --id Microsoft.PowerShell -e --source winget --accept-package-agreements --accept-source-agreements
if %errorlevel% neq 0 (
	echo PowerShell installation failed.
	exit /b %errorlevel%
)

echo PowerShell update completed.
where pwsh >nul 2>&1
if %errorlevel% neq 0 (
	echo pwsh executable not found after installation.
	exit /b 1
)

for /f "usebackq delims=" %%V in (`pwsh -NoLogo -NoProfile -Command "$PSVersionTable.PSVersion.ToString()"`) do set "PWSH_VERSION=%%V"
echo Installed PowerShell version: %PWSH_VERSION%
endlocal
