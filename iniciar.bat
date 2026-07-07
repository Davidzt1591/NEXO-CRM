@echo off
echo ========================================
echo   NEXO - Reiniciar Aplicacion
echo ========================================
echo.

:: Verificar si PM2 esta corriendo
pm2 list | findstr "online" >nul
if %errorlevel%==0 (
    echo [1/3] Backend ya esta corriendo en PM2...
) else (
    echo [1/3] Iniciando backend con PM2...
    pm2 start ecosystem.config.js
)

:: Reiniciar frontend
echo [2/3] Iniciando frontend...
start "NEXO Frontend" cmd /k "cd frontend && npm run dev"

echo [3/3] Listo!
echo.
echo   Frontend: http://localhost:5173
echo   Backend:  http://localhost:3001
echo.
echo   Comandos utiles:
echo     pm2 restart nexo-backend  - Reiniciar backend
echo     pm2 logs nexo-backend     - Ver logs backend
echo     pm2 list                  - Ver procesos
echo.
pause
