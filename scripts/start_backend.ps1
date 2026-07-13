# Starts the Tandem FastAPI backend detached (survives terminal close), with output captured to a
# log so silent deaths are diagnosable. Log: backend\backend.log (overwritten per start, previous
# run kept as backend.prev.log).
$venvPython = 'D:\Dev-projects\Tandem\.venv\Scripts\python.exe'
$workDir = 'D:\Dev-projects\Tandem\backend\app'
$logDir = 'D:\Dev-projects\Tandem\backend'
$log = Join-Path $logDir 'backend.log'
$prev = Join-Path $logDir 'backend.prev.log'

if (Test-Path $log) { Move-Item -Force $log $prev }

# cmd wrapper so >> redirection applies to the detached child; unbuffered (-u) so the log is live.
$cmdLine = "cmd.exe /c `"`"$venvPython`" -u -m uvicorn main:app --host 0.0.0.0 --port 5167 >> `"$log`" 2>&1`""
$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = $cmdLine
  CurrentDirectory = $workDir
}
Write-Output "ReturnValue: $($result.ReturnValue)  NewProcessId: $($result.ProcessId)  Log: $log"
