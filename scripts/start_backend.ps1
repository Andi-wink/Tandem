$venvPython = 'D:\Dev-projects\Tandem\.venv\Scripts\python.exe'
$workDir = 'D:\Dev-projects\Tandem\backend\app'
$args = '-m uvicorn main:app --host 0.0.0.0 --port 5167'

$result = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
  CommandLine      = "`"$venvPython`" $args"
  CurrentDirectory = $workDir
}
Write-Output "ReturnValue: $($result.ReturnValue)  NewProcessId: $($result.ProcessId)"
