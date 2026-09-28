[CmdletBinding()]
param(
    [switch]$Help,
    [switch]$InitVolume,
    [switch]$FromMain,
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
        '  powershell -NoProfile -File .\deploy\source-up.ps1 -Project NAME -Volume NAME -BackupDir PATH [-Origin URL] [-Port PORT] [-CookieSecure true|false] [-InitVolume] [-FromMain]', '',
        'Requires Docker Desktop with Linux containers, Compose v2, Git for Windows/Git Bash,',
        'and a persistent backup folder outside the checkout. -InitVolume explicitly permits',
        'creating a missing empty data volume; an existing .env is never changed.',
        'Use -FromMain only in a clean main checkout to fast-forward origin/main before deployment.'
    ) -join [Environment]::NewLine | Write-Output
}
if ($Help) { Show-Help; exit 0 }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'Use deploy/source-up.sh directly on Linux/NAS.' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path

function Get-ForwardArguments {
    $forward = [System.Collections.Generic.List[string]]::new()
    if ($Project) { $forward.Add('-Project'); $forward.Add($Project) }
    if ($Volume) { $forward.Add('-Volume'); $forward.Add($Volume) }
    if ($Origin) { $forward.Add('-Origin'); $forward.Add($Origin) }
    if ($Port -gt 0) { $forward.Add('-Port'); $forward.Add([string]$Port) }
    if ($CookieSecure) { $forward.Add('-CookieSecure'); $forward.Add($CookieSecure) }
    if ($BackupDir) { $forward.Add('-BackupDir'); $forward.Add($BackupDir) }
    if ($BashPath) { $forward.Add('-BashPath'); $forward.Add($BashPath) }
    if ($InitVolume) { $forward.Add('-InitVolume') }
    return ,$forward.ToArray()
}

if ($FromMain) {
    $git = $env:TEAMSHELF_GIT_BIN
    if (-not $git) { $git = 'git' }
    $branch = & $git -C $projectRoot branch --show-current
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect checkout branch; deployment was not started.' }
    if ($branch -ne 'main') { throw '-FromMain is allowed only from the main branch.' }
    & $git -C $projectRoot diff --quiet HEAD --
    if ($LASTEXITCODE -ne 0) { throw 'Tracked working tree must be clean before -FromMain.' }
    & $git -C $projectRoot fetch origin main
    if ($LASTEXITCODE -ne 0) { throw 'git fetch origin main failed; deployment was not started.' }
    $fetchedMain = & $git -C $projectRoot rev-parse --verify 'FETCH_HEAD^{commit}'
    if ($LASTEXITCODE -ne 0 -or $fetchedMain -notmatch '^[0-9a-fA-F]{40,64}$') { throw 'Cannot resolve the freshly fetched origin/main commit; deployment was not started.' }
    & $git -C $projectRoot merge-base --is-ancestor HEAD $fetchedMain
    if ($LASTEXITCODE -ne 0) { throw 'Local main is ahead of or diverged from the freshly fetched origin/main; refusing deployment.' }
    & $git -C $projectRoot merge --ff-only $fetchedMain
    if ($LASTEXITCODE -ne 0) { throw 'git merge --ff-only of freshly fetched origin/main failed; deployment was not started.' }
    $powerShell = (Get-Process -Id $PID).Path
    if (-not $powerShell -or -not (Test-Path -LiteralPath $powerShell)) { throw 'Cannot locate the current PowerShell executable to restart the updated wrapper.' }
    $forward = Get-ForwardArguments
    & $powerShell -NoProfile -File $PSCommandPath @forward
    $reentryExitCode = $LASTEXITCODE
    if ($null -eq $reentryExitCode) { $reentryExitCode = 0 }
    exit $reentryExitCode
}

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
