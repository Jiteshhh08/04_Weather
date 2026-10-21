param(
    [Parameter(Mandatory = $true)]
    [string]$AllowedOrigin,

    [string]$StackName = "weather-proxy",
    [string]$Region = "us-east-1",
    [string]$EnvFile
)

$ErrorActionPreference = "Stop"

if (-not $EnvFile) {
    $EnvFile = Join-Path $PSScriptRoot "..\.env"
}

$envPath = (Resolve-Path -LiteralPath $EnvFile).Path
$values = @{}

foreach ($rawLine in Get-Content -LiteralPath $envPath) {
    $line = $rawLine.Trim()
    if (-not $line -or $line.StartsWith("#")) { continue }

    $separator = $line.IndexOf("=")
    if ($separator -lt 1) { continue }

    $name = $line.Substring(0, $separator).Trim()
    $value = $line.Substring($separator + 1).Trim()

    if (($value.StartsWith('"') -and $value.EndsWith('"')) -or
        ($value.StartsWith("'") -and $value.EndsWith("'"))) {
        $value = $value.Substring(1, $value.Length - 2)
    }

    $values[$name] = $value
}

$apiKey = $values["WEATHER_API_KEY"]
if (-not $apiKey) {
    throw "WEATHER_API_KEY is missing from $envPath"
}

Push-Location $PSScriptRoot
try {
    sam build
    if ($LASTEXITCODE -ne 0) {
        throw "sam build failed with exit code $LASTEXITCODE"
    }

    sam deploy `
        --stack-name $StackName `
        --region $Region `
        --resolve-s3 `
        --capabilities CAPABILITY_IAM `
        --parameter-overrides "WeatherApiKey=$apiKey" "AllowedOrigin=$AllowedOrigin"

    if ($LASTEXITCODE -ne 0) {
        throw "sam deploy failed with exit code $LASTEXITCODE"
    }
}
finally {
    Pop-Location
}
