#requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$bash = 'C:\Project\Git\bin\bash.exe'
if (-not (Test-Path -LiteralPath $bash)) { throw 'Git Bash was not found at the test machine path.' }
$cygpath = Join-Path (Split-Path -Parent $bash) 'cygpath.exe'
if (-not (Test-Path -LiteralPath $cygpath)) { $cygpath = Join-Path (Split-Path -Parent (Split-Path -Parent $bash)) 'usr\bin\cygpath.exe' }
if (-not (Test-Path -LiteralPath $cygpath)) { throw 'Git Bash cygpath.exe was not found.' }
$root = Join-Path $env:TEMP ('TeamShelf Source Wrapper ' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $root 'project with spaces'
$backup = Join-Path $root 'persistent backup with spaces'
$log = Join-Path $root 'argv.log'
New-Item -ItemType Directory -Path (Join-Path $project 'deploy') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repo 'deploy/source-up.ps1') -Destination (Join-Path $project 'deploy/source-up.ps1')
$scriptUnix = (& $cygpath -u (Join-Path $project 'deploy/source-up.sh')).Trim()
$logUnix = (& $cygpath -u $log).Trim()
$capture = @(
'#!/usr/bin/env bash',
'set -eu',
'for arg in "$@"; do printf ''<%s>\n'' "$arg" >>"$TEST_ARG_LOG"; done'
) -join "`n"
[IO.File]::WriteAllText((Join-Path $project 'deploy/source-up.sh'), $capture + "`n", [Text.UTF8Encoding]::new($false))
$env:TEST_ARG_LOG = $logUnix
$toBash = { param([string]$p) (& $cygpath -u $p).Trim() }
try {
    & (Join-Path $project 'deploy/source-up.ps1') -Project wrapper-test -Volume wrapper-test-data -Origin http://localhost:8080 -Port 18080 -CookieSecure false -BackupDir $backup -BashPath $bash
    if ($LASTEXITCODE -ne 0) { throw "Git Bash capture launcher exited $LASTEXITCODE." }
    $args = [IO.File]::ReadAllLines($log)
    $expectedBackup = (& $toBash $backup).Trim()
    $expectedProjectFile = (& $toBash (Join-Path $project 'deploy/source-up.sh')).Trim()
    foreach ($expected in @('--project', 'wrapper-test', '--volume', 'wrapper-test-data', '--origin', 'http://localhost:8080', '--port', '18080', '--cookie-secure', 'false', '--backup-dir', $expectedBackup)) {
        if ($args -cnotcontains "<$expected>") { throw "PowerShell wrapper did not pass argv atomically: <$expected>" }
    }
    if ($args -cnotcontains '<--project>' -or $args -cnotcontains "<$expectedBackup>") { throw 'Argument values with spaces were split.' }
    Write-Output 'source-up PowerShell argv mock passed: all option/value pairs preserved; backup path with spaces passed as one argument.'
} finally {
    Remove-Item Env:TEST_ARG_LOG -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
