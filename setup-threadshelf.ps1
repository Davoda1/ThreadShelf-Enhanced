# ThreadShelf Enhanced: project-local runtime; administrator rights not required.
[CmdletBinding()]
param(
    [string]$NodeVersion = '24.22.1',
    [string]$NpmVersion = '12.2.1',
    [switch]$Start,
    [switch]$RuntimeOnly
)
$ErrorActionPreference = 'Stop'
$Root = $PSScriptRoot
if ($env:THREADSHELF_NODE_VERSION -and -not $PSBoundParameters.ContainsKey('NodeVersion')) { $NodeVersion = $env:THREADSHELF_NODE_VERSION }
if ($env:THREADSHELF_NPM_VERSION -and -not $PSBoundParameters.ContainsKey('NpmVersion')) { $NpmVersion = $env:THREADSHELF_NPM_VERSION }
$NodeVersion = $NodeVersion -replace '^v', ''
if ($NodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid Node version.' }
if ($NpmVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Invalid npm version.' }
$Architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString().ToLowerInvariant()
if ($Architecture -notin @('x64', 'arm64')) { throw 'Supported Windows architectures: x64, arm64.' }
if ([Environment]::OSVersion.Platform -ne 'Win32NT') { throw 'Use setup-threadshelf.sh on Linux.' }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$Local = Join-Path $Root '.local'
New-Item -ItemType Directory -Force -Path $Local | Out-Null
$Folder = "node-v$NodeVersion-win-$Architecture"
$Runtime = Join-Path $Local $Folder
$Node = Join-Path $Runtime 'node.exe'
$CurrentVersion = if (Test-Path $Node) { & $Node --version } else { '' }
if ($CurrentVersion -ne "v$NodeVersion") {
    $Stage = Join-Path $Local ("node-download-" + [Guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $Stage | Out-Null
    try {
        $Archive = "$Folder.zip"
        $ArchivePath = Join-Path $Stage $Archive
        $Base = "https://nodejs.org/dist/v$NodeVersion"
        Invoke-WebRequest -UseBasicParsing -Uri "$Base/$Archive" -OutFile $ArchivePath
        $SumsPath = Join-Path $Stage 'SHASUMS256.txt'
        Invoke-WebRequest -UseBasicParsing -Uri "$Base/SHASUMS256.txt" -OutFile $SumsPath
        $Line = @(Get-Content $SumsPath | Where-Object { $_ -match ('^[a-fA-F0-9]{64}\s+' + [regex]::Escape($Archive) + '$') })
        if ($Line.Count -ne 1) { throw 'No unique official checksum found.' }
        $Expected = ($Line[0] -split '\s+')[0]
        if ((Get-FileHash -Algorithm SHA256 $ArchivePath).Hash -ne $Expected) { throw 'Node archive checksum mismatch.' }
        Expand-Archive -LiteralPath $ArchivePath -DestinationPath $Stage
        $StagedRuntime = Join-Path $Stage $Folder
        $StagedNode = Join-Path $StagedRuntime 'node.exe'
        if ((& $StagedNode --version) -ne "v$NodeVersion" -or $LASTEXITCODE -ne 0) { throw 'Downloaded Node cannot run on this system.' }
        if (Test-Path $Runtime) { Move-Item -LiteralPath $Runtime -Destination (Join-Path $Stage 'previous-runtime') }
        Move-Item -LiteralPath $StagedRuntime -Destination $Runtime
    } finally { Remove-Item -LiteralPath $Stage -Recurse -Force -ErrorAction SilentlyContinue }
}
$env:PATH = "$Runtime;$env:PATH"
if (-not $env:ONNXRUNTIME_NODE_INSTALL) { $env:ONNXRUNTIME_NODE_INSTALL = 'skip' }
$env:npm_config_cache = Join-Path $Local 'npm-cache'
# npm.cmd consults the configured prefix before choosing npm-cli.js. Keep an
# existing user/global npm installation from taking over this private runtime.
$env:npm_config_prefix = $Runtime
if (-not $env:XDG_CACHE_HOME) { $env:XDG_CACHE_HOME = Join-Path $Local 'cache' }
if (-not $env:HF_HOME) { $env:HF_HOME = Join-Path $Local 'huggingface' }
Push-Location $Root
try {
    $RunningVersion = (& $Node --version) -replace '^v', ''
    if ($LASTEXITCODE -ne 0 -or ([version]$RunningVersion).Major -lt 24) { throw 'Node 24 or newer required.' }
    $Npm = Join-Path $Runtime 'npm.cmd'
    $CurrentNpm = & $Npm --version
    if ($LASTEXITCODE -ne 0) { throw 'Bundled npm could not run.' }
    if ($CurrentNpm -ne $NpmVersion) {
        # --global is confined to this project-local prefix, never the OS.
        & $Npm install --global --prefix $Runtime "npm@$NpmVersion" --registry=https://registry.npmjs.org --engine-strict --ignore-scripts --no-audit --no-fund
        if ($LASTEXITCODE -ne 0) { throw 'Local npm installation failed.' }
    }
    $CurrentNpm = & $Npm --version
    if ($LASTEXITCODE -ne 0 -or $CurrentNpm -ne $NpmVersion) { throw 'Local npm version verification failed.' }
    Write-Host "Using Node v$RunningVersion and npm $CurrentNpm (project-local)"
    if ($RuntimeOnly) { Write-Host "Runtime ready: $Runtime"; return }
    if (-not (Test-Path 'package-lock.json')) { throw 'Run from the unpacked source release.' }
    if (-not (Test-Path '.env')) { Copy-Item '.env.example' '.env'; Write-Host 'Created .env; review HOST, PORT and ALLOWED_HOSTS.' }
    & $Npm ci --include=dev --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
    & $Npm run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
    Write-Host 'ThreadShelf Enhanced is ready. Start with: .\setup-threadshelf.ps1 -Start'
    if ($Start) {
        & $Node 'dist/src/server.js'
        if ($LASTEXITCODE -ne 0) { throw "Server exited with code $LASTEXITCODE" }
    }
} finally { Pop-Location }
