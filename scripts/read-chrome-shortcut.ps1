param([Parameter(Mandatory = $true)][string]$ShortcutPath)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
if (-not (Test-Path -LiteralPath $ShortcutPath)) { throw "Shortcut not found: $ShortcutPath" }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Resolve-Path -LiteralPath $ShortcutPath).Path)
[pscustomobject]@{
  targetPath = $shortcut.TargetPath
  arguments = $shortcut.Arguments
  workingDirectory = $shortcut.WorkingDirectory
} | ConvertTo-Json -Compress
