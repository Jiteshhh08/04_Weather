# Deploying the Weather App on AWS (Web Console)

This guide uses the **AWS Management Console** for every AWS step. No AWS CLI or SAM CLI is required.

The site is static (HTML/CSS/JS), so it runs on **S3 + CloudFront**. CloudFront is required for HTTPS because the app asks for the visitor's geolocation, which browsers only allow on secure origins.

The Lambda proxy keeps the WeatherAPI key off the browser. Without it, `config.js` ships your key to every visitor.

```
Browser ──HTTPS──> CloudFront (OAC) ──> S3 (private bucket)
   │
   └──GET /current?q=...──> API Gateway (HTTP API) ──> Lambda ──> WeatherAPI
```

> `backend/template.yaml`, `deploy.ps1` and `backend/deploy.ps1` are for CLI automation. You do not need them for this guide.

## Configuration files

| File | Purpose | Committed? |
| --- | --- | --- |
| `.env` | Local secrets/settings: `WEATHER_API_KEY`, `WEATHER_PROXY_URL`, `WEATHER_DEFAULT_CITY` | **No** (gitignored) |
| `.env.example` | Template for `.env` | Yes |
| `config.js` | Runtime config loaded by the browser; **generated** from `.env` | **No** (gitignored) |
| `scripts/generate-config.mjs` | Reads `.env` and writes `config.js` | Yes |

`config.js` contains either the API key (local direct mode) or the proxy URL (production mode), never both:

- `WEATHER_PROXY_URL` empty → `config.js` contains `apiKey` (local development only).
- `WEATHER_PROXY_URL` set → `config.js` contains `proxyUrl` and an empty `apiKey`.

`config.js` is generated **on your computer** and uploaded to S3. AWS never reads `.env`; the Lambda key is entered separately in the Lambda console (step 3).

---

## 0. Prerequisites

- An AWS account with console access (root or an IAM user with S3, CloudFront, Lambda, API Gateway, ACM and Route 53 permissions).
- **Node.js 18+** installed locally (only to generate `config.js`).
- A WeatherAPI key.

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

**Local test (optional):**

```powershell
node scripts/generate-config.mjs
python -m http.server 8000
# open http://localhost:8000 (geolocation works on localhost)
```

`generate-config.mjs` refuses to run if both `WEATHER_API_KEY` and `WEATHER_PROXY_URL` are empty.

**Region:** use the same region (for example `us-east-1`) for the S3 bucket, Lambda and API Gateway. CloudFront is global, and an ACM certificate for a custom domain must be requested in **us-east-1**.

---

## 1. Create a private S3 bucket

1. Open the **S3** console → **Create bucket**.
2. Bucket name: something globally unique, e.g. `weather-app-1234567890`.
3. AWS Region: your chosen region (e.g. `us-east-1`).
4. Object Ownership: **ACLs disabled (recommended)**.
5. **Block all public access: leave checked.** CloudFront will access the bucket privately.
6. Bucket Versioning: optional (useful for rollbacks).
7. Default encryption: **Server-side encryption with Amazon S3 managed keys (SSE-S3)**.
8. **Create bucket**.

Do **not** enable S3 static website hosting. CloudFront uses the bucket's REST endpoint.

---

## 2. Create the CloudFront distribution

1. Open the **CloudFront** console → **Create distribution**.
2. **Origin**
   - Origin domain: select your bucket, e.g. `weather-app-1234567890.s3.us-east-1.amazonaws.com` (the REST endpoint, **not** the website endpoint).
   - Origin access: **Origin access control settings (recommended)**.
   - Click **Create control setting**, keep the defaults, and save.
3. **Default cache behavior**
   - Viewer protocol policy: **Redirect HTTP to HTTPS**.
   - Allowed HTTP methods: **GET, HEAD**.
   - Cache policy: `CachingOptimized`.
   - Compress objects automatically: **Yes**.
4. **Settings**
   - Default root object: `index.html`.
   - Price class: `Use only North America and Europe` (cheaper) or `All edge locations`.
5. **Create distribution**.

After creation, CloudFront displays a warning that the S3 bucket needs a policy update. Click **Copy policy**.

In the **S3** console:

1. Open the bucket → **Permissions** → **Bucket policy** → **Edit**.
2. Paste the copied policy → **Save changes**.

If you need to recreate it manually, the policy looks like this (use your real account and distribution IDs):

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

Wait until the distribution status is **Deployed**. Note its domain, e.g. `https://dxxxxxxxxxxxxx.cloudfront.net`.

---

## 3. Create the Lambda proxy

1. Open the **Lambda** console → **Create function**.
2. Choose **Author from scratch**.
   - Function name: `weather-proxy`.
   - Runtime: **Node.js 22.x**.
   - Architecture: **x86_64**.
   - Permissions: **Create a new role with basic Lambda permissions**.
3. **Create function**.
4. In the **Code** tab, open `index.mjs` in the editor (the file is named `index.mjs` for Node.js 22).
5. Replace its contents with the entire contents of `backend/lambda/index.mjs` from this project.
6. Click **Deploy**.
7. Confirm **Runtime settings → Handler** is `index.handler`.
8. Open **Configuration → Environment variables → Edit** and add:

   | Key | Value |
   | --- | --- |
   | `WEATHERAPI_KEY` | your WeatherAPI key |
   | `ALLOWED_ORIGIN` | `https://dxxxxxxxxxxxxx.cloudfront.net` |

   No trailing slash on the origin. Save.
9. Optional: **Configuration → General configuration → Edit** → set **Timeout** to `10` seconds.

Test it in the console (optional):

1. **Test** tab → **Create new event**.
2. Name `weather-test`, replace the JSON with:

   ```json
   { "queryStringParameters": { "q": "London" } }
   ```

3. **Save** → **Test**. The response should have `statusCode: 200` and London weather data.

---

## 4. Create the HTTP API

1. Open the **API Gateway** console → **Create API** → **HTTP API** → **Build**.
2. API name: `weather-api`.
3. **Integrations** → **Add integration**:
   - Integration type: **Lambda**.
   - Lambda function: `weather-proxy` (same region).
   - Version: **2.0**.
4. **Configure routes**:
   - Method: **GET**.
   - Path: `/current`.
   - Integration target: the `weather-proxy` integration.
5. **Define stages**:
   - Stage name: `$default`.
   - Automatic deployment: **Enabled**.
6. **Create**.

On the API page, copy the **Invoke URL**, e.g.:

```
https://abc123def4.execute-api.us-east-1.amazonaws.com
```

Test in a browser:

```
https://abc123def4.execute-api.us-east-1.amazonaws.com/current?q=London
```

You should see raw weather JSON. Leave the API Gateway CORS settings untouched: the Lambda already returns `Access-Control-Allow-Origin` using `ALLOWED_ORIGIN`.

---

## 5. Generate `config.js` and upload the site

### 5.1 Point the browser at the proxy

Edit `.env`:

```dotenv
WEATHER_API_KEY=your-new-weather-api-key
WEATHER_PROXY_URL=https://abc123def4.execute-api.us-east-1.amazonaws.com/current
WEATHER_DEFAULT_CITY=Mumbai
```

Then generate the browser config on your computer:

```powershell
node scripts/generate-config.mjs
```

`config.js` now contains the proxy URL and an empty `apiKey`. Verify:

```powershell
Select-String -Path config.js -Pattern "apiKey"
# expected: "apiKey": "",
```

### 5.2 Upload files with the S3 console

1. Open the **S3** console → your bucket → **Objects** → **Upload**.
2. Click **Add files** and select exactly these four files from the project folder:

   - `index.html`
   - `index.css`
   - `index.js`
   - `config.js`

3. Leave permissions and storage classes at their defaults → **Upload**.

> **Do not upload the whole folder.** `.env`, `backend/`, `scripts/`, `DEPLOYMENT.md` and `deploy.ps1` must never be in the bucket. If you upload a folder, S3 uses the folder as a key prefix and the site will not load.

### 5.3 Invalidate the CloudFront cache

1. Open the **CloudFront** console → your distribution → **Invalidations** → **Create invalidation**.
2. Add object path: `/*`.
3. **Create invalidation**.

Wait a few minutes for the status to become **Completed**.

---

## 6. Verify the deployment

Open `https://dxxxxxxxxxxxxx.cloudfront.net` and check:

- The card loads with the default city (or your detected location if you allow geolocation).
- Searching a city updates the card.
- An invalid city shows a readable error message.
- `https://dxxxxxxxxxxxxx.cloudfront.net/config.js` shows the proxy URL and an empty `apiKey`.
- `https://dxxxxxxxxxxxxx.cloudfront.net/.env` returns **403 Access Denied**.
- `https://abc123def4.execute-api.us-east-1.amazonaws.com/current?q=London` returns JSON.

---

## 7. Custom domain (optional)

1. Open **Certificate Manager (ACM)**. Switch the region to **us-east-1** (CloudFront requires this).
2. **Request a certificate** → **Request a public certificate** for `weather.example.com`.
3. Validation method: **DNS validation**. If your domain is in Route 53, use **Create records in Route 53**; otherwise add the CNAME at your DNS provider.
4. Wait for the certificate status to be **Issued**.
5. Open the **CloudFront** console → your distribution → **Edit**:
   - **Alternate domain name (CNAME)**: add `weather.example.com`.
   - **Custom SSL certificate**: select the issued certificate.
   - Save and wait for **Deployed**.
6. Open **Route 53** → your hosted zone → **Create record**:
   - Record name: `weather` (or the full name).
   - Record type: **A**.
   - **Alias: on** → route traffic to **CloudFront distribution** → select your distribution.
   - Create. Repeat for an **AAAA** alias if you want IPv6.
7. In the **Lambda** console → `weather-proxy` → **Configuration → Environment variables** → set `ALLOWED_ORIGIN` to `https://weather.example.com` → **Save**.

No code redeploy is needed; the Lambda reads the environment variable on each invocation.

---

## 8. Deploying updates

**Frontend changes:**

1. If `.env` changed, run `node scripts/generate-config.mjs` again.
2. Open **S3** → bucket → **Upload** → add the changed files (for example `index.js`) → **Upload**. Uploading the same names overwrites the objects.
3. Open **CloudFront** → distribution → **Invalidations** → **Create invalidation** → `/*`.

**Lambda changes:**

1. Open **Lambda** → `weather-proxy` → **Code** tab → edit `index.mjs`.
2. **Deploy** → wait for "Changes deployed".

**API / key changes:**

- WeatherAPI key: update the Lambda environment variable `WEATHERAPI_KEY`; no frontend deploy needed.
- If you create a new API Gateway URL: update `WEATHER_PROXY_URL` in `.env`, run `node scripts/generate-config.mjs`, re-upload `config.js`, and invalidate `/*`.

> If you test locally after switching to proxy mode, the API only allows the CloudFront origin. For local testing, temporarily empty `WEATHER_PROXY_URL` in `.env` and run `node scripts/generate-config.mjs` again.

---

## 9. Cost and security notes

- **Cost:** S3 storage and CloudFront traffic for a small site are typically free-tier or a few cents per month. Lambda and HTTP API requests fit comfortably in the free tier. Invalidation requests beyond 1,000 paths/month are charged.
- **Secrets:** the WeatherAPI key lives in `.env` locally and in the Lambda environment in AWS. Never upload `.env` to S3. For stronger setups, store it in **SSM Parameter Store** or **Secrets Manager** and read it in the Lambda function.
- **Bucket privacy:** keep **Block all public access** enabled and allow only CloudFront through the bucket policy.
- **CORS:** `ALLOWED_ORIGIN` must match the site origin exactly (including `https://`, no trailing slash).
- **Local files:** `.env` and `config.js` are gitignored. Never commit them with real values, and rotate the key if either leaks.
- **Rate limiting:** API Gateway has default throttling, but you can add a usage plan if the site is public. Watch your WeatherAPI quota.
- **Monitoring:** add an AWS Budgets alarm, and optionally a CloudWatch alarm on Lambda errors.
- **HTTPS:** always serve through CloudFront. The S3 website endpoint is HTTP-only and geolocation will not work there.
