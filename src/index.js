const fs = require("node:fs/promises");
const path = require("node:path");
const cheerio = require("cheerio");
const { z } = require("zod");

const START_URL = "https://books.toscrape.com/";
const USER_AGENT =
  "FlyRankInternship-A9/1.0 (+https://github.com/iyellalot25/flr-scraper)";
const TIMEOUT_MS = 10_000;
const MIN_DELAY_MS = 500;
const MAX_CATALOGUE_PAGES = 3;

const CACHE_DIR = path.resolve(__dirname, "../cache");
const OUTPUT_DIR = path.resolve(__dirname, "../output");
const BOOKS_FILE = path.join(OUTPUT_DIR, "books.json");
const ERRORS_FILE = path.join(OUTPUT_DIR, "errors.json");

let lastRequestStartedAt = 0;

// Validate the final, normalized record.
const bookSchema = z.object({
  title: z.string().trim().min(1),
  product_url: z.string().url(),
  price_text: z.string().trim().min(1),
  price_gbp: z.number().finite().nonnegative(),
  availability_text: z.string().trim().min(1),
  rating_text: z.enum(["One", "Two", "Three", "Four", "Five"]).nullable(),
  description: z.string().nullable(),
  source_page: z.string().url(),
  fetched_at: z.string().datetime(),
});

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithCache(url, cacheFile) {
  const cachePath = path.join(CACHE_DIR, cacheFile);

  try {
    const html = await fs.readFile(cachePath, "utf8");

    console.log(
      `CACHE HIT ${cacheFile} response_size_bytes=${Buffer.byteLength(html, "utf8")}`,
    );

    return html;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  // Keep at least 500 ms between real request start times.
  const elapsed = Date.now() - lastRequestStartedAt;
  const waitMs = Math.max(0, MIN_DELAY_MS - elapsed);

  if (waitMs > 0) await sleep(waitMs);

  console.log(`FETCH ${url}`);
  lastRequestStartedAt = Date.now();

  const response = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  if (response.status !== 200) {
    await response.body?.cancel();
    throw new Error(
      `HTTP ${response.status} ${response.statusText} for ${url}`,
    );
  }

  const html = await response.text();
  const sizeBytes = Buffer.byteLength(html, "utf8");

  await fs.mkdir(path.dirname(cachePath), { recursive: true });
  await fs.writeFile(cachePath, html, "utf8");

  console.log(`status=${response.status}`);
  console.log(`response_size_bytes=${sizeBytes}`);
  console.log(`cached_file=${cacheFile}`);

  return html;
}

async function discoverCatalogue() {
  const discoveredBooks = [];
  const uniqueUrls = new Set();

  let currentUrl = START_URL;
  let cataloguePages = 0;
  let discovered = 0;

  while (currentUrl && cataloguePages < MAX_CATALOGUE_PAGES) {
    cataloguePages++;

    const sourcePage = currentUrl;
    const cacheFile = `catalogue-page-${cataloguePages}.html`;
    const html = await fetchWithCache(sourcePage, cacheFile);
    const $ = cheerio.load(html);

    $(".product_pod h3 a").each((_, element) => {
      const href = $(element).attr("href");
      if (!href) return;

      discovered++;

      const productUrl = new URL(href, sourcePage).href;

      if (!uniqueUrls.has(productUrl)) {
        uniqueUrls.add(productUrl);
        discoveredBooks.push({
          product_url: productUrl,
          source_page: sourcePage,
        });
      }
    });

    console.log(
      `catalogue_page=${cataloguePages} books_found=${$(".product_pod h3 a").length}`,
    );

    if (cataloguePages === MAX_CATALOGUE_PAGES) break;

    const nextHref = $("li.next a").attr("href");

    if (!nextHref) {
      throw new Error(
        `Missing next-page link after catalogue page ${cataloguePages}`,
      );
    }

    currentUrl = new URL(nextHref, sourcePage).href;
  }

  console.log("\n--- Catalogue discovery summary ---");
  console.log(`catalogue_pages=${cataloguePages}`);
  console.log(`discovered=${discovered}`);
  console.log(`unique_urls=${uniqueUrls.size}`);

  if (
    cataloguePages !== MAX_CATALOGUE_PAGES ||
    discovered !== 60 ||
    uniqueUrls.size !== 60
  ) {
    throw new Error(
      `Expected 3 pages, 60 discovered URLs and 60 unique URLs; got ${cataloguePages}, ${discovered} and ${uniqueUrls.size}`,
    );
  }

  return discoveredBooks;
}

function extractBookRecord(html, book, fetchedAt) {
  const $ = cheerio.load(html);

  const text = (selector) => {
    const value = $(selector).first().text().replace(/\s+/g, " ").trim();
    return value || null;
  };

  const ratingClass = $("p.star-rating")
    .first()
    .attr("class")
    ?.split(/\s+/)
    .find((className) =>
      ["One", "Two", "Three", "Four", "Five"].includes(className),
    );

  const descriptionElement = $("#product_description").nextAll("p").first();
  const descriptionText = descriptionElement.length
    ? descriptionElement.text().replace(/\s+/g, " ").trim()
    : "";

  return {
    title: text(".product_main h1"),
    product_url: book.product_url,
    price_text: text(".product_main .price_color"),
    availability_text: text(".product_main .availability"),
    rating_text: ratingClass ?? null,
    description: descriptionText || null,
    source_page: book.source_page,
    fetched_at: fetchedAt,
  };
}

function normalizePrice(priceText) {
  if (typeof priceText !== "string") return null;

  // Accept the expected GBP format, e.g. £51.77.
  const match = priceText.trim().match(/^£\s*(\d+(?:\.\d{1,2})?)$/);

  if (!match) return null;

  const price = Number(match[1]);
  return Number.isFinite(price) ? price : null;
}

function normalizeBookRecord(rawRecord) {
  return {
    ...rawRecord,
    price_gbp: normalizePrice(rawRecord.price_text),
  };
}

async function extractBookDetails(books) {
  const records = [];

  for (let index = 0; index < books.length; index++) {
    const book = books[index];
    const cacheFile = `books/book-${String(index + 1).padStart(3, "0")}.html`;

    console.log(`\nBOOK ${index + 1}/${books.length}`);

    const html = await fetchWithCache(book.product_url, cacheFile);
    const fetchedAt = new Date().toISOString();

    records.push(extractBookRecord(html, book, fetchedAt));
  }

  return records;
}

function validateRecords(rawRecords) {
  const validRecords = [];
  const invalidRecords = [];
  const seenUrls = new Set();

  for (const rawRecord of rawRecords) {
    const normalizedRecord = normalizeBookRecord(rawRecord);
    const result = bookSchema.safeParse(normalizedRecord);

    if (!result.success) {
      invalidRecords.push({
        product_url: rawRecord.product_url,
        record: normalizedRecord,
        errors: result.error.issues.map((issue) => ({
          field: issue.path.join("."),
          message: issue.message,
        })),
      });

      continue;
    }

    // Defend against duplicate product URLs before writing output.
    if (seenUrls.has(result.data.product_url)) {
      invalidRecords.push({
        product_url: result.data.product_url,
        record: result.data,
        errors: [
          {
            field: "product_url",
            message: "Duplicate product URL",
          },
        ],
      });

      continue;
    }

    seenUrls.add(result.data.product_url);
    validRecords.push(result.data);
  }

  return { validRecords, invalidRecords };
}

async function writeJson(filePath, data) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });

  // Write to a temporary file first to avoid leaving partial JSON output.
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(data, null, 2)}\n`,
    "utf8",
  );
  await fs.rename(temporaryPath, filePath);
}

async function main() {
  const books = await discoverCatalogue();

  console.log("\n--- Extracting book details ---");

  const rawRecords = await extractBookDetails(books);

  console.log("\n--- Sample raw record ---");
  console.log(JSON.stringify(rawRecords[0], null, 2));

  console.log("\n--- Detail extraction summary ---");
  console.log(`detail_pages=${rawRecords.length}`);

  if (rawRecords.length !== 60) {
    throw new Error(`Expected 60 detail records, got ${rawRecords.length}`);
  }

  const { validRecords, invalidRecords } = validateRecords(rawRecords);

  await writeJson(BOOKS_FILE, validRecords);
  await writeJson(ERRORS_FILE, invalidRecords);

  console.log("\n--- Validation and storage summary ---");
  console.log(`valid_records=${validRecords.length}`);
  console.log(`invalid_records=${invalidRecords.length}`);
  console.log(
    `unique_valid_urls=${new Set(validRecords.map((book) => book.product_url)).size}`,
  );
  console.log(`books_output=${path.relative(process.cwd(), BOOKS_FILE)}`);
  console.log(`errors_output=${path.relative(process.cwd(), ERRORS_FILE)}`);

  if (invalidRecords.length > 0) {
    console.warn(
      `${invalidRecords.length} record(s) failed validation. Inspect output/errors.json.`,
    );
  }

  if (validRecords.length !== 60 || invalidRecords.length !== 0) {
    throw new Error(
      `Expected 60 valid records and 0 invalid records; got ${validRecords.length} valid and ${invalidRecords.length} invalid.`,
    );
  }
}

main().catch((error) => {
  console.error(`Scraper failed: ${error.message}`);
  process.exitCode = 1;
});
