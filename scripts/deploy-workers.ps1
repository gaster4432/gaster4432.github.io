<#
.SYNOPSIS
    Deploys the Cloudflare Workers whose folders changed in the latest push.

.DESCRIPTION
    Runs on the host machine. No daemon, no GitHub-hosted runner, nothing
    polling in the background — the push hook starts it, it deploys, it exits.

    A "worker" is any top-level folder that carries a wrangler.toml. The
    folders that changed are taken from the diff between the commit that was
    on the branch before the push and the new head, so only the workers that
    were actually touched get redeployed.

    Wrangler runs under the user's own Cloudflare login (the OAuth token in
    %APPDATA%\xdg.config\.wrangler\config\default.toml), so no API token has
    to be stored anywhere.

.PARAMETER Base
    Git ref to diff against. Defaults to HEAD~1, i.e. only the commits that
    just landed. Use -Base origin/main to diff against the remote branch.

.PARAMETER All
    Deploy every worker in the repository, ignoring what changed.

.PARAMETER DryRun
    Print what would be deployed without deploying anything.

.EXAMPLE
    ./scripts/deploy-workers.ps1
    Deploys the workers changed by the most recent commit.

.EXAMPLE
    ./scripts/deploy-workers.ps1 -DryRun
    Shows which workers the next push would touch.

.EXAMPLE
    ./scripts/deploy-workers.ps1 -All
    Deploys every worker that has a wrangler.toml.
#>
[CmdletBinding()]
param(
    [string] $Base = '',
    [switch] $All,
    [switch] $DryRun
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$root = (& git rev-parse --show-toplevel 2>$null)
if (-not $root) {
    Write-Error 'Not inside a git repository.'
    exit 1
}
$root = $root.Trim()

Push-Location $root
try {
    $head = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Could not resolve HEAD.' }

    # ── Work out which folders changed ──
    if ($All) {
        $candidates = Get-ChildItem -Directory | Select-Object -ExpandProperty Name
        $changed = @()
    }
    else {
        $base = $Base
        if (-not $base) {
            $base = 'HEAD~1'
            & git rev-parse --verify --quiet 'HEAD~1' *> $null
            if ($LASTEXITCODE -ne 0) {
                # The branch has a single commit — everything is new.
                $base = $null
            }
        }
        elseif ($base) {
            & git rev-parse --verify --quiet $base *> $null
            if ($LASTEXITCODE -ne 0) { throw "Base ref '$base' does not exist." }
        }

        if ($null -eq $base) {
            $files = @(& git ls-tree -r --name-only $head)
        }
        else {
            $files = @(& git diff --name-only "$base" $head)
        }
        $changed = @($files | ForEach-Object { ($_ -split '/')[0] } | Where-Object { $_ } | Sort-Object -Unique)
    }

    # ── Keep only the folders that are actually workers ──
    $workers = @(
        foreach ($d in $changed) {
            $toml = Join-Path $d 'wrangler.toml'
            if (Test-Path -LiteralPath $toml) { $d }
        }
    )

    Write-Host ''
    Write-Host "  repo    : $root"
    Write-Host "  head    : $($head.Substring(0, 7))"
    if (-not $All) {
        Write-Host "  base    : $(if ($Base) { $Base } elseif ($null -eq $base) { '(new branch)' } else { 'HEAD~1' })"
        Write-Host "  changed : $(if ($changed.Count) { $changed -join ', ' } else { '(nothing)' })"
    }
    Write-Host "  workers : $(if ($workers.Count) { $workers -join ', ' } else { '(none)' })"
    Write-Host ''

    if ($workers.Count -eq 0) {
        Write-Host 'No worker changed — nothing to deploy.'
        exit 0
    }

    $failed = @()

    foreach ($w in $workers) {
        $name = (Select-String -Path (Join-Path $w 'wrangler.toml') -Pattern '^\s*name\s*=\s*"([^"]+)"' |
            Select-Object -First 1).Matches.Groups[1].Value
        if (-not $name) { $name = $w }

        Write-Host "=== $w  ->  worker '$name' ==="

        Push-Location $w
        try {
            if ($DryRun) {
                Write-Host "    [dry run] would run: npx wrangler deploy"
                continue
            }
            # --yes so npx never stops to ask whether it may install.
            & npx --yes wrangler deploy
            if ($LASTEXITCODE -ne 0) { $failed += $w }
        }
        catch {
            Write-Host "    deploy failed: $_" -ForegroundColor Red
            $failed += $w
        }
        finally {
            Pop-Location
        }
        Write-Host ''
    }

    if ($failed.Count -gt 0) {
        Write-Error "Deploy failed for: $($failed -join ', ')"
        exit 1
    }

    if ($DryRun) {
        Write-Host "Would deploy: $($workers -join ', ')"
        exit 0
    }

    Write-Host "Deployed: $($workers -join ', ')"
    exit 0
}
finally {
    Pop-Location
}
