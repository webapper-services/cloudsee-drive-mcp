<#
.SYNOPSIS
  Start the CloudSee Drive MCP server locally on Windows.

.DESCRIPTION
  Loads your local .env into the process environment, (re)builds the bundle, then
  launches one of the two local transports:

    * stdio (default)  -> node dist/index.js   — the product transport an MCP client
                          (Claude Desktop) spawns. Reads a baked-in API key id/secret.
                          Speaks MCP over stdout and waits for JSON-RPC on stdin.
    * HTTP (-Http)     -> node dist/http.js     — the hosted/remote transport run
                          locally (Streamable HTTP). Multi-tenant / OAuth; holds no
                          API key. Listens on $env:PORT (default 3000).

  The .env is loaded here because the server only reads process.env, and PowerShell
  does not source .env automatically. .env is git-ignored — never commit real creds.
  Nothing from .env is echoed; the server redacts the secret from its own logs.

  This script is location-independent (uses $PSScriptRoot as the project root).

.PARAMETER Http
  Start the local HTTP dev server (node dist/http.js) instead of the stdio server.

.PARAMETER SkipBuild
  Reuse the existing dist/ artifact (skip npm run build).

.PARAMETER EnvFile
  Path to the env file to load (default: .env alongside this script).

.EXAMPLE
  ./start.ps1
  Build, load .env, launch the stdio server (the product transport).

.EXAMPLE
  ./start.ps1 -Http
  Build, load .env, launch the local HTTP dev server on $env:PORT (default 3000).

.EXAMPLE
  ./start.ps1 -SkipBuild -EnvFile .env.uat
  Reuse the current build and load creds from .env.uat.
#>
param(
  # Start the HTTP dev server (node dist/http.js) instead of the stdio server.
  [switch]$Http,

  # Reuse the existing dist/ build (skip npm run build).
  [switch]$SkipBuild,

  # Env file to load into the process environment.
  [string]$EnvFile = '.env'
)

$ErrorActionPreference = 'Stop'
$ProjectRoot = $PSScriptRoot
Push-Location $ProjectRoot
try {
  # --- Load .env into the process environment ---------------------------------
  $envPath = if ([System.IO.Path]::IsPathRooted($EnvFile)) { $EnvFile } else { Join-Path $ProjectRoot $EnvFile }
  if (Test-Path $envPath) {
    Write-Host "Loading env from $envPath ..." -ForegroundColor Cyan
    $loaded = 0
    foreach ($line in Get-Content -LiteralPath $envPath) {
      $trimmed = $line.Trim()
      if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
      # Allow an optional leading `export ` (shell-style .env files).
      $trimmed = $trimmed -replace '^\s*export\s+', ''
      $eq = $trimmed.IndexOf('=')
      if ($eq -lt 1) { continue }
      $name = $trimmed.Substring(0, $eq).Trim()
      $value = $trimmed.Substring($eq + 1).Trim()
      # Strip a single matching pair of surrounding quotes.
      if ($value.Length -ge 2 -and
          (($value.StartsWith('"') -and $value.EndsWith('"')) -or
           ($value.StartsWith("'") -and $value.EndsWith("'")))) {
        $value = $value.Substring(1, $value.Length - 2)
      }
      Set-Item -Path "Env:$name" -Value $value
      $loaded++
    }
    Write-Host "  loaded $loaded variable(s) (values not shown)" -ForegroundColor DarkGray
  } else {
    Write-Host "No env file at $envPath — relying on the current environment." -ForegroundColor Yellow
    Write-Host '  (copy .env.example to .env and fill it in for local development)' -ForegroundColor DarkGray
  }

  # --- Fail fast with an actionable message if required vars are missing ------
  $mode = if ($Http) { 'HTTP' } else { 'stdio' }
  $required = if ($Http) {
    @('MCP_PUBLIC_URL', 'CLOUDSEE_OAUTH_ISSUER')
  } else {
    @('CLOUDSEE_API_KEY_ID', 'CLOUDSEE_API_KEY_SECRET')
  }
  $missing = $required | Where-Object { -not (Test-Path "Env:$_") -or [string]::IsNullOrWhiteSpace((Get-Item "Env:$_").Value) }
  if ($missing) {
    throw ("Missing required env var(s) for $mode mode: {0}`n" -f ($missing -join ', ')) +
          'Set them in your .env (see .env.example) or the current shell.'
  }

  # --- Build ------------------------------------------------------------------
  if (-not $SkipBuild) {
    Write-Host 'Building (npm run build) ...' -ForegroundColor Cyan
    npm run build
    if ($LASTEXITCODE -ne 0) { throw 'npm run build failed' }
  }

  # --- Launch -----------------------------------------------------------------
  $entry = if ($Http) { 'dist/http.js' } else { 'dist/index.js' }
  if (-not (Test-Path (Join-Path $ProjectRoot $entry))) {
    throw "$entry not found — run without -SkipBuild to build it first."
  }

  if ($Http) {
    $port = if ($env:PORT) { $env:PORT } else { '3000' }
    Write-Host "Starting HTTP dev server (node $entry) on port $port ..." -ForegroundColor Green
  } else {
    Write-Host "Starting stdio server (node $entry) — speaks MCP over stdout, reads JSON-RPC on stdin." -ForegroundColor Green
    Write-Host '  (Ctrl+C to stop; normally an MCP client such as Claude Desktop launches this.)' -ForegroundColor DarkGray
  }
  node $entry
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
