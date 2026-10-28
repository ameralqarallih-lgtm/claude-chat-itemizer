# Publishes a release of Claude Chat Itemizer:
#   1. pushes main and the version tag to Azure DevOps (remote "azure") and GitHub (remote "origin"),
#   2. creates the GitHub repository first if it does not exist (public),
#   3. creates the GitHub release vX.Y.Z with the VSIX attached and the CHANGELOG entry as its notes.
#
# Needs the GitHub CLI, signed in:  winget install GitHub.cli ; gh auth login
# Run from the repository root:     pwsh scripts/release.ps1
# The version comes from packages/vscode-extension/package.json.

$ErrorActionPreference = 'Stop'
Set-Location (Split-Path $PSScriptRoot -Parent)

$repo = 'ameralqarallih-lgtm/claude-chat-itemizer'
$version = (Get-Content packages/vscode-extension/package.json -Raw | ConvertFrom-Json).version
$tag = "v$version"
$vsix = "claude-chat-itemizer-$version.vsix"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
  throw 'The GitHub CLI is not installed. Run: winget install GitHub.cli ; gh auth login'
}
gh auth status | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'The GitHub CLI is not signed in. Run: gh auth login' }

if (git status --porcelain) { throw 'Commit or stash your changes first.' }

Write-Host "Building $vsix ..."
npm run package
if ($LASTEXITCODE -ne 0) { throw 'npm run package failed.' }
Copy-Item claude-chat-itemizer.vsix $vsix -Force

if (-not (git tag --list $tag)) { git tag -a $tag -m "Claude Chat Itemizer $version" }

Write-Host 'Pushing to Azure DevOps ...'
git push -u azure main
git push azure $tag

gh repo view $repo *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "Creating github.com/$repo ..."
  gh repo create $repo --public --description 'Queue Claude Code prompts as chat items with their own attachments, model and effort, and send them into Claude Code chats in VS Code.' --homepage "https://github.com/$repo#readme"
}
Write-Host 'Pushing to GitHub ...'
git push -u origin main
git push origin $tag
gh repo edit $repo --add-topic claude-code --add-topic vscode-extension --add-topic claude-code-plugin --add-topic anthropic --add-topic prompts

# Release notes: this version's section of the CHANGELOG.
$changelog = Get-Content CHANGELOG.md -Raw
$section = [regex]::Match($changelog, "(?ms)^## $([regex]::Escape($version)).*?(?=^## |\z)").Value
$notesFile = New-TemporaryFile
@"
$($section.Trim())

## Install

1. Download **$vsix** below and install it: ``code --install-extension $vsix``
2. Open the **Chat Itemizer** view and click **Set Up Claude Bridge**, then open a new Claude tab.

Full guide: https://github.com/$repo#readme
"@ | Set-Content $notesFile -Encoding utf8

gh release view $tag --repo $repo *> $null
if ($LASTEXITCODE -eq 0) {
  gh release upload $tag $vsix --repo $repo --clobber
} else {
  gh release create $tag $vsix --repo $repo --title "Claude Chat Itemizer $version" --notes-file $notesFile --latest
}
Remove-Item $notesFile
Write-Host "Done: https://github.com/$repo/releases/tag/$tag"
