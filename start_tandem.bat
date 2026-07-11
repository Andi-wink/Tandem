@echo off
REM One-click Tandem launcher: starts backend (FastAPI) + frontend (Tauri, CUDA) together.
cd /d "%~dp0"

echo Starting Tandem backend (port 5167)...
start "Tandem Backend" cmd /k "cd /d "%~dp0backend\app" && call ..\..\.venv\Scripts\activate.bat && python -m uvicorn main:app --host 0.0.0.0 --port 5167"

echo Starting Tandem frontend (Tauri + CUDA)...
start "Tandem Frontend" cmd /k "cd /d "%~dp0frontend" && pnpm run tauri:dev:cuda"

echo Both processes launching in separate windows. Close this window any time.
