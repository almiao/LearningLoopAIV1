$ErrorActionPreference = "Stop"
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $rootDir "scripts/stop-services.mjs") @args
exit $LASTEXITCODE
