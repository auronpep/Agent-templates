[CmdletBinding()]
param(
    [switch] $NoPush
)

$ErrorActionPreference = 'Stop'
$UpstreamBranch = 'main'
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path

Push-Location -LiteralPath $RepoRoot
try {
    $currentBranch = (& git branch --show-current).Trim()
    if ($currentBranch -ne 'main') {
        throw "Run this helper from private branch 'main'. Current branch: $currentBranch"
    }

    $dirty = & git status --porcelain
    if ($dirty) {
        throw "Working tree is not clean. Commit, stash, or discard local changes before updating."
    }

    $refspec = '+refs/heads/{0}:refs/remotes/upstream/{0}' -f $UpstreamBranch
    & git fetch upstream $refspec
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to fetch upstream/$UpstreamBranch."
    }

    & git merge --ff-only "upstream/$UpstreamBranch"
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to fast-forward private main from upstream/$UpstreamBranch."
    }

    if (-not $NoPush) {
        & git push origin main
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to push private main to origin."
        }
    }
}
finally {
    Pop-Location
}