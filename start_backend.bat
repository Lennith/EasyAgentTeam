@echo off
setlocal

cd /d "%~dp0"

set "PORT=43123"
if not "%~1"=="" (
  set "PORT=%~1"
)
echo [start_backend] PORT=%PORT%

echo [start_backend] stopping existing backend processes...
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$repo=(Resolve-Path '%~dp0').Path.TrimEnd('\');" ^
  "$targets=Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" | Where-Object { $_.CommandLine -and $_.CommandLine -like ('*'+$repo+'*') -and $_.CommandLine -like '*\\server\\*' };" ^
  "foreach($p in $targets){ try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop; Write-Output ('[start_backend] stopped pid='+$p.ProcessId) } catch {} }"

for /f "tokens=5" %%p in ('netstat -ano ^| findstr /R /C:":%PORT% .*LISTENING"') do (
  taskkill /PID %%p /F >nul 2>nul
  echo [start_backend] released port %PORT% (pid %%p)
)

echo [start_backend] starting server...
npm --prefix server run dev
