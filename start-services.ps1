$ErrorActionPreference = "Stop"
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node (Join-Path $rootDir "scripts/start-services.mjs") @args
exit $LASTEXITCODE
