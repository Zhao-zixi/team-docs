#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$Help,
    [switch]$InitVolume,
    [string]$Project,
    [string]$Volume,
    [string]$Origin,
    [ValidateRange(1, 65535)][int]$Port,
    [ValidateSet('true', 'false')][string]$CookieSecure,
    [string]$BackupDir,
    [string]$BashPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Show-Help {
    @(
        'TeamShelf source Docker Compose launcher (Windows)', '',
        'Usage:',
        '  pwsh -NoProfile -File .\deploy\source-up.ps1 -Project NAME -Volume NAME -BackupDir PATH [-Origin URL] [-Port PORT] [-CookieSecure true|false] [-InitVolume]', '',
        'Requires Docker Desktop with Linux containers, Compose v2, Git for Windows/Git Bash,',
        'and a persistent backup folder outside the checkout. -InitVolume explicitly permits',
        'creating a missing empty data volume; an existing .env is never changed.'
    ) -join [Environment]::NewLine | Write-Output
}
if ($Help) { Show-Help; exit 0 }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use deploy/source-up.sh directly on Linux/NAS.' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not $BashPath) {
    $bashCommand = Get-Command bash.exe -ErrorAction SilentlyContinue
    if ($null -ne $bashCommand) { $BashPath = $bashCommand.Source }
    else {
        $candidates = @((Join-Path $env:ProgramFiles 'Git\bin\bash.exe'), 'C:\Project\Git\bin\bash.exe')
        $BashPath = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
}
if (-not $BashPath -or -not (Test-Path -LiteralPath $BashPath)) { throw 'Git Bash is required. Install Git for Windows or pass -BashPath.' }
$bashDir = Split-Path -Parent $BashPath
$cygpathCandidates = @(
    (Join-Path $bashDir 'cygpath.exe'),
    (Join-Path (Split-Path -Parent $bashDir) 'usr\bin\cygpath.exe')
)
$cygpath = $cygpathCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $cygpath) { throw 'Git Bash cygpath.exe is missing; install Git for Windows completely or pass a supported -BashPath.' }
function Convert-ToBashPath([string]$PathValue) {
    $converted = & $cygpath -u $PathValue
    if ($LASTEXITCODE -ne 0 -or -not $converted) { throw 'Git Bash could not convert a filesystem path.' }
    return ($converted | Select-Object -Last 1).Trim()
}
$scriptBashPath = Convert-ToBashPath (Join-Path $projectRoot 'deploy\source-up.sh')
$bashArgs = [System.Collections.Generic.List[string]]::new()
$bashArgs.Add($scriptBashPath)
if ($Help) { $bashArgs.Add('--help') }
if ($Project) { $bashArgs.Add('--project'); $bashArgs.Add($Project) }
if ($Volume) { $bashArgs.Add('--volume'); $bashArgs.Add($Volume) }
if ($Origin) { $bashArgs.Add('--origin'); $bashArgs.Add($Origin) }
if ($PSBoundParameters.ContainsKey('Port')) { $bashArgs.Add('--port'); $bashArgs.Add([string]$Port) }
if ($CookieSecure) { $bashArgs.Add('--cookie-secure'); $bashArgs.Add($CookieSecure) }
if ($BackupDir) { $bashArgs.Add('--backup-dir'); $bashArgs.Add((Convert-ToBashPath $BackupDir)) }
if ($InitVolume) { $bashArgs.Add('--init-volume') }
Push-Location -LiteralPath $projectRoot
try {
    & $BashPath @bashArgs
    if ($LASTEXITCODE -ne 0) { throw "Git Bash source deployment exited with code $LASTEXITCODE." }
} finally { Pop-Location }
