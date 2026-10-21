// Runtime configuration. This file is loaded before index.js.
//
// LOCAL DEVELOPMENT:
//   Put your WeatherAPI key in `apiKey`. It will be visible to anyone who
//   opens the deployed site, so only do this for local testing.
//
// PRODUCTION:
//   Deploy the Lambda proxy in `backend/` and paste its invoke URL into
//   `proxyUrl`, then clear `apiKey` so no secret ships to the browser.
window.WEATHER_CONFIG = {
    apiKey: "6d89973f1a6649f1877144317261803",
    proxyUrl: "",
    defaultCity: "Mumbai",
};
