const fs = require("fs/promises");

const FORECAST_DAYS = 16;

const PORT_CACHE_FILE = "port-cache.json";
const TRIPS_FILE = "trips.json";

const PORT_NAME_OVERRIDES = {
  "ROM/CIVITAVECCHIA": "Civitavecchia",
  "FLORENZ/LA SPEZIA": "La Spezia",
  "PARIS/LE HAVRE": "Le Havre",
  "OLYMPIA/KATAKOLON": "Katakolon",
  "AJACCIO/KORSIKA": "Ajaccio",
  "SIZILIEN/CATANIA": "Catania",

  "SOUDA-BUCHT": "Souda",
  "KUSADASI": "Kuşadası",
  "ATHEN/PIRÄUS": "Piraeus",
  "DOVER/LONDON": "Dover",
  "PORTLAND, UK": "Portland Dorset",
  "ST.PETER PORT/GUERNSEY": "Saint Peter Port",
  "SEVILLA/CADIZ": "Cadiz",

  "WELTERBE-AURLANDSFJORD-PASSA": "Flåm",
  "AURLANDSFJORD-PASSAGE": "Flåm",

  "INNVIKFJORD-PASSAGE": null,
  "At Sea (Ship Parade)": null
};

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date, days) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function buildUrl(from, to) {
  return `https://aida.de/content/aida-search-and-booking/requests/search.singleCruise.json/size=50/sortCriteria=Price/sortDirection=Asc/pax[adults]=2/pax[juveniles]=0/pax[children]=0/pax[babies]=0/from=${from}/to=${to}.json`;
}

function getPortDate(port) {
  const dateTime =
    port.arrivalDateTime ||
    port.departureDateTime;

  return dateTime
    ? dateTime.slice(0, 10)
    : null;
}

function prettyName(name) {
  if (!name) return null;

  return name
    .toLowerCase()
    .split("/")
    .map(part => part.trim())
    .map(part =>
      part.charAt(0).toUpperCase() +
      part.slice(1)
    )
    .join("/");
}

function geocodingName(name) {
  if (
    Object.prototype.hasOwnProperty.call(
      PORT_NAME_OVERRIDES,
      name
    )
  ) {
    return PORT_NAME_OVERRIDES[name];
  }

  return prettyName(name);
}

async function readJsonFile(file, fallback) {
  try {
    const content = await fs.readFile(
      file,
      "utf8"
    );

    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

async function writeJsonFile(file, data) {
  await fs.writeFile(
    file,
    JSON.stringify(data, null, 2),
    "utf8"
  );
}

async function readPortCache() {
  return readJsonFile(
    PORT_CACHE_FILE,
    {}
  );
}

async function readExistingTrips() {
  return readJsonFile(
    TRIPS_FILE,
    []
  );
}

async function geocodePort(port, cache) {
  if (!port.name) return null;
  if (port.code === "SEE") return null;

  if (cache[port.code]) {
    return cache[port.code];
  }

  const query =
    geocodingName(port.name);

  if (!query) {
    console.log(
      `Überspringe ${port.code} ${port.name}`
    );

    return null;
  }

  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}` +
    `&count=1&language=de&format=json`;

  console.log(
    `Geocoding: ${port.code} ${port.name} → ${query}`
  );

  const response = await fetch(url);

  if (!response.ok) {
    console.log(
      `Geocoding Fehler für ${port.code}`
    );

    return null;
  }

  const data = await response.json();

  const result =
    data.results?.[0];

  if (!result) {
    console.log(
      `Keine Koordinaten gefunden für ${port.code} ${port.name}`
    );

    return null;
  }

  const coords = {
    name: prettyName(port.name),
    query,
    lat: result.latitude,
    lon: result.longitude,
    countryCode:
      result.country_code || null,
    timezone:
      result.timezone || null
  };

  cache[port.code] = coords;

  await writeJsonFile(
    PORT_CACHE_FILE,
    cache
  );

  return coords;
}

async function mapCruise(
  item,
  cache,
  todayString,
  forecastUntilString
) {
  if (!item.startDate) return null;
  if (!item.endDate) return null;

  const variant =
    item.cruiseItemVariant?.[0];

  const stops = [];

  for (const port of item.ports || []) {
    const date =
      getPortDate(port);

    if (!port.name) continue;
    if (!date) continue;
    if (port.code === "SEE") continue;

    // vergangene Stopps ausblenden
    if (date < todayString) continue;

    // nur Forecast-Zeitraum
    if (date > forecastUntilString) continue;

    const coords =
      await geocodePort(port, cache);

    if (!coords) continue;

    stops.push({
      place: coords.name,
      date,
      portCode: port.code,
      lat: coords.lat,
      lon: coords.lon,
      arrivalDateTime:
        port.arrivalDateTime,
      departureDateTime:
        port.departureDateTime
    });
  }

  return {
    year:
      item.startDate.slice(0, 4),

    ship:
      variant?.ship?.marketingName ||
      variant?.ship?.name ||
      "Unbekannt",

    date: item.startDate,
    endDate: item.endDate,

    title: item.title,
    duration: item.duration,

    journeyIdentifier:
      variant?.journeyIdentifier ||
      `${item.startDate}-${item.title}`,

    bookingLink:
      variant?.bookingLink
        ? `https://aida.de${variant.bookingLink}`
        : null,

    pricePerPerson:
      variant?.amountPerPerson ||
      null,

    stops
  };
}

async function fetchTrips(from, to) {
  const url = buildUrl(from, to);

  console.log("Lade AIDA:");
  console.log(url);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0"
    }
  });

  if (!response.ok) {
    const errorText =
      await response.text();

    console.log(errorText);

    throw new Error(
      `AIDA API Fehler ${response.status}: ${response.statusText}`
    );
  }

  return response.json();
}

function mergeTrips(
  existingTrips,
  newTrips
) {
  const map = new Map();

  for (const trip of existingTrips) {
    map.set(
      trip.journeyIdentifier,
      trip
    );
  }

  for (const trip of newTrips) {
    map.set(
      trip.journeyIdentifier,
      trip
    );
  }

  return Array.from(
    map.values()
  );
}

function cleanupTrips(
  trips,
  todayString,
  forecastUntilString
) {
  return trips

    // Reise noch aktiv?
    .filter(trip =>
      trip.endDate >= todayString
    )

    // Nur relevante Stopps
    .map(trip => ({
      ...trip,
      stops: (trip.stops || [])
        .filter(stop =>
          stop.date >= todayString &&
          stop.date <= forecastUntilString
        )
    }))

    // Reise noch sichtbar?
    .filter(trip =>
      trip.stops.length > 0
    );
}

async function main() {
  const today = new Date();

  const todayString =
    formatDate(today);

  const forecastUntilString =
    formatDate(
      addDays(
        today,
        FORECAST_DAYS
      )
    );

  console.log(
    `Heute: ${todayString}`
  );

  console.log(
    `Forecast bis ${forecastUntilString}`
  );

  const cache =
    await readPortCache();

  const existingTrips =
    await readExistingTrips();

  console.log(
    `Bereits gespeichert: ${existingTrips.length}`
  );

  const data =
    await fetchTrips(
      todayString,
      forecastUntilString
    );

  const rawItems =
    data.cruiseItems || [];

  console.log(
    `Neue Roh-Reisen: ${rawItems.length}`
  );

  console.log(
    `resultsTotal: ${data.resultsTotal}`
  );

  console.log(
    `totalPages: ${data.totalPages}`
  );

  const newTrips = [];

  for (const item of rawItems) {
    const trip =
      await mapCruise(
        item,
        cache,
        todayString,
        forecastUntilString
      );

    if (trip) {
      newTrips.push(trip);
    }
  }

  console.log(
    `Neue gemappte Reisen: ${newTrips.length}`
  );

  const mergedTrips =
    mergeTrips(
      existingTrips,
      newTrips
    );

  const cleanedTrips =
    cleanupTrips(
      mergedTrips,
      todayString,
      forecastUntilString
    );

  cleanedTrips.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.ship.localeCompare(b.ship)
  );

  await writeJsonFile(
    TRIPS_FILE,
    cleanedTrips
  );

  console.log(
    `${cleanedTrips.length} Reisen gespeichert`
  );

  console.log(
    `Port-Cache gespeichert in ${PORT_CACHE_FILE}`
  );
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});