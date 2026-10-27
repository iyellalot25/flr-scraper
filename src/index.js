const fs = require("node:fs/promises");
const path = require("node:path");
const cheerio = require("cheerio");

const START_URL = "https://books.toscrape.com/";
const USER_AGENT =
  "FlyRankInternship-A9/1.0 (+https://github.com/iyellalot25/flr-scraper)";
const TIMEOUT_MS = 10_000;
const MIN_DELAY_MS = 500;
const MAX_CATALOGUE_PAGES = 3;

const CACHE_DIR = path.resolve(__dirname, "../cache");

let lastRequestStartedAt = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithCache(url, cacheFile) {
  const cachePath = path.join(CACHE_DIR, cacheFile);

  // Reuse cached HTML without making a network request.
  try {
    const html = await fs.readFile(cachePath, "utf8");

    console.log(`CACHE HIT ${cacheFile}`);
    console.log(`response_size_bytes=${Buffer.byteLength(html, "utf8")}`);

    return html;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  // Enforce at least 500 ms between real request start times.
  const elapsed = Date.now() - lastRequestStartedAt;
  const waitMs = Math.max(0, MIN_DELAY_MS - elapsed);

  if (waitMs > 0) {
    await sleep(waitMs);
  }

  console.log(`FETCH ${url}`);

  lastRequestStartedAt = Date.now();

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // Only a successful HTTP 200 response can enter the cache.
  if (response.status !== 200) {
    await response.body?.cancel();

    throw new Error(
      `HTTP ${response.status} ${response.statusText} for ${url}`,
    );
  }

  const html = await response.text();
  const sizeBytes = Buffer.byteLength(html, "utf8");

  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(cachePath, html, "utf8");

  console.log(`status=${response.status}`);
  console.log(`response_size_bytes=${sizeBytes}`);
  console.log(`cached_file=${cacheFile}`);

  return html;
}

async function discoverCatalogue() {
  const bookUrls = new Set();
  let currentUrl = START_URL;
  let discovered = 0;
  let cataloguePages = 0;

  while (currentUrl && cataloguePages < MAX_CATALOGUE_PAGES) {
    cataloguePages++;

    const cacheFile = `catalogue-page-${cataloguePages}.html`;
    const html = await fetchWithCache(currentUrl, cacheFile);
    const $ = cheerio.load(html);

    // Extract book links only from catalogue product cards.
    $(".product_pod h3 a").each((_, element) => {
      const href = $(element).attr("href");

      if (!href) {
        return;
      }

      discovered++;

      // Resolve relative URLs using the current catalogue URL.
      const absoluteUrl = new URL(href, currentUrl).href;
      bookUrls.add(absoluteUrl);
    });

    console.log(
      `catalogue_page=${cataloguePages} books_found=${$(".product_pod h3 a").length}`,
    );

    if (cataloguePages === MAX_CATALOGUE_PAGES) {
      break;
    }

    // Follow the site's own next-page link.
    const nextHref = $("li.next a").attr("href");

    if (!nextHref) {
      throw new Error(
        `Missing next-page link after catalogue page ${cataloguePages}`,
      );
    }

    currentUrl = new URL(nextHref, currentUrl).href;
  }

  if (cataloguePages !== MAX_CATALOGUE_PAGES) {
    throw new Error(
      `Expected ${MAX_CATALOGUE_PAGES} catalogue pages, found ${cataloguePages}`,
    );
  }

  console.log("\n--- Catalogue discovery summary ---");
  console.log(`catalogue_pages=${cataloguePages}`);
  console.log(`discovered=${discovered}`);
  console.log(`unique_urls=${bookUrls.size}`);

  if (discovered !== 60 || bookUrls.size !== 60) {
    throw new Error(
      `Expected 60 discovered and unique book URLs; got ${discovered} discovered and ${bookUrls.size} unique`,
    );
  }

  return [...bookUrls];
}

async function main() {
  const bookUrls = await discoverCatalogue();

  // Keep the discovered URLs available for the next stage.
  // Stage 3 will fetch these detail pages.
  console.log(`discovery_complete=${bookUrls.length === 60}`);
}

main().catch((error) => {
  console.error(`Scraper failed: ${error.message}`);
  process.exitCode = 1;
});
