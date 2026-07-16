# Kills any running Tandem uvicorn backend, then starts a fresh one via start_backend.ps1.
$procs = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*uvicorn main:app*' }
foreach ($p in $procs) {
  Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue
  Write-Output "killed $($p.ProcessId)"
}
Start-Sleep -Seconds 1
& "$PSScriptRoot\start_backend.ps1"
