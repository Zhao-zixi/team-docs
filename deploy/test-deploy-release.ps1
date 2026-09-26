#requires -Version 7.0
[CmdletBinding()]
param()
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$root = Join-Path $env:TEMP ('TeamShelf CD wrapper ' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $root -Force | Out-Null
$log = Join-Path $root 'gh argv.txt'
$gh = Join-Path $root 'gh-mock.ps1'
$ghBody = @(
'if ($args[0] -eq ''repo'') { ''{"nameWithOwner":"Zhao-zixi/team-docs","visibility":"PRIVATE"}'' }',
'else { [IO.File]::AppendAllText($env:GH_ARGS_LOG, (($args -join '' '') + [Environment]::NewLine)) }'
) -join "`n"
[IO.File]::WriteAllText($gh, $ghBody + "`n", [Text.UTF8Encoding]::new($false))
$target = Join-Path $repo 'deploy/deploy-release.ps1'
$env:GH_ARGS_LOG = $log
try {
    & pwsh -NoProfile -File $target -Help | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'CD helper help did not return success.' }
    & pwsh -NoProfile -File $target -RunId 123456789 -GhPath $gh | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Validate-only dispatch simulation failed.' }
    $calls = [IO.File]::ReadAllLines($log)
    $last = $calls[-1]
    if (-not $last.Contains('validate_only=true') -or -not $last.Contains('init_volume=false') -or -not $last.Contains('123456789')) { throw 'Default dispatch did not request validate-only with no volume initialization.' }
    & pwsh -NoProfile -File $target -RunId 123456789 -Deploy -InitVolume -GhPath $gh | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Deploy dispatch simulation failed.' }
    $calls = [IO.File]::ReadAllLines($log)
    $last = $calls[-1]
    if (-not $last.Contains('validate_only=false') -or -not $last.Contains('init_volume=true')) { throw 'Explicit deployment inputs were not forwarded.' }
    $before = (Get-Item -LiteralPath $log).Length
    & pwsh -NoProfile -File $target -RunId invalid -GhPath $gh 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { throw 'Invalid run ID was accepted.' }
    if ((Get-Item -LiteralPath $log).Length -ne $before) { throw 'Invalid run ID reached gh or caused a dispatch.' }
    Write-Output 'CD PowerShell wrapper mock passed: default validate-only, explicit Deploy/init flags, invalid run ID rejected before gh.'
} finally {
    Remove-Item Env:GH_ARGS_LOG -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $root -Recurse -Force -ErrorAction SilentlyContinue
}
