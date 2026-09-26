#requires -Version 7.0
[CmdletBinding()]
param([switch]$Help,[switch]$NoBrowser)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
function Show-Help {
    @(
        'TeamShelf local development launcher (Windows only)',
        '',
        'Usage:',
        '  pwsh -NoProfile -File .\scripts\start-dev.ps1 [-NoBrowser]',
        '',
        'Run from any directory. Requires Node.js 24 and npm. Installs locked',
        'dependencies if needed, creates .env only when absent, starts API and',
        'Vite in one console, and opens http://localhost:5173. Ctrl+C stops',
        'only the two Node processes started by this invocation.',
        '',
        'Local development only, not production/NAS. The setup token is stored',
        'in project .env and is never printed.'
    ) -join [Environment]::NewLine | Write-Output
}
if ($Help) { Show-Help; exit 0 }
if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { throw 'This launcher requires Windows PowerShell 7.' }
$projectRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$packagePath = Join-Path $projectRoot 'package.json'
$lockPath = Join-Path $projectRoot 'package-lock.json'
if (-not (Test-Path -LiteralPath $packagePath) -or -not (Test-Path -LiteralPath $lockPath)) { throw 'Project package.json or package-lock.json is missing.' }
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
$npmCommand = Get-Command npm -ErrorAction SilentlyContinue
if ($null -eq $nodeCommand -or $null -eq $npmCommand) { throw 'Node.js 24 and npm are required. Install Node.js 24 LTS and reopen PowerShell.' }
$nodeVersion = (& $nodeCommand.Source -p 'process.versions.node' 2>$null).Trim()
if ($LASTEXITCODE -ne 0 -or $nodeVersion -notmatch '^24\.') { throw "Node.js 24 is required; detected '$nodeVersion'." }
$listeningPorts = @(Get-NetTCPConnection -State Listen -LocalPort 3000,5173 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort -Unique)
if ($listeningPorts.Count -gt 0) { throw "Required local port(s) already in use: $($listeningPorts -join ', ')." }
Push-Location -LiteralPath $projectRoot
try {
    if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\tsx\dist\loader.mjs')) -or -not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules\vite\bin\vite.js'))) {
        Write-Host 'Installing locked npm dependencies…'
        & $npmCommand.Source ci
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }
    }
    $envPath = Join-Path $projectRoot '.env'
    if (-not (Test-Path -LiteralPath $envPath)) {
        Write-Host 'Creating a private .env with a random one-time setup token…'
        & $npmCommand.Source run configure
        if ($LASTEXITCODE -ne 0) { throw "npm run configure failed with exit code $LASTEXITCODE." }
    } else { Write-Host 'Keeping the existing .env and its setup token unchanged.' }
} finally { Pop-Location }
Write-Host 'Starting TeamShelf API and Vite in this console. Press Ctrl+C to stop both.'
if (-not $NoBrowser) { Start-Process 'http://localhost:5173' }
Push-Location -LiteralPath $projectRoot
try {
    & $nodeCommand.Source 'scripts/start-dev.mjs'
    if ($LASTEXITCODE -ne 0) { throw "Development launcher exited with code $LASTEXITCODE." }
} finally { Pop-Location }
