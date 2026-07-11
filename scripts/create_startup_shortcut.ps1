$startup = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startup 'Tandem.lnk'
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut($shortcutPath)
$sc.TargetPath = 'D:\Dev-projects\Tandem\start_tandem.bat'
$sc.WorkingDirectory = 'D:\Dev-projects\Tandem'
$sc.WindowStyle = 7
$sc.Description = 'Auto-start Tandem backend + frontend'
$sc.Save()
Write-Output "Created: $shortcutPath"
