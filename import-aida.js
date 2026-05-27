const fs = require("fs/promises");

const LOOKBACK_DAYS = 30;
const FORECAST_DAYS = 16;
const PORT_CACHE_FILE = "port-cache.json";

const PORT_NAME_OVERRIDES = {
  "ROM/CIVITAVECCHIA": "Civitavecchia",
  "FLORENZ/LA SPEZIA": "La Spezia",
  "PARIS/LE HAVRE": "Le Havre",
  "OLYMPIA/KATAKOLON": "Katakolon",
  "AJACCIO/KORSIKA": "Ajaccio",
  "SIZILIEN/CATANIA": "Catania",
  "WELTERBE-AURLANDSFJORD-PASSA": "Flåm",
  "AURLANDSFJORD-PASSAGE": "Flåm"
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
  return `https://aida.de/content/aida-search-and-booking/requests/search.singleCruise.json/size=20/sortCriteria=Date/sortDirection=Asc/pax[adults]=2/pax[juveniles]=0/pax[children]=0/pax[babies]=0/from=${from}/to=${to}.json`;
}

function getPortDate(port) {
  const dateTime = port.arrivalDateTime || port.departureDateTime;
  return dateTime ? dateTime.slice(0, 10) : null;
}

function prettyName(name) {
  if (!name) return null;

  return name
    .toLowerCase()
    .split("/")
    .map(part => part.trim())
    .map(part => part.charAt(0).toUpperCase() + part.slice(1))
    .join("/");
}

function geocodingName(name) {
  return PORT_NAME_OVERRIDES[name] || prettyName(name);
}

async function readPortCache() {
  try {
    const file = await fs.readFile(PORT_CACHE_FILE, "utf8");
    return JSON.parse(file);
  } catch {
    return {};
  }
}

async function writePortCache(cache) {
  await fs.writeFile(
    PORT_CACHE_FILE,
    JSON.stringify(cache, null, 2),
    "utf8"
  );
}

async function geocodePort(port, cache) {
  if (!port.name || port.code === "SEE") return null;

  if (cache[port.code]) {
    return cache[port.code];
  }

  const query = geocodingName(port.name);

  const url =
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}` +
    `&count=1&language=de&format=json`;

  console.log(`Geocoding: ${port.code} ${port.name} → ${query}`);

  const response = await fetch(url);

  if (!response.ok) {
    console.log(`Geocoding Fehler für ${port.code}`);
    return null;
  }

  const data = await response.json();
  const result = data.results?.[0];

  if (!result) {
    console.log(`Keine Koordinaten gefunden für ${port.code} ${port.name}`);
    return null;
  }

  const coords = {
    name: prettyName(port.name),
    query,
    lat: result.latitude,
    lon: result.longitude,
    countryCode: result.country_code || null,
    timezone: result.timezone || null
  };

  cache[port.code] = coords;
  await writePortCache(cache);

  return coords;
}

async function mapCruise(item, cache, todayString, forecastUntilString) {
  if (!item.startDate || !item.endDate) return null;

  const keepTrip =
    item.endDate >= todayString &&
    item.startDate <= forecastUntilString;

  if (!keepTrip) return null;

  const variant = item.cruiseItemVariant?.[0];
  const stops = [];

  for (const port of item.ports || []) {
    const date = getPortDate(port);

    if (!port.name) continue;
    if (!date) continue;
    if (port.code === "SEE") continue;

    // Bei aktiven Kreuzfahrten vergangene Ziele nicht mehr anzeigen
    if (date < todayString) continue;

    // Ziele außerhalb des Wetter-Forecast-Zeitraums nicht anzeigen
    if (date > forecastUntilString) continue;

    const coords = await geocodePort(port, cache);
    if (!coords) continue;

    stops.push({
      place: coords.name,
      date,
      portCode: port.code,
      lat: coords.lat,
      lon: coords.lon,
      arrivalDateTime: port.arrivalDateTime,
      departureDateTime: port.departureDateTime
    });
  }

  if (!stops.length) return null;

  return {
    year: item.startDate.slice(0, 4),
    ship:
      variant?.ship?.marketingName ||
      variant?.ship?.name ||
      "Unbekannt",
    date: item.startDate,
    endDate: item.endDate,
    title: item.title,
    duration: item.duration,
    journeyIdentifier: variant?.journeyIdentifier || null,
    bookingLink: variant?.bookingLink
      ? `https://aida.de${variant.bookingLink}`
      : null,
    pricePerPerson: variant?.amountPerPerson || null,
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
    const errorText = await response.text();
    console.log(errorText);
    throw new Error(`AIDA API Fehler ${response.status}: ${response.statusText}`);
  }

  return response.json();
}

async function main() {
  const today = new Date();

  const todayString = formatDate(today);
  const searchFromString = formatDate(addDays(today, -LOOKBACK_DAYS));
  const forecastUntilString = formatDate(addDays(today, FORECAST_DAYS));

  console.log(`Heute: ${todayString}`);
  console.log(`AIDA-Suche von ${searchFromString} bis ${forecastUntilString}`);

  const cache = await readPortCache();
  const data = await fetchTrips(searchFromString, forecastUntilString);

  const rawItems = data.cruiseItems || [];

  console.log("Gefundene AIDA-Reisen:", rawItems.length);

  const trips = [];

  for (const item of rawItems) {
    const trip = await mapCruise(
      item,
      cache,
      todayString,
      forecastUntilString
    );

    if (trip) trips.push(trip);
  }

  const uniqueTrips = Array.from(
    new Map(
      trips.map(trip => [
        trip.journeyIdentifier ||
          `${trip.ship}-${trip.date}-${trip.title}`,
        trip
      ])
    ).values()
  );

  uniqueTrips.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.ship.localeCompare(b.ship)
  );

  await fs.writeFile(
    "trips.json",
    JSON.stringify(uniqueTrips, null, 2),
    "utf8"
  );

  console.log(`${uniqueTrips.length} Reisen gespeichert in trips.json`);
  console.log(`Port-Cache gespeichert in ${PORT_CACHE_FILE}`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});