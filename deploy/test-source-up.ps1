[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$bash = $env:TEAMSHELF_TEST_BASH
if (-not $bash) {
    $bashCommand = Get-Command bash.exe -ErrorAction SilentlyContinue
    if ($null -ne $bashCommand) { $bash = $bashCommand.Source }
    else {
        $candidates = @((Join-Path $env:ProgramFiles 'Git\bin\bash.exe'), 'C:\Project\Git\bin\bash.exe')
        $bash = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    }
}
if (-not $bash -or -not (Test-Path -LiteralPath $bash)) { throw 'Git Bash was not found. Install Git for Windows or set TEAMSHELF_TEST_BASH.' }
$cygpath = Join-Path (Split-Path -Parent $bash) 'cygpath.exe'
if (-not (Test-Path -LiteralPath $cygpath)) { $cygpath = Join-Path (Split-Path -Parent (Split-Path -Parent $bash)) 'usr\bin\cygpath.exe' }
if (-not (Test-Path -LiteralPath $cygpath)) { throw 'Git Bash cygpath.exe was not found.' }
$root = Join-Path $env:TEMP ('TeamShelf Source Wrapper ' + [guid]::NewGuid().ToString('N'))
$project = Join-Path $root 'project with spaces'
$backup = Join-Path $root 'persistent backup with spaces'
$log = Join-Path $root 'argv.log'
$gitLog = Join-Path $root 'git.log'
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

    $gitMock = Join-Path $root 'git-mock.cmd'
    @'
@echo off
echo %*>>"%TEST_GIT_LOG%"
echo %*| findstr /C:"branch --show-current" >nul && (echo %TEST_GIT_BRANCH%& exit /b 0)
echo %*| findstr /C:"diff --quiet HEAD --" >nul && (if "%TEST_GIT_DIRTY%"=="1" (exit /b 1) else (exit /b 0))
echo %*| findstr /C:"fetch origin main" >nul && (if "%TEST_GIT_FAIL%"=="fetch" (exit /b 1) else (exit /b 0))
echo %*| findstr /C:"rev-parse --verify FETCH_HEAD" >nul && (echo %TEST_GIT_FETCHED_SHA%& exit /b 0)
echo %*| findstr /C:"merge-base --is-ancestor HEAD" >nul && (if "%TEST_GIT_FAIL%"=="ahead" (exit /b 1) else (exit /b 0))
echo %*| findstr /C:"merge --ff-only" >nul && (if "%TEST_GIT_FAIL%"=="merge" (exit /b 1) else (exit /b 0))
exit /b 2
'@ | Set-Content -LiteralPath $gitMock -Encoding Ascii
    $env:TEST_GIT_LOG = $gitLog
    $env:TEST_GIT_BRANCH = 'main'
    $env:TEST_GIT_FETCHED_SHA = '0123456789abcdef0123456789abcdef01234567'
    $env:TEAMSHELF_GIT_BIN = $gitMock
    $env:TEAMSHELF_TEST_BASH = $bash
    $env:TEST_ARG_LOG = $logUnix
    $env:TEST_GIT_FAIL = ''
    $env:TEST_GIT_DIRTY = '0'
    try {
        Clear-Content -LiteralPath $log -ErrorAction SilentlyContinue
        Clear-Content -LiteralPath $gitLog -ErrorAction SilentlyContinue
        & (Join-Path $project 'deploy/source-up.ps1') -FromMain -Project wrapper-test -Volume wrapper-test-data -Origin http://localhost:8080 -Port 18080 -CookieSecure false -BackupDir $backup -BashPath $bash
        if ($LASTEXITCODE -ne 0) { throw "PowerShell --FromMain re-entry exited $LASTEXITCODE." }
        $gitCalls = [IO.File]::ReadAllLines($gitLog)
        if ($gitCalls.Count -ne 6) { throw "Expected branch check, clean check, fetch, FETCH_HEAD resolution, ancestor check and ff-only merge; got $($gitCalls.Count)." }
        if ($gitCalls[0] -notmatch 'branch --show-current$' -or $gitCalls[1] -notmatch 'diff --quiet HEAD --$' -or $gitCalls[2] -notmatch 'fetch origin main$' -or $gitCalls[3] -notmatch 'rev-parse --verify FETCH_HEAD') { throw 'Git preflight did not run in the expected safe order.' }
        if ($gitCalls[4] -notmatch [regex]::Escape("merge-base --is-ancestor HEAD $env:TEST_GIT_FETCHED_SHA")) { throw 'Ancestor validation did not use the fetched SHA rather than the possibly stale origin/main ref.' }
        if ($gitCalls[5] -notmatch [regex]::Escape("merge --ff-only $env:TEST_GIT_FETCHED_SHA")) { throw 'Fast-forward merge did not use the exact fetched SHA.' }
        $args = [IO.File]::ReadAllLines($log)
        if ($args -ccontains '<--from-main>') { throw 'PowerShell re-entry passed --from-main and would update recursively.' }
        foreach ($expected in @('<--project>', '<wrapper-test>', '<--volume>', '<wrapper-test-data>', '<--origin>', '<http://localhost:8080>', '<--port>', '<18080>', '<--backup-dir>')) {
            if ($args -cnotcontains $expected) { throw "PowerShell -FromMain re-entry lost argument $expected." }
        }
        if ($args -cnotcontains "<$expectedBackup>") { throw 'PowerShell -FromMain re-entry split the backup path.' }
        Write-Output 'source-up PowerShell -FromMain mock passed: ff-only update once, updated wrapper re-entry, and original arguments preserved.'

        foreach ($scenario in @(@{ Name='dirty'; Dirty='1'; Fail='' }, @{ Name='fetch'; Dirty='0'; Fail='fetch' }, @{ Name='ahead'; Dirty='0'; Fail='ahead' }, @{ Name='merge'; Dirty='0'; Fail='merge' })) {
            $env:TEST_GIT_DIRTY = $scenario.Dirty
            $env:TEST_GIT_FAIL = $scenario.Fail
            Clear-Content -LiteralPath $log -ErrorAction SilentlyContinue
            try {
                & (Join-Path $project 'deploy/source-up.ps1') -FromMain -Project wrapper-test -Volume wrapper-test-data -Origin http://localhost:8080 -BackupDir $backup -BashPath $bash 2>$null
                throw "Expected $($scenario.Name) preflight to fail."
            } catch {
                if ($_.Exception.Message -like 'Expected * preflight to fail.') { throw }
            }
            if ((Get-Item -LiteralPath $log -ErrorAction SilentlyContinue) -and (Get-Item -LiteralPath $log).Length -gt 0) { throw "Git preflight failure '$($scenario.Name)' reached Docker/Bash deployment." }
        }
        $env:TEST_GIT_BRANCH = 'feature'
        try {
            & (Join-Path $project 'deploy/source-up.ps1') -FromMain -Project wrapper-test -Volume wrapper-test-data -Origin http://localhost:8080 -BackupDir $backup -BashPath $bash 2>$null
            throw 'Expected non-main branch preflight to fail.'
        } catch {
            if ($_.Exception.Message -eq 'Expected non-main branch preflight to fail.') { throw }
        }
        if ((Get-Item -LiteralPath $log -ErrorAction SilentlyContinue) -and (Get-Item -LiteralPath $log).Length -gt 0) { throw 'Non-main branch reached Docker/Bash deployment.' }
    } finally {
        Remove-Item Env:TEAMSHELF_GIT_BIN,Env:TEAMSHELF_TEST_BASH,Env:TEST_GIT_LOG,Env:TEST_GIT_FAIL,Env:TEST_GIT_DIRTY,Env:TEST_GIT_BRANCH,Env:TEST_GIT_FETCHED_SHA -ErrorAction SilentlyContinue
    }
} finally {
    Remove-Item Env:TEST_ARG_LOG -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
