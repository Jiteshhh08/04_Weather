param(
    [Parameter(Mandatory = $true)]
    [string]$Bucket,

    [Parameter(Mandatory = $true)]
    [string]$DistributionId
)

$ErrorActionPreference = "Stop"

aws s3 sync $PSScriptRoot "s3://$Bucket" --delete `
    --exclude "backend/*" `
    --exclude ".git/*" `
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
