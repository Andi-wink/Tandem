Write-Output "Port 5167 listeners:"
Get-NetTCPConnection -LocalPort 5167 -State Listen -ErrorAction SilentlyContinue | Format-Table -AutoSize
Write-Output "---"
Write-Output "Python/uvicorn processes:"
Get-Process | Where-Object { $_.ProcessName -match 'python|uvicorn' } | Select-Object Id, ProcessName, StartTime | Format-Table -AutoSize
