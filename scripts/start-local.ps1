#requires -Version 7.0
[CmdletBinding()]
param([switch]$Help)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Show-Help {
    @(
        'TeamShelf local single-process launcher (Windows)', '',
        'Usage:',
        '  pwsh -NoProfile -File .\scripts\start-local.ps1', '',
        'Requires Node.js 24 and npm. Creates .env only when absent, installs',
        'locked dependencies if needed, builds the production app, then runs',
        'the single Node server in this console. Open the shown URL after startup.',
        'This is for local use, not NAS/Docker deployment.'
    ) -join [Environment]::NewLine | Write-Output
}
if ($Help) { Show-Help; exit 0 }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This launcher requires Windows PowerShell 7.' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'package.json')) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'package-lock.json'))) { throw 'Project package.json or package-lock.json is missing.' }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand -or $null -eq $npmCommand) { throw 'Node.js 24 and npm are required. Install Node.js 24 LTS and reopen PowerShell.' }
$nodeVersion = (& $nodeCommand.Source -p 'process.versions.node' 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^24\.') { throw "Node.js 24 is required; detected '$nodeVersion'." }
$envPath = Join-Path $projectRoot '.env'
Push-Location -LiteralPath $projectRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\vite\bin\vite.js')) -or
        -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\typescript\bin\tsc')) -or
        -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\fastify\package.json'))) {
        Write-Host 'Installing locked npm dependencies…'
        & $npmCommand.Source ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    }
    if (-not (Test-Path -LiteralPath $envPath)) {
        Write-Host 'Creating a private .env with a random one-time setup token…'
        & $npmCommand.Source run configure
        if ($LASTEXITCODE -ne 0) { throw "npm run configure failed with exit code $LASTEXITCODE." }
    } else { Write-Host 'Keeping the existing .env and its setup token unchanged.' }
} finally { Pop-Location }
$filePort = ''
$fileOrigin = ''
foreach ($line in [IO.File]::ReadAllLines($envPath)) {
    if ($line -match '^\s*PORT\s*=\s*"?([^"\s#]+)"?\s*(?:#.*)?$') { $filePort = $Matches[1] }
    if ($line -match '^\s*APP_ORIGIN\s*=\s*"?([^"\s#]+)"?\s*(?:#.*)?$') { $fileOrigin = $Matches[1] }
}
$portText = if (-not [string]::IsNullOrWhiteSpace($env:PORT)) { $env:PORT.Trim() } elseif ($filePort) { $filePort } else { '3000' }
$port = 0
if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { throw 'PORT must be an integer between 1 and 65535.' }
$appOrigin = if (-not [string]::IsNullOrWhiteSpace($env:APP_ORIGIN)) { $env:APP_ORIGIN.Trim() } else { $fileOrigin }
$originUri = $null
if (-not $appOrigin -or -not [Uri]::TryCreate($appOrigin, [UriKind]::Absolute, [ref]$originUri) -or
    $originUri.Scheme -notin @('http', 'https') -or $originUri.UserInfo -or $originUri.Query -or $originUri.Fragment -or
    $originUri.AbsolutePath -ne '/' -or $originUri.GetLeftPart([UriPartial]::Authority) -cne $appOrigin) {
    throw 'APP_ORIGIN must be an exact http(s) origin without a path; set it in .env or the current PowerShell environment.'
}
$listening = @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue)
if ($listening.Count -gt 0) { throw "Configured TeamShelf port $port is already in use." }
Push-Location -LiteralPath $projectRoot
try {
    Write-Host 'Building the TeamShelf web app…'
    & $npmCommand.Source run build
    if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
    Write-Host "Starting TeamShelf at $appOrigin (Ctrl+C stops it and releases the data lock)."
    $previousNodeEnvironment = $env:NODE_ENV
    try {
        $env:NODE_ENV = 'production'
        & $nodeCommand.Source '--env-file-if-exists=.env' 'dist/server/index.js'
        if ($LASTEXITCODE -ne 0) { throw "TeamShelf server exited with code $LASTEXITCODE." }
    } finally {
        if ($null -eq $previousNodeEnvironment) { Remove-Item Env:NODE_ENV -ErrorAction SilentlyContinue }
        else { $env:NODE_ENV = $previousNodeEnvironment }
    }
} finally { Pop-Location }
