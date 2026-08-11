<#
.SYNOPSIS
  Build, verify and pack the CloudSee Drive MCP server as a Claude Desktop extension (.mcpb).

.DESCRIPTION
  Wraps `npm run build:mcpb` with the checks worth running before handing a bundle to anyone.
  The packing step itself is just the npm script; what this adds is verification:

    1. Preflight        node / npm present, dependencies installed
    2. Quality gates    lint · typecheck · tests            (skip with -SkipChecks)
    3. Build + pack     tsup → build/mcpb/ → .mcpb          (manifest validated by the MCPB CLI)
    4. Smoke the ARTIFACT, not the source — the staged bundle is copied to an empty temp
       directory and started there with every optional setting blank. That is the closest
       thing to what a user's machine does on install, and it catches the two failures this
       packaging shape actually produces:
         · a dependency that did not get inlined (there is no node_modules to fall back on)
         · a blank optional value rejected by config validation, which would kill first launch
    5. Report           path, size, SHA-256, tool count, and whether an icon is present

.PARAMETER SkipChecks
  Skip lint / typecheck / tests. For a quick local rebuild only — never for a bundle you share.

.PARAMETER Open
  Reveal the finished .mcpb in Explorer.

.EXAMPLE
  ./pack-mcpb.ps1
.EXAMPLE
  ./pack-mcpb.ps1 -SkipChecks -Open
#>
#requires -Version 5.1
[CmdletBinding()]
param(
  [switch]$SkipChecks,
  [switch]$Open
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Write-Step { param([string]$Text) Write-Host "`n==> $Text" -ForegroundColor Cyan }
function Write-Ok   { param([string]$Text) Write-Host "    [ok]   $Text" -ForegroundColor Green }
function Write-Warn { param([string]$Text) Write-Host "    [warn] $Text" -ForegroundColor Yellow }
function Write-Info { param([string]$Text) Write-Host "    $Text" -ForegroundColor DarkGray }

# Windows PowerShell 5.1 wraps every stderr line from a native command in an ErrorRecord, so
# with $ErrorActionPreference='Stop' a tool that merely LOGS to stderr aborts the script — the
# test run does exactly that. Drop to 'Continue' for the call and judge it by its exit code,
# which is the only reliable signal anyway. Cmdlet errors keep stopping the script.
function Invoke-Native {
  param([string]$File, [string[]]$Arguments)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try { & $File @Arguments } finally { $ErrorActionPreference = $previous }
}

function Invoke-Step {
  param([string]$Label, [string[]]$NpmArgs)
  Write-Info "npm $($NpmArgs -join ' ')"
  Invoke-Native -File 'npm' -Arguments $NpmArgs
  if ($LASTEXITCODE -ne 0) { throw "$Label failed (exit $LASTEXITCODE)." }
  Write-Ok $Label
}

# ---------------------------------------------------------------------------
Write-Step 'Preflight'

foreach ($tool in @('node', 'npm')) {
  $cmd = Get-Command $tool -ErrorAction SilentlyContinue
  if (-not $cmd) { throw "$tool not found on PATH." }
  Write-Ok "$tool -> $($cmd.Source)"
}

if (-not (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'node_modules'))) {
  Write-Info 'node_modules missing -- npm install'
  Invoke-Native -File 'npm' -Arguments @('install')
  if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)." }
}

$pkg = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'package.json') -Raw | ConvertFrom-Json
$manifest = Get-Content -LiteralPath (Join-Path $PSScriptRoot 'manifest.json') -Raw | ConvertFrom-Json
Write-Ok "package $($pkg.version) | manifest $($manifest.version)"
if ($pkg.version -ne $manifest.version) {
  throw "manifest.json ($($manifest.version)) and package.json ($($pkg.version)) disagree. Update manifest.json first."
}

# ---------------------------------------------------------------------------
if ($SkipChecks) {
  Write-Step 'Skipping lint / typecheck / tests (-SkipChecks)'
  Write-Warn 'Do not share a bundle built this way.'
} else {
  Write-Step 'Quality gates'
  Invoke-Step -Label 'lint'      -NpmArgs @('run', 'lint', '--silent')
  Invoke-Step -Label 'typecheck' -NpmArgs @('run', 'typecheck', '--silent')
  Invoke-Step -Label 'tests'     -NpmArgs @('test', '--silent')
}

# ---------------------------------------------------------------------------
Write-Step 'Build and pack'
Invoke-Native -File 'npm' -Arguments @('run', 'build:mcpb')
if ($LASTEXITCODE -ne 0) { throw "build:mcpb failed (exit $LASTEXITCODE)." }

$bundle = Join-Path $PSScriptRoot "build\$($manifest.name)-$($manifest.version).mcpb"
if (-not (Test-Path -LiteralPath $bundle)) {
  throw "Packing produced no archive at $bundle. Is the MCPB CLI reachable (npm i -g @anthropic-ai/mcpb)?"
}
Write-Ok "packed $(Split-Path -Leaf $bundle)"

# ---------------------------------------------------------------------------
Write-Step 'Smoke the packaged bundle in isolation'

$staged = Join-Path $PSScriptRoot 'build\mcpb'
$sandbox = Join-Path ([System.IO.Path]::GetTempPath()) ("mcpb-smoke-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
$stderrLog = Join-Path $sandbox 'stderr.log'
$toolCount = 0

try {
  $null = New-Item -ItemType Directory -Path $sandbox -Force
  Copy-Item -Path (Join-Path $staged '*') -Destination $sandbox -Recurse -Force
  Write-Info "sandbox $sandbox (nothing else in it -- no node_modules to fall back on)"

  Push-Location $sandbox
  try {
    # Required credentials are placeholders: tools/list makes no API call. Every OPTIONAL
    # value is blank on purpose -- that is what MCPB substitutes when a user leaves the
    # field empty, and it used to stop the server from starting at all.
    $env:CLOUDSEE_API_KEY_ID = 'smoke-key-id'
    $env:CLOUDSEE_API_KEY_SECRET = 'smoke-key-secret'
    $env:CLOUDSEE_API_BASE_URL = ''
    $env:CLOUDSEE_DEFAULT_BUCKET = ''
    $env:CLOUDSEE_LOG_LEVEL = ''

    $handshake = @(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"pack-mcpb","version":"1"}}}',
      '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'
    )
    # Piped stdin is safe here; PowerShell only mangles quotes in native-command ARGUMENTS.
    # The server logs to stderr, so keep EAP off for this call too (see Invoke-Native).
    $previousEap = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
      $stdout = $handshake | & node 'server/index.js' 2>$stderrLog
    } finally {
      $ErrorActionPreference = $previousEap
    }

    foreach ($line in $stdout) {
      if ([string]::IsNullOrWhiteSpace($line)) { continue }
      $msg = $null
      try { $msg = $line | ConvertFrom-Json } catch { continue }
      if ($msg.id -eq 1 -and $msg.result.serverInfo) {
        Write-Ok "handshake $($msg.result.serverInfo.name) v$($msg.result.serverInfo.version)"
        if ($msg.result.serverInfo.version -ne $pkg.version) {
          throw "The bundle announces v$($msg.result.serverInfo.version) but the package is $($pkg.version)."
        }
      }
      if ($msg.id -eq 2 -and $msg.result.tools) { $toolCount = @($msg.result.tools).Count }
    }
  } finally {
    Pop-Location
    Remove-Item Env:CLOUDSEE_API_KEY_ID, Env:CLOUDSEE_API_KEY_SECRET, Env:CLOUDSEE_API_BASE_URL,
      Env:CLOUDSEE_DEFAULT_BUCKET, Env:CLOUDSEE_LOG_LEVEL -ErrorAction SilentlyContinue
  }

  if ($toolCount -lt 1) {
    if (Test-Path -LiteralPath $stderrLog) {
      Write-Warn 'The bundle produced no tool list. Its stderr:'
      Get-Content -LiteralPath $stderrLog | Select-Object -First 20 | ForEach-Object { Write-Info $_ }
    }
    throw 'The packaged bundle did not start, or listed no tools.'
  }
  Write-Ok "$toolCount tools registered with every optional setting blank"
} finally {
  Remove-Item -LiteralPath $sandbox -Recurse -Force -ErrorAction SilentlyContinue
}

# ---------------------------------------------------------------------------
Write-Step 'Result'

$info = Get-Item -LiteralPath $bundle
$hash = (Get-FileHash -LiteralPath $bundle -Algorithm SHA256).Hash

Write-Host ''
Write-Host "  $bundle" -ForegroundColor White
Write-Host ("  {0:N0} KB | {1} tools | SHA-256 {2}" -f ($info.Length / 1KB), $toolCount, $hash.Substring(0, 16).ToLower())
Write-Host ''

if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'icon.png')) {
  Write-Ok 'icon.png included'
} else {
  Write-Warn 'No icon.png - a directory listing needs one. Drop a square PNG next to package.json and re-run.'
}

Write-Host ''
Write-Host '  To install: open the .mcpb with Claude Desktop, or Settings -> Extensions -> Install from file.'
Write-Host '  First remove any hand-written cloudsee-drive entry from claude_desktop_config.json -' -ForegroundColor DarkGray
Write-Host '  two servers exposing the same tool names will collide.' -ForegroundColor DarkGray
Write-Host ''

if ($Open) { Start-Process explorer.exe "/select,`"$bundle`"" }
