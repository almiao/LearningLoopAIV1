$ErrorActionPreference = "Stop"
$rootDir = Split-Path -Parent $MyInvocation.MyCommand.Path
function Resolve-NodeRuntime {
  $candidates = @()

  if ($env:LEARNING_LOOP_NODE) {
    $candidates += $env:LEARNING_LOOP_NODE
  }

  $candidates += (Join-Path $rootDir ".tools\node-runtime\node.exe")

  foreach ($candidate in $candidates) {
    if (-not $candidate) {
      continue
    }

    if (Test-Path $candidate) {
      if ((Get-Item $candidate).PSIsContainer) {
        $nested = Join-Path $candidate "node.exe"
        if (Test-Path $nested) {
          return $nested
        }
      } else {
        return $candidate
      }
    }
  }

  return (Get-Command node -ErrorAction Stop).Source
}

$nodeRuntime = Resolve-NodeRuntime
& $nodeRuntime (Join-Path $rootDir "scripts/stop-services.mjs") @args
exit $LASTEXITCODE
