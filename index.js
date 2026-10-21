(function () {
    "use strict";

    const CONFIG = window.WEATHER_CONFIG || {};
    const DIRECT_API_URL = "https://api.weatherapi.com/v1/current.json";

    const els = {
        form: document.getElementById("search-form"),
        input: document.getElementById("search-input"),
        button: document.querySelector(".search-btn"),
        status: document.getElementById("status"),
        city: document.querySelector(".city"),
        date: document.querySelector(".date"),
        temp: document.querySelector(".temp-val"),
        icon: document.querySelector(".icon"),
        iconName: document.querySelector(".iconName"),
        humidity: document.querySelector(".humidity-val"),
        wind: document.querySelector(".wind-val"),
    };

    let activeController = null;
    let hasSearched = false;

    function setStatus(message, type) {
        els.status.textContent = message || "";
        els.status.className = type ? "status " + type : "status";
    }

    function setLoading(loading) {
        document.body.classList.toggle("is-loading", loading);
        els.button.disabled = loading;
        els.form.setAttribute("aria-busy", String(loading));
    }

    function buildRequestUrl(query) {
        if (CONFIG.proxyUrl) {
            const base = CONFIG.proxyUrl.replace(/\?+$/, "");
            return base + "?q=" + encodeURIComponent(query);
        }

        const apiKey = (CONFIG.apiKey || "").trim();
        if (!apiKey) {
            throw new Error("No API key configured. Add one to config.js or set a proxyUrl.");
        }

        return DIRECT_API_URL + "?key=" + encodeURIComponent(apiKey) + "&q=" + encodeURIComponent(query);
    }

    function formatDate(localtime) {
        let date = localtime ? new Date(localtime.replace(" ", "T")) : new Date();
        if (Number.isNaN(date.getTime())) date = new Date();
        return date.toLocaleDateString(undefined, {
            weekday: "short",
            month: "long",
            day: "numeric",
            year: "numeric",
        });
    }

    function applyTheme(conditionText) {
        const text = (conditionText || "").toLowerCase();
        let theme = "theme-clouds";

        if (text.includes("thunder")) theme = "theme-storm";
        else if (text.includes("snow") || text.includes("sleet") || text.includes("blizzard") || text.includes("ice")) theme = "theme-snow";
        else if (text.includes("rain") || text.includes("drizzle") || text.includes("shower")) theme = "theme-rain";
        else if (text.includes("fog") || text.includes("mist")) theme = "theme-mist";
        else if (text.includes("cloud") || text.includes("overcast")) theme = "theme-clouds";
        else if (text.includes("sunny") || text.includes("clear")) theme = "theme-clear";

        document.body.classList.remove(
            "theme-clear", "theme-clouds", "theme-rain", "theme-storm", "theme-snow", "theme-mist"
        );
        document.body.classList.add(theme);
    }

    function renderWeather(data) {
        const location = data.location || {};
        const current = data.current || {};
        const condition = current.condition || {};

        els.city.textContent = [location.name, location.country].filter(Boolean).join(", ");
        els.date.textContent = formatDate(location.localtime);
        els.temp.textContent = Math.round(current.temp_c);
        els.humidity.textContent = Math.round(current.humidity) + "%";
        els.wind.textContent = Math.round(current.wind_kph) + " km/h";
        els.iconName.textContent = condition.text || "—";

        const iconUrl = condition.icon || "";
        if (iconUrl) {
            els.icon.src = iconUrl.indexOf("//") === 0 ? "https:" + iconUrl : iconUrl;
        } else {
            els.icon.removeAttribute("src");
        }
        els.icon.alt = condition.text ? "Weather icon: " + condition.text : "";

        applyTheme(condition.text);
        document.body.classList.add("has-data");
    }

    async function fetchWeather(query) {
        if (!query) return;

        if (activeController) activeController.abort();
        const controller = new AbortController();
        activeController = controller;

        setLoading(true);
        setStatus("Fetching weather…", "loading");

        try {
            const response = await fetch(buildRequestUrl(query), { signal: controller.signal });
            const data = await response.json().catch(function () { return {}; });

            if (!response.ok || data.error) {
                const message = data.error && data.error.message
                    ? data.error.message
                    : "Request failed (" + response.status + ").";
                throw new Error(message);
            }

            renderWeather(data);
            setStatus("", "");
        } catch (error) {
            if (error.name === "AbortError") return;
            setStatus(error.message || "Could not load the weather. Please try again.", "error");
        } finally {
            if (activeController === controller) {
                activeController = null;
                setLoading(false);
            }
        }
    }

    els.form.addEventListener("submit", function (event) {
        event.preventDefault();
        const query = els.input.value.trim();

        if (!query) {
            setStatus("Enter a city name to search.", "error");
            els.input.focus();
            return;
        }

        hasSearched = true;
        fetchWeather(query);
    });

    function loadInitialWeather() {
        const fallbackCity = (CONFIG.defaultCity || "").trim();

        if (!navigator.geolocation) {
            if (fallbackCity) fetchWeather(fallbackCity);
            else setStatus("Enter a city name to get started.", "");
            return;
        }

        setStatus("Detecting your location…", "loading");

        navigator.geolocation.getCurrentPosition(
            function (position) {
                if (hasSearched) return;
                const query = position.coords.latitude + "," + position.coords.longitude;
                fetchWeather(query);
            },
            function () {
                if (hasSearched) return;
                if (fallbackCity) fetchWeather(fallbackCity);
                else setStatus("Location unavailable. Search for a city instead.", "error");
            },
            { timeout: 8000, maximumAge: 600000 }
        );
    }

    els.date.textContent = formatDate();
    loadInitialWeather();
})();
