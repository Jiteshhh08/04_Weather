param(
    [Parameter(Mandatory = $true)]
    [string]$Bucket,

    [Parameter(Mandatory = $true)]
    [string]$DistributionId,

    [string]$EnvFile = ".env"
)

$ErrorActionPreference = "Stop"

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js is required to generate config.js from .env"
}

node "$PSScriptRoot\scripts\generate-config.mjs" $EnvFile

if ($LASTEXITCODE -ne 0) {
    throw "Failed to generate config.js with exit code $LASTEXITCODE"
}

aws s3 sync $PSScriptRoot "s3://$Bucket" --delete `
    --exclude ".env" `
    --exclude ".env.*" `
    --exclude ".git/*" `
    --exclude ".gitignore" `
    --exclude "backend/*" `
    --exclude "scripts/*" `
    --exclude "node_modules/*" `
    --exclude "bucket-policy.json" `
    --exclude "*.md" `
    --exclude "deploy.ps1"

if ($LASTEXITCODE -ne 0) {
    throw "S3 sync failed with exit code $LASTEXITCODE"
}

aws cloudfront create-invalidation --distribution-id $DistributionId --paths "/*"

if ($LASTEXITCODE -ne 0) {
    throw "CloudFront invalidation failed with exit code $LASTEXITCODE"
}

Write-Output "Deployed to s3://$Bucket and invalidated $DistributionId"
