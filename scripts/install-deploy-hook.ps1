<#
.SYNOPSIS
    Activates the push-triggered worker deploy on this machine.

.DESCRIPTION
    Points git at the versioned .githooks folder so the post-push hook in
    the repository runs on every push to main. Nothing is installed outside
    the repo and no background process is started — the hook runs during
    the push, deploys, and exits.

    Run this once per clone.

.EXAMPLE
    ./scripts/install-deploy-hook.ps1
#>
[CmdletBinding()]
param(
    [switch] $Uninstall
)

$ErrorActionPreference = 'Stop'

$root = (& git rev-parse --show-toplevel 2>$null)
if (-not $root) {
    Write-Error 'Not inside a git repository.'
    exit 1
}
$root = $root.Trim()

if ($Uninstall) {
    & git -C $root config --unset core.hooksPath
    Write-Host 'Deploy hook removed.'
    exit 0
}

$hook = Join-Path $root '.githooks\post-push'
if (-not (Test-Path -LiteralPath $hook)) {
    Write-Error "Missing $hook"
    exit 1
}

& git -C $root config core.hooksPath .githooks
if ($LASTEXITCODE -ne 0) { Write-Error 'Could not set core.hooksPath.'; exit 1 }

Write-Host ''
Write-Host 'Deploy hook installed.'
Write-Host ''
Write-Host "  hooks path : .githooks (relative to $root)"
Write-Host '  fires on   : push to main'
Write-Host '  does       : npx wrangler deploy in every changed worker folder'
Write-Host ''
Write-Host 'Preview it without deploying:'
Write-Host '    powershell -File scripts/deploy-workers.ps1 -DryRun'
Write-Host ''
Write-Host 'Push without deploying:'
Write-Host '    PKAX_SKIP_DEPLOY=1 git push'
Write-Host ''
Write-Host 'Remove it again:'
Write-Host '    powershell -File scripts/install-deploy-hook.ps1 -Uninstall'
