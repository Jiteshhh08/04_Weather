# Deploying the Weather App on AWS

The site is static (HTML/CSS/JS), so it runs on **S3 + CloudFront**. CloudFront is required for HTTPS because the app asks for the visitor's geolocation, which browsers only allow on secure origins.

The optional Lambda proxy in `backend/` keeps the WeatherAPI key off the browser. Without it, `config.js` ships your key to every visitor.

```
Browser ──HTTPS──> CloudFront (OAC) ──> S3 (private bucket)
   │
   └──GET /current?q=...──> API Gateway (HTTP API) ──> Lambda ──> WeatherAPI
```

---

## 0. Prerequisites

- An AWS account and an IAM user/role that can manage S3, CloudFront, ACM, Route 53, Lambda, API Gateway, CloudFormation and IAM.
- AWS CLI v2 configured for that account (`aws configure`).
- AWS SAM CLI (only if you deploy the proxy).
- A WeatherAPI key.

```powershell
winget install Amazon.AWSCLI
winget install Amazon.SAM-CLI
aws --version
sam --version
aws sts get-caller-identity   # confirms which account you're deploying to
```

> **Important:** rotate your WeatherAPI key first. The old key was committed in `index.js`, so treat it as public. Create a new key in the WeatherAPI dashboard.

**Local test before deploying:**

```powershell
python -m http.server 8000
# open http://localhost:8000 (geolocation works on localhost)
```

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

## 3. Deploy the API proxy (recommended)

The proxy takes the browser's `?q=` and calls WeatherAPI with the server-side key.

```powershell
cd backend
sam build
sam deploy --guided
```

Answers for `sam deploy --guided`:

| Prompt | Value |
| --- | --- |
| Stack name | `weather-proxy` |
| AWS Region | `us-east-1` (or your region) |
| Parameter `WeatherApiKey` | your new WeatherAPI key |
| Parameter `AllowedOrigin` | `https://dxxxxxxxxxxxxx.cloudfront.net` |
| Confirm changeset | `Y` |
| Allow SAM CLI IAM role creation | `Y` |
| Save arguments to config file | `Y` |

The stack output `ProxyUrl` looks like:

```
https://abc123def4.execute-api.us-east-1.amazonaws.com/current
```

Test it:

```powershell
Invoke-RestMethod "https://abc123def4.execute-api.us-east-1.amazonaws.com/current?q=London"
```

If you later add a custom domain, redeploy with `AllowedOrigin` set to `https://weather.example.com` and then update the browser cache (see step 7).

---

## 4. Point the frontend at the proxy

Edit `config.js`:

```js
window.WEATHER_CONFIG = {
    apiKey: "",
    proxyUrl: "https://abc123def4.execute-api.us-east-1.amazonaws.com/current",
    defaultCity: "Mumbai",
};
```

Only the public proxy URL ships to the browser. Verify no key remains:

```powershell
Select-String -Path *.js,*.html -Pattern "apiKey\s*:\s*\"[^\"]+\""
# should not match, or only match an empty apiKey
```

---

## 5. Upload the site and invalidate the cache

From the project root (the folder containing `index.html`):

```powershell
$BUCKET = "weather-app-1234567890"
$DIST_ID = "EXXXXXXXXXXXXX"

aws s3 sync . "s3://$BUCKET" --delete `
  --exclude "backend/*" `
  --exclude ".git/*" `
  --exclude "*.md" `
  --exclude "deploy.ps1"

aws cloudfront create-invalidation --distribution-id $DIST_ID --paths "/*"
```

Or use the included script:

```powershell
.\deploy.ps1 -Bucket $BUCKET -DistributionId $DIST_ID
```

Open `https://dxxxxxxxxxxxxx.cloudfront.net` and check:

- The card loads with the default city.
- Searching a city updates the card.
- The `config.js` response contains only the proxy URL.
- An invalid city shows an error message instead of a silent failure.

---

## 6. Custom domain (optional)

1. Request a certificate in **ACM in `us-east-1`** (CloudFront only accepts certificates from us-east-1) for `weather.example.com`.
2. Validate it with DNS (Route 53 can add the validation records automatically).
3. CloudFront → your distribution → **Edit** → add the alternate domain name `weather.example.com` and select the certificate.
4. Route 53 → your hosted zone → create an **A** record (alias) for `weather.example.com` pointing to the CloudFront distribution. Do the same for **AAAA** if you want IPv6.
5. Wait for the distribution to redeploy, then update the proxy's `AllowedOrigin` to `https://weather.example.com` and redeploy the stack.

---

## 7. Deploying updates

```powershell
.\deploy.ps1 -Bucket weather-app-1234567890 -DistributionId EXXXXXXXXXXXXX
```

`index.html` and `config.js` change often, so invalidating `/*` after each deploy is the simplest safe default. If you want fewer invalidations, add a separate cache behavior for `config.js` with a short TTL instead.

If you only changed Lambda code:

```powershell
cd backend
sam build
sam deploy
```

---

## 8. Optional CI/CD (GitHub Actions)

1. Create an IAM role trusted by GitHub OIDC (no long-lived keys) with S3 + CloudFront invalidation permissions.
2. Add `AWS_ROLE_ARN`, `BUCKET` and `DISTRIBUTION_ID` as repository variables.
3. On push to `main`, run `aws s3 sync` and `aws cloudfront create-invalidation`.

Do not commit `config.js` with a real API key. With the proxy in place it stays empty, so committing it is safe.

---

## 9. Cost and security notes

- **Cost:** S3 storage and CloudFront traffic for a small site are typically free-tier or a few cents per month. Lambda + HTTP API fit comfortably in the free tier. Invalidation requests beyond 1,000 paths/month are charged.
- **Secrets:** keep the WeatherAPI key only in the Lambda environment (or better, SSM Parameter Store/Secrets Manager). Never in `config.js` or the S3 bucket.
- **CORS:** `AllowedOrigin` should be your exact site origin, not `*`, in production.
- **Rate limiting:** enable an API Gateway usage plan/throttle if the site is public, and watch WeatherAPI quota.
- **Monitoring:** add an AWS Budgets alarm and optionally CloudWatch alarms for Lambda errors.
- **HTTPS:** always use CloudFront. The S3 website endpoint is HTTP-only and geolocation will not work there.
