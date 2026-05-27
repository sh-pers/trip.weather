const fs = require("fs/promises");
const { chromium } = require("playwright");

const URLS = [
  "https://aida.de/buchung/angebote/kreuzfahrten-mai"
];

const MONTHS = {
  Jan: "01", Januar: "01",
  Feb: "02", Februar: "02",
  Mär: "03", März: "03",
  Apr: "04", April: "04",
  Mai: "05",
  Jun: "06", Juni: "06",
  Jul: "07", Juli: "07",
  Aug: "08", August: "08",
  Sep: "09", September: "09",
  Okt: "10", Oktober: "10",
  Nov: "11", November: "11",
  Dez: "12", Dezember: "12"
};

const PORTS = {
  Kiel: { lat: 54.3233, lon: 10.1228 },
  Warnemünde: { lat: 54.1766, lon: 12.0956 },
  Mallorca: { lat: 39.5696, lon: 2.6502 },
  Barcelona: { lat: 41.3851, lon: 2.1734 },
  Korfu: { lat: 39.6243, lon: 19.9217 }
};

function toISODateFromShort(day, monthName, yearShort) {
  const dayPadded = String(day).padStart(2, "0");
  const month = MONTHS[monthName];
  const year = "20" + yearShort;
  return `${year}-${month}-${dayPadded}`;
}

function addDays(dateString, days) {
  const date = new Date(dateString + "T12:00:00");
  date.setDate(date.getDate() + days);
  return date.toISOString().slice(0, 10);
}

function cleanText(value) {
  return value.replace(/\s+/g, " ").trim();
}

async function main() {
  const browser = await chromium.launch({
    headless: false,
    slowMo: 150
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 }
  });

  const allTrips = [];

  for (const url of URLS) {
    console.log("Öffne:", url);

    await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 90000
    });

    await page.waitForTimeout(8000);

    const acceptButton = page.getByRole("button", {
      name: /akzeptieren|zustimmen|alle akzeptieren/i
    });

    if (await acceptButton.count()) {
      await acceptButton.first().click().catch(() => {});
      await page.waitForTimeout(3000);
    }

    await page.mouse.wheel(0, 5000);
    await page.waitForTimeout(3000);

    const bodyText = await page.locator("body").innerText();
    await fs.writeFile("aida-debug.txt", bodyText, "utf8");

    const blocks = bodyText
      .split("Frühbucher Plus")
      .map(block => block.trim())
      .filter(block =>
        block.includes("Schiff:") &&
        block.includes("Hafen:") &&
        block.includes("Reisedauer:")
      );

    for (const block of blocks) {
      const lines = block
        .split("\n")
        .map(line => line.trim())
        .filter(Boolean);

      const title = cleanText(lines[0] || "");
      const shipIndex = lines.indexOf("Schiff:");
      const portIndex = lines.indexOf("Hafen:");
      const durationIndex = lines.indexOf("Reisedauer:");

      if (shipIndex === -1 || portIndex === -1 || durationIndex === -1) continue;

      const ship = lines[shipIndex + 1];
      const portRaw = lines[portIndex + 1] || "";
      const fromCity = portRaw.replace("ab/bis", "").trim();

      const duration = Number(lines[durationIndex + 1]);
      if (!duration) continue;

      const dateMatch = block.match(/Verfügbare?s? Abreisedat(?:um|en)\s+(\d{2})\.\s+([A-Za-zäöüÄÖÜ]+)\s+(\d{2})/);

      if (!dateMatch) continue;

      const [, day, monthName, yearShort] = dateMatch;
      const startDate = toISODateFromShort(day, monthName, yearShort);
      const endDate = addDays(startDate, duration);

      const stops = [];

      if (PORTS[fromCity]) {
        stops.push({
          place: fromCity,
          date: startDate,
          ...PORTS[fromCity]
        });
      }

      allTrips.push({
        year: startDate.slice(0, 4),
        ship,
        date: startDate,
        endDate,
        title,
        fromCity,
        duration,
        stops
      });
    }
  }

  await browser.close();

  const uniqueTrips = Array.from(
    new Map(
      allTrips.map(trip => [
        `${trip.ship}-${trip.date}-${trip.title}-${trip.fromCity}`,
        trip
      ])
    ).values()
  );

  uniqueTrips.sort((a, b) =>
    a.date.localeCompare(b.date) ||
    a.ship.localeCompare(b.ship)
  );

  await fs.writeFile("trips.json", JSON.stringify(uniqueTrips, null, 2), "utf8");

  console.log(`${uniqueTrips.length} Reisen gespeichert in trips.json`);
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});