# Protect the dedicated ChatGPT automation Chrome profile from accidental deletion.
# This keeps Chrome free to update cookies/cache inside the profile while blocking
# direct deletion of the profile root folder.

$ErrorActionPreference = 'Stop'

$profile = 'C:\chrome-automation'
$marker = Join-Path $profile 'NOVEL_PIPELINE_PROFILE_DO_NOT_DELETE.txt'

New-Item -ItemType Directory -Force -Path $profile | Out-Null

@"
This Chrome profile stores the ChatGPT login state for novel_pipeline.

Do not delete or replace this folder:
$profile

The runner, control panel, and launch scripts all use this profile with:
--user-data-dir=$profile

If this folder is deleted or replaced, ChatGPT will require login again.
"@ | Set-Content -Path $marker -Encoding UTF8

# Guard rail against accidental Remove-Item / Explorer deletion of the profile
# root. Do not inherit this ACE to children: Chrome must still be able to rotate
# cookies, cache, locks, and sqlite journals normally.
& icacls $profile /remove:d '*S-1-1-0' | Out-Null
& icacls $profile /deny '*S-1-1-0:(DE)' | Out-Null

Write-Host "Protected Chrome automation profile: $profile"
