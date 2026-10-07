@echo off
set "BACK=%~dp0backend"
set "FRONT=%~dp0frontend"

echo [1/4] Stopping existing servers...
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":8000 " ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
for /f "tokens=5" %%a in ('netstat -ano 2^>nul ^| findstr ":5173 " ^| findstr "LISTENING"') do taskkill /f /pid %%a >nul 2>&1
timeout /t 2 /nobreak >nul

echo [2/4] Starting backend (port 8000)...
start /b /d "%BACK%" cmd /c "python -m uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload > logs\server.log 2> logs\server_err.log"
timeout /t 5 /nobreak >nul

echo [3/4] Starting frontend (port 5173)...
start /b /d "%FRONT%" cmd /c "npm run dev > ..\backend\logs\frontend.log 2>&1"
timeout /t 8 /nobreak >nul

echo [4/4] Checking status...
netstat -ano | findstr ":8000 :5173" | findstr "LISTENING"
echo.
echo Backend:  http://localhost:8000
echo Frontend: http://localhost:5173
echo Docs:     http://localhost:8000/docs
