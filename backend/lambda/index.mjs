const WEATHER_API_URL = "https://api.weatherapi.com/v1/current.json";
const API_KEY = process.env.WEATHERAPI_KEY;
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";

function respond(statusCode, body) {
    return {
        statusCode,
        headers: {
            "content-type": "application/json",
            "access-control-allow-origin": ALLOWED_ORIGIN,
            "cache-control": "public, max-age=60",
        },
        body: JSON.stringify(body),
    };
}

export const handler = async (event) => {
    const query = event.queryStringParameters && event.queryStringParameters.q;

    if (!query || !query.trim()) {
        return respond(400, { error: { message: "Missing required query parameter: q" } });
    }

    if (!API_KEY) {
        console.error("WEATHERAPI_KEY environment variable is not set");
        return respond(500, { error: { message: "Weather service is not configured" } });
    }

    const url = WEATHER_API_URL + "?key=" + encodeURIComponent(API_KEY) + "&q=" + encodeURIComponent(query.trim());

    try {
        const upstream = await fetch(url);
        const data = await upstream.json();

        if (!upstream.ok || data.error) {
            return respond(upstream.ok ? 502 : upstream.status, data);
        }

        return respond(200, data);
    } catch (error) {
        console.error("Weather API request failed", error);
        return respond(502, { error: { message: "Could not reach the weather service" } });
    }
};
