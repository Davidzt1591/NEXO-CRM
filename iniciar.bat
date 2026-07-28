@echo off
setlocal
set "REPO=%~dp0"
set "NODE22=%REPO%.runtime\node-v22.23.1-win-x64\node.exe"
set "NODE22_LAUNCHER=%REPO%scripts\with-node22.ps1"

if not exist "%NODE22_LAUNCHER%" (
  echo ERROR: Node 22 launcher not found at the approved repository path.
  exit /b 1
)

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%NODE22_LAUNCHER%" node --version
if errorlevel 1 exit /b 1

echo [1/3] Verifying optional-free production dependency topology...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%NODE22_LAUNCHER%" npm run verify:production-deps
if errorlevel 1 exit /b 1

set "NEXO_NODE22=%NODE22%"
set "NODE_ENV=production"
echo [2/3] Starting NEXO with PM2 and the approved Node runtime...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%NODE22_LAUNCHER%" node "%APPDATA%\npm\node_modules\pm2\bin\pm2" startOrRestart "%REPO%ecosystem.config.js" --env production --update-env
if errorlevel 1 exit /b 1

echo [3/3] Validating listener ownership, exact health, runtime, and frontend artifact...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%REPO%scripts\validate-running-release.ps1" -RepoRoot "%REPO%"
if errorlevel 1 exit /b 1
echo NEXO release startup validated.
endlocal
