@echo off
REM One-click Tandem launcher: starts backend (FastAPI) + frontend (Tauri, CUDA).
REM
REM Frontend runs from D:\Dev-projects\Tandem-main\frontend, NOT this repo's frontend.
REM Reason: on 2026-07-27 autostart failed because D:\Dev-projects\Tandem\frontend was
REM stuck on an old feature branch (39 commits behind main). The app panicked at startup
REM with a sqlx error ("migration was previously applied but is missing in the resolved
REM migrations") because the shared SQLite DB has newer migrations than that stale checkout
REM ships. Tandem-main is the current, correct checkout of main, so we launch from there.
REM
REM The backend still runs from this repo (D:\Dev-projects\Tandem) with its .venv, which is
REM the canonical backend. Its output is appended to backend\backend-5167.log (stderr merged)
REM so any startup failure is diagnosable.

cd /d "%~dp0"

echo Starting Tandem backend (port 5167)...
start "Tandem Backend" cmd /c "cd /d "%~dp0backend\app" && call ..\..\.venv\Scripts\activate.bat && python -m uvicorn main:app --host 0.0.0.0 --port 5167 >> "%~dp0backend\backend-5167.log" 2>&1"

echo Starting Tandem frontend (Tauri + CUDA) from Tandem-main...
echo launched at %date% %time% >> "D:\Dev-projects\Tandem-main\frontend\tauri-dev-startup.log"
start "Tandem Frontend" cmd /k "cd /d "D:\Dev-projects\Tandem-main\frontend" && pnpm run tauri:dev:cuda"

echo Both processes launching in separate windows. Close this window any time.
