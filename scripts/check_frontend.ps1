try {
  $r = Invoke-WebRequest -Uri 'http://127.0.0.1:3118' -UseBasicParsing -TimeoutSec 5
  Write-Output "3118 UP: $($r.StatusCode)"
} catch {
  Write-Output "3118 DOWN: $($_.Exception.Message)"
}
Write-Output "--- next/tauri dev processes ---"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe' OR Name = 'cmd.exe'" |
  Where-Object { $_.CommandLine -match 'next dev|tauri dev|tauri:dev' } |
  Select-Object ProcessId, CommandLine | Format-List
