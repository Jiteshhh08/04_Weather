# Deploying the Weather App on AWS

The site is static (HTML/CSS/JS), so it runs on **S3 + CloudFront**. CloudFront is required for HTTPS because the app asks for the visitor's geolocation, which browsers only allow on secure origins.

The optional Lambda proxy in `backend/` keeps the WeatherAPI key off the browser. Without it, `config.js` ships your key to every visitor.

```
Browser ──HTTPS──> CloudFront (OAC) ──> S3 (private bucket)
   │
   └──GET /current?q=...──> API Gateway (HTTP API) ──> Lambda ──> WeatherAPI
```

## Configuration files

| File | Purpose | Committed? |
| --- | --- | --- |
| `.env` | Local/deploy secrets: `WEATHER_API_KEY`, `WEATHER_PROXY_URL`, `WEATHER_DEFAULT_CITY` | **No** (gitignored) |
| `.env.example` | Template for `.env` | Yes |
| `config.js` | Runtime config loaded by the browser; **generated** from `.env` | **No** (gitignored) |
| `scripts/generate-config.mjs` | Reads `.env` and writes `config.js` | Yes |

`config.js` always contains either the API key (local direct mode) or the proxy URL (production mode), never both:

- `WEATHER_PROXY_URL` empty → `config.js` contains `apiKey` (local development only).
- `WEATHER_PROXY_URL` set → `config.js` contains `proxyUrl` and an empty `apiKey`.

---

## 0. Prerequisites

- An AWS account and an IAM user/role that can manage S3, CloudFront, ACM, Route 53, Lambda, API Gateway, CloudFormation and IAM.
- AWS CLI v2 configured for that account (`aws configure`).
- Node.js 18+ (used to generate `config.js`).
- AWS SAM CLI (only if you deploy the proxy).
- A WeatherAPI key.

```powershell
winget install Amazon.AWSCLI
winget install Amazon.SAM-CLI
aws --version
sam --version
node --version
aws sts get-caller-identity   # confirms which account you're deploying to
```

> **Important:** rotate your WeatherAPI key first. The old key was committed in `index.js`, so treat it as public. Create a new key in the WeatherAPI dashboard.

Create your local environment file:

```powershell
Copy-Item .env.example .env
notepad .env
```

```dotenv
WEATHER_API_KEY=your-new-weather-api-key
WEATHER_PROXY_URL=
WEATHER_DEFAULT_CITY=Mumbai
```

`.env` and the generated `config.js` are in `.gitignore`. Never commit either one while it contains a real key.

**Local test:**

```powershell
node scripts/generate-config.mjs
python -m http.server 8000
# open http://localhost:8000 (geolocation works on localhost)
```

`generate-config.mjs` refuses to run if both `WEATHER_API_KEY` and `WEATHER_PROXY_URL` are empty.

---

## 1. Create a private S3 bucket

Bucket names are globally unique; replace `weather-app-1234567890` everywhere.

```powershell
$BUCKET = "weather-app-1234567890"
$REGION = "us-east-1"

aws s3 mb "s3://$BUCKET" --region $REGION

# Keep the bucket private; CloudFront will read it through OAC.
aws s3api put-public-access-block --bucket $BUCKET `
  --public-access-block-configuration "BlockPublicAcls=true,IgnorePublicAcls=true,BlockPublicPolicy=true,RestrictPublicBuckets=true"
```

Do **not** enable S3 static website hosting. CloudFront reads the bucket's REST endpoint.

---

## 2. Create the CloudFront distribution

In the AWS Console: **CloudFront → Create distribution**.

1. **Origin**
   - Origin domain: choose `weather-app-1234567890.s3.us-east-1.amazonaws.com` (the bucket's REST endpoint, not the website endpoint).
   - Origin access: **Origin access control settings (recommended)** → create a new control setting → sign requests.
2. **Default cache behavior**
   - Viewer protocol policy: **Redirect HTTP to HTTPS**.
   - Allowed HTTP methods: **GET, HEAD**.
   - Cache policy: `CachingOptimized`.
   - Compress objects automatically: **Yes**.
3. **Settings**
   - Default root object: `index.html`.
   - Price class: `Use only North America and Europe` (cheapest) or `All edge locations`.
4. Create the distribution.

After it is created, CloudFront shows a **bucket policy** you must apply. Copy it, then save/apply it as `bucket-policy.json`:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "AllowCloudFrontServicePrincipal",
      "Effect": "Allow",
      "Principal": { "Service": "cloudfront.amazonaws.com" },
      "Action": "s3:GetObject",
      "Resource": "arn:aws:s3:::weather-app-1234567890/*",
      "Condition": {
        "StringEquals": {
          "AWS:SourceArn": "arn:aws:cloudfront::YOUR_ACCOUNT_ID:distribution/YOUR_DISTRIBUTION_ID"
        }
      }
    }
  ]
}
```

```powershell
aws s3api put-bucket-policy --bucket $BUCKET --policy file://bucket-policy.json
```

Note the distribution domain (`dxxxxxxxxxxxxx.cloudfront.net`) and distribution ID (`EXXXXXXXXXXXXX`).

---

## 3. Deploy the API proxy

The proxy reads `WEATHER_API_KEY` from `.env` and passes it to Lambda as an environment variable.

```powershell
.\backend\deploy.ps1 -AllowedOrigin "https://dxxxxxxxxxxxxx.cloudfront.net"
```

Optional parameters: `-StackName weather-proxy`, `-Region us-east-1`, `-EnvFile .env`.

The script runs `sam build` and `sam deploy --resolve-s3 --capabilities CAPABILITY_IAM`, then prints the stack outputs. The `ProxyUrl` output looks like:

```
https://abc123def4.execute-api.us-east-1.amazonaws.com/current
```

Test it:

```powershell
Invoke-RestMethod "https://abc123def4.execute-api.us-east-1.amazonaws.com/current?q=London"
```

If you prefer the interactive flow:

```powershell
cd backend
sam build
sam deploy --guided
```

Enter `WeatherApiKey` from `.env`, set `AllowedOrigin` to the CloudFront domain, and allow SAM to create the IAM role. Do not commit `backend/samconfig.toml` if it stores the key.

---

## 4. Point the frontend at the proxy

Add the proxy URL to `.env`:

```dotenv
WEATHER_API_KEY=your-new-weather-api-key
WEATHER_PROXY_URL=https://abc123def4.execute-api.us-east-1.amazonaws.com/current
WEATHER_DEFAULT_CITY=Mumbai
```

Regenerate the browser config:

```powershell
node scripts/generate-config.mjs
```

`config.js` now contains the proxy URL and an empty `apiKey`. Verify that no key is left in browser assets:

```powershell
Select-String -Path config.js -Pattern "apiKey"
# expected: apiKey: ""
```

The key itself stays in `.env` only, because `backend/deploy.ps1` needs it for future proxy updates.

---

## 5. Upload the site and invalidate the cache

From the project root (the folder containing `index.html`):

```powershell
.\deploy.ps1 -Bucket weather-app-1234567890 -DistributionId EXXXXXXXXXXXXX
```

The script:

1. Regenerates `config.js` from `.env`.
2. Syncs the site to S3 (excludes `.env`, `backend/`, `scripts/`, docs and the script itself).
3. Invalidates `/*` in CloudFront.

To use a different env file: `.\deploy.ps1 -Bucket ... -DistributionId ... -EnvFile .env.production`.

Open `https://dxxxxxxxxxxxxx.cloudfront.net` and check:

- The card loads with the default city.
- Searching a city updates the card.
- An invalid city shows an error message instead of a silent failure.
- `https://dxxxxxxxxxxxxx.cloudfront.net/config.js` contains the proxy URL and no API key.
- `https://dxxxxxxxxxxxxx.cloudfront.net/.env` returns `403`.

---

## 6. Custom domain (optional)

1. Request a certificate in **ACM in `us-east-1`** (CloudFront only accepts certificates from us-east-1) for `weather.example.com`.
2. Validate it with DNS (Route 53 can add the validation records automatically).
3. CloudFront → your distribution → **Edit** → add the alternate domain name `weather.example.com` and select the certificate.
4. Route 53 → your hosted zone → create an **A** record (alias) for `weather.example.com` pointing to the CloudFront distribution. Do the same for **AAAA** if you want IPv6.
5. Wait for the distribution to redeploy, then update the proxy so CORS allows the new origin:

```powershell
.\backend\deploy.ps1 -AllowedOrigin "https://weather.example.com"
```

---

## 7. Deploying updates

```powershell
# Frontend (regenerates config.js, uploads, invalidates)
.\deploy.ps1 -Bucket weather-app-1234567890 -DistributionId EXXXXXXXXXXXXX
```

`index.html` and `config.js` change often, so invalidating `/*` after each deploy is the simplest safe default. If you want fewer invalidations, add a separate cache behavior for `config.js` with a short TTL instead.

Backend only:

```powershell
.\backend\deploy.ps1 -AllowedOrigin "https://dxxxxxxxxxxxxx.cloudfront.net"
```

After changing `WEATHER_API_KEY`, redeploy the proxy, then run the frontend deploy (the key is not part of the browser assets in proxy mode, so the second step is only needed if other config changed).

---

## 8. Optional CI/CD (GitHub Actions)

1. Create an IAM role trusted by GitHub OIDC (no long-lived keys) with S3 + CloudFront invalidation permissions.
2. Add `AWS_ROLE_ARN`, `BUCKET`, `DISTRIBUTION_ID` and `WEATHER_API_KEY` as repository secrets/variables.
3. In the workflow, recreate `.env` from secrets before deploying:

```yaml
- name: Write .env
  shell: bash
  run: |
    cat > .env <<EOF
    WEATHER_API_KEY=${{ secrets.WEATHER_API_KEY }}
    WEATHER_PROXY_URL=${{ vars.WEATHER_PROXY_URL }}
    WEATHER_DEFAULT_CITY=Mumbai
    EOF
- name: Deploy
  shell: pwsh
  run: .\deploy.ps1 -Bucket $env:BUCKET -DistributionId $env:DISTRIBUTION_ID
```

Do not commit `.env` or `config.js`. In proxy mode `config.js` contains no secrets; it is gitignored only because it is generated.

---

## 9. Cost and security notes

- **Cost:** S3 storage and CloudFront traffic for a small site are typically free-tier or a few cents per month. Lambda + HTTP API fit comfortably in the free tier. Invalidation requests beyond 1,000 paths/month are charged.
- **Secrets:** the WeatherAPI key lives in `.env` locally and in the Lambda environment after deployment. For stronger setups, store it in SSM Parameter Store or Secrets Manager and read it in the Lambda at runtime.
- **Local files:** `.env` and `config.js` are gitignored. Never commit them with real values, and rotate the key if either leaks.
- **CORS:** `AllowedOrigin` should be your exact site origin, not `*`, in production.
- **Rate limiting:** enable an API Gateway usage plan/throttle if the site is public, and watch WeatherAPI quota.
- **Monitoring:** add an AWS Budgets alarm and optionally CloudWatch alarms for Lambda errors.
- **HTTPS:** always use CloudFront. The S3 website endpoint is HTTP-only and geolocation will not work there.
