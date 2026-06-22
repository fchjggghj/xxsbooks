param(
  [string]$SourceRoot = "",
  [string]$SourceOutputDirName = "",
  [string]$TargetRoot = "C:\Users\Administrator\Desktop\novel_pipeline\data\01_broken_outlines",
  [switch]$MoveAfterComplete
)

$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$ConfigPath = Join-Path $ProjectRoot "config.json"

if ((!$SourceRoot -or !$SourceOutputDirName) -and (Test-Path -LiteralPath $ConfigPath)) {
  $cfg = Get-Content -LiteralPath $ConfigPath -Encoding UTF8 | ConvertFrom-Json
  if (!$SourceRoot) { $SourceRoot = [string]$cfg.libraryRoot }
  if (!$SourceOutputDirName) { $SourceOutputDirName = [string]$cfg.outputDir }
}

if (!$SourceRoot) { throw "SourceRoot is empty." }
if (!$SourceOutputDirName) { throw "SourceOutputDirName is empty." }
if (!(Test-Path -LiteralPath $SourceRoot)) {
  throw "SourceRoot not found: $SourceRoot"
}

New-Item -ItemType Directory -Force -Path $TargetRoot | Out-Null

$copied = 0
$moved = 0
$skipped = 0
$novels = 0

Get-ChildItem -LiteralPath $SourceRoot -Directory | ForEach-Object {
  $novel = $_
  $outDir = Join-Path $novel.FullName $SourceOutputDirName
  if (Test-Path -LiteralPath $outDir) {
    $script:novels++
    $targetNovelDir = Join-Path $TargetRoot $novel.Name
    New-Item -ItemType Directory -Force -Path $targetNovelDir | Out-Null

    Get-ChildItem -LiteralPath $outDir -File -Filter "*.md" | ForEach-Object {
      $target = Join-Path $targetNovelDir $_.Name
      $sameSize = $false
      if (Test-Path -LiteralPath $target) {
        $sameSize = ((Get-Item -LiteralPath $target).Length -eq $_.Length)
      }

      if ($sameSize) {
        if ($MoveAfterComplete) {
          Remove-Item -LiteralPath $_.FullName -Force
          $script:moved++
        } else {
          $script:skipped++
        }
      } elseif ($MoveAfterComplete) {
        Move-Item -LiteralPath $_.FullName -Destination $target -Force
        $script:moved++
      } else {
        Copy-Item -LiteralPath $_.FullName -Destination $target -Force
        $script:copied++
      }
    }
  }
}

[pscustomobject]@{
  SourceRoot = $SourceRoot
  SourceOutputDirName = $SourceOutputDirName
  TargetRoot = $TargetRoot
  NovelFolders = $novels
  Copied = $copied
  Moved = $moved
  SkippedSameSize = $skipped
  Mode = $(if ($MoveAfterComplete) { "move" } else { "copy" })
}
