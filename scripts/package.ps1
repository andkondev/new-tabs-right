$ErrorActionPreference = "Stop"

$root = Resolve-Path (Join-Path $PSScriptRoot "..")
$manifest = Get-Content -LiteralPath (Join-Path $root "manifest.json") -Raw | ConvertFrom-Json
$version = $manifest.version
$dist = Join-Path $root "dist"
$stage = Join-Path $dist "extension-package"
$zip = Join-Path $dist "new-tabs-right-v$version.zip"

if (Test-Path -LiteralPath $stage) {
  Remove-Item -LiteralPath $stage -Recurse -Force
}

New-Item -ItemType Directory -Path $stage | Out-Null
New-Item -ItemType Directory -Path (Join-Path $stage "icons") | Out-Null

Copy-Item -LiteralPath (Join-Path $root "manifest.json") -Destination $stage
Copy-Item -LiteralPath (Join-Path $root "background.js") -Destination $stage
Copy-Item -Path (Join-Path $root "icons\*.png") -Destination (Join-Path $stage "icons")

if (Test-Path -LiteralPath $zip) {
  Remove-Item -LiteralPath $zip -Force
}

Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
Remove-Item -LiteralPath $stage -Recurse -Force

Write-Host "Wrote $zip"
