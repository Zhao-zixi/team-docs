#requires -Version 7.0
[CmdletBinding()]
param(
    [switch]$Help,
    [ValidatePattern('^[0-9]{1,20}$')][string]$RunId,
    [switch]$Deploy,
    [switch]$InitVolume,
    [string]$GhPath
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$repository = 'Zhao-zixi/team-docs'
function Show-Help {
    @(
        'Dispatch a TeamShelf release using trusted metadata from a successful main CI run.', '',
        'Usage:',
        '  pwsh -NoProfile -File .\deploy\deploy-release.ps1 -RunId CI_RUN_ID [-Deploy] [-InitVolume]', '',
        'Default mode only asks GitHub Actions to validate the run and digest; it does not contact the NAS.',
        'Pass -Deploy explicitly to authorize the NAS deployment job. -InitVolume is forwarded only as a',
        'fixed boolean input; validate-only mode remains read-only even when it is set.',
        'Requires GitHub CLI authenticated to the private Zhao-zixi/team-docs repository.'
    ) -join [Environment]::NewLine | Write-Output
}
if ($Help) { Show-Help; exit 0 }
if (-not $RunId) { throw 'RunId is required; use -Help for usage.' }
if (-not $GhPath) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($null -eq $gh) { throw 'GitHub CLI (gh) is required.' }
    $GhPath = $gh.Source
}
if (-not (Test-Path -LiteralPath $GhPath)) { throw 'GitHub CLI executable path is invalid.' }
function Invoke-Gh([string[]]$Arguments) {
    $result = & $GhPath @Arguments 2>&1
    $exitCode = Get-Variable -Name LASTEXITCODE -ValueOnly -ErrorAction SilentlyContinue
    if ($null -ne $exitCode -and $exitCode -ne 0) { throw "GitHub CLI failed for '$($Arguments[0]) $($Arguments[1])'. Check gh auth and repository access." }
    return ($result -join [Environment]::NewLine)
}
# Do not print gh auth status output: it may include account details that are not needed here.
$null = Invoke-Gh @('auth', 'status', '--hostname', 'github.com')
$repoJson = Invoke-Gh @('repo', 'view', $repository, '--json', 'nameWithOwner,visibility')
try { $repoInfo = $repoJson | ConvertFrom-Json -ErrorAction Stop } catch { throw 'GitHub CLI returned invalid repository metadata.' }
if ($repoInfo.nameWithOwner -ine $repository -or $repoInfo.visibility -ine 'PRIVATE') {
    throw 'Expected the existing private Zhao-zixi/team-docs repository; no workflow was dispatched.'
}
$validateOnly = if ($Deploy) { 'false' } else { 'true' }
$initVolumeValue = if ($InitVolume) { 'true' } else { 'false' }
$workflowArgs = @(
    'workflow', 'run', 'deploy.yml', '--repo', $repository, '--ref', 'main',
    '-f', "run_id=$RunId",
    '-f', "validate_only=$validateOnly",
    '-f', "init_volume=$initVolumeValue"
)
$dispatchResult = Invoke-Gh $workflowArgs
if ($dispatchResult) { Write-Output $dispatchResult }
if ($Deploy) {
    Write-Output "NAS deployment dispatch submitted for verified CI run $RunId. Track it at https://github.com/$repository/actions/workflows/deploy.yml."
} else {
    Write-Output "Validate-only dispatch submitted for CI run $RunId; no NAS job will be queued. Track it at https://github.com/$repository/actions/workflows/deploy.yml."
}
