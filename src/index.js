const fs = require("node:fs/promises");
const path = require("node:path");
const crypto = require("node:crypto");
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
const REPORT_FILE = path.join(OUTPUT_DIR, "run-report.json");
const CSV_FILE = path.join(OUTPUT_DIR, "books.csv");
const DASHBOARD_FILE = path.join(OUTPUT_DIR, "dashboard.html");
const CHANGE_REPORT_FILE = path.join(OUTPUT_DIR, "change-report.json");
const BASELINE_FILE = path.join(OUTPUT_DIR, "baseline-books.json");

const TEST_BROKEN_PAGE = process.argv.includes("--test-broken-page");

let lastRequestStartedAt = 0;

const metrics = {
  pagesFetched: 0,
  cacheHits: 0,
  cataloguePagesProcessed: 0,
  failedPages: [],
};

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

async function fetchWithCache(url, cacheFile, stage) {
  const cachePath = path.join(CACHE_DIR, cacheFile);

  try {
    const html = await fs.readFile(cachePath, "utf8");
    metrics.cacheHits++;

    console.log(
      `CACHE HIT ${cacheFile} response_size_bytes=${Buffer.byteLength(html, "utf8")}`,
    );

    return html;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const elapsed = Date.now() - lastRequestStartedAt;
  const waitMs = Math.max(0, MIN_DELAY_MS - elapsed);

  if (waitMs > 0) await sleep(waitMs);

  console.log(`FETCH ${url}`);
  lastRequestStartedAt = Date.now();

  try {
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

    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, html, "utf8");

    metrics.pagesFetched++;

    console.log(`status=${response.status}`);
    console.log(`response_size_bytes=${Buffer.byteLength(html, "utf8")}`);
    console.log(`cached_file=${cacheFile}`);

    return html;
  } catch (error) {
    metrics.failedPages.push({
      url,
      stage,
      reason: error.message,
      failed_at: new Date().toISOString(),
    });

    throw error;
  }
}

async function discoverCatalogue() {
  const discoveredBooks = [];
  const uniqueUrls = new Set();

  let currentUrl = START_URL;
  let cataloguePages = 0;
  let discovered = 0;

  while (currentUrl && cataloguePages < MAX_CATALOGUE_PAGES) {
    cataloguePages++;
    metrics.cataloguePagesProcessed = cataloguePages;

    const sourcePage = currentUrl;
    const cacheFile = `catalogue-page-${cataloguePages}.html`;
    const html = await fetchWithCache(sourcePage, cacheFile, "catalogue");
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
  const tasks = [...books];

  // Optional test: exercise failure isolation without changing the real catalogue.
  if (TEST_BROKEN_PAGE) {
    tasks.push({
      product_url:
        "https://books.toscrape.com/catalogue/this-page-intentionally-does-not-exist_99999/index.html",
      source_page: START_URL,
      test_only: true,
    });
  }

  const records = [];

  for (let index = 0; index < tasks.length; index++) {
    const book = tasks[index];
    const cacheFile = book.test_only
      ? "books/test-broken-page.html"
      : `books/book-${String(index + 1).padStart(3, "0")}.html`;

    console.log(`\nBOOK ${index + 1}/${tasks.length}`);

    try {
      const html = await fetchWithCache(book.product_url, cacheFile, "detail");

      // The deliberate test URL must never enter the actual book output.
      if (book.test_only) continue;

      const record = extractBookRecord(html, book, new Date().toISOString());

      records.push(record);
    } catch (error) {
      console.error(
        `SKIPPED detail page: ${book.product_url}\nReason: ${error.message}`,
      );
      // Continue with the next detail page.
    }
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

  const temporaryPath = `${filePath}.tmp`;

  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(data, null, 2)}\n`,
    "utf8",
  );

  await fs.rename(temporaryPath, filePath);
}

function csvCell(value) {
  // Nullable values become empty CSV cells.
  const text = value == null ? "" : String(value);

  // Quote every cell and escape embedded double quotes.
  return `"${text.replace(/"/g, '""')}"`;
}

async function writeCsv(books) {
  const columns = [
    "title",
    "product_url",
    "price_text",
    "price_gbp",
    "availability_text",
    "rating_text",
    "description",
    "source_page",
    "fetched_at",
  ];

  const lines = [
    columns.map(csvCell).join(","),
    ...books.map((book) =>
      columns.map((column) => csvCell(book[column])).join(","),
    ),
  ];

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(CSV_FILE, `${lines.join("\r\n")}\r\n`, "utf8");
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatPrice(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "N/A";
  }

  return `£${value.toFixed(2)}`;
}

async function writeDashboard(runReport, books, invalidRecords) {
  const prices = books
    .map((book) => book.price_gbp)
    .filter((price) => typeof price === "number" && Number.isFinite(price));

  const minPrice = prices.length ? Math.min(...prices) : null;
  const maxPrice = prices.length ? Math.max(...prices) : null;

  const failures = runReport.failed_pages ?? [];
  const completedAt = runReport.ended_at
    ? new Date(runReport.ended_at).toLocaleString("en-GB", {
        dateStyle: "medium",
        timeStyle: "medium",
        timeZone: "UTC",
      }) + " UTC"
    : "Not available";

  const failureRows = failures.length
    ? failures
        .map(
          (failure) => `
            <tr>
              <td>${escapeHtml(failure.stage)}</td>
              <td class="url">${escapeHtml(failure.url)}</td>
              <td>${escapeHtml(failure.reason)}</td>
            </tr>`,
        )
        .join("")
    : `<tr><td colspan="3" class="empty">No failed page requests recorded.</td></tr>`;

  const changeSummary = runReport.change_detection
    ? `
      <p>
        <strong>Change comparison:</strong>
        ${runReport.change_detection.comparison_complete ? "Complete" : "Incomplete"}
      </p>
      <p>
        New: ${runReport.change_detection.new} ·
        Changed: ${runReport.change_detection.changed} ·
        Unchanged: ${runReport.change_detection.unchanged} ·
        Gone: ${runReport.change_detection.gone}
      </p>`
    : "<p>No change comparison was generated for this run.</p>";

  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>A9 Scraper Dashboard</title>
  <style>
    :root {
      color-scheme: light;
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #f4f6fa;
      color: #172033;
    }
    body {
      max-width: 1050px;
      margin: 0 auto;
      padding: 32px 20px;
    }
    h1, h2 { letter-spacing: -0.03em; }
    .muted { color: #667085; }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
      gap: 16px;
      margin: 24px 0;
    }
    .card, section {
      background: #fff;
      border: 1px solid #e1e6ef;
      border-radius: 12px;
      padding: 20px;
    }
    .metric {
      display: block;
      font-size: 1.8rem;
      font-weight: 700;
      margin-top: 8px;
      overflow-wrap: anywhere;
    }
    section { margin-top: 20px; }
    .table-wrap { overflow-x: auto; }
    table {
      width: 100%;
      border-collapse: collapse;
      text-align: left;
    }
    th, td {
      padding: 12px;
      border-bottom: 1px solid #e8ecf2;
      vertical-align: top;
    }
    th { background: #f8fafc; }
    .url { overflow-wrap: anywhere; }
    .empty { color: #667085; text-align: center; }
    a { color: #2459b8; }
    @media (max-width: 600px) {
      body { padding: 20px 12px; }
      .card, section { padding: 15px; }
    }
  </style>
</head>
<body>
  <header>
    <h1>A9 Scraper Dashboard</h1>
    <p class="muted">Books to Scrape · First three catalogue pages</p>
    <p>Last run completed: <strong>${escapeHtml(completedAt)}</strong></p>
  </header>

  <div class="grid">
    <article class="card">
      <span class="muted">Valid book records</span>
      <strong class="metric">${books.length}</strong>
    </article>
    <article class="card">
      <span class="muted">Price range</span>
      <strong class="metric">${escapeHtml(formatPrice(minPrice))} – ${escapeHtml(formatPrice(maxPrice))}</strong>
    </article>
    <article class="card">
      <span class="muted">Failed page requests</span>
      <strong class="metric">${failures.length}</strong>
    </article>
    <article class="card">
      <span class="muted">Invalid records</span>
      <strong class="metric">${invalidRecords.length}</strong>
    </article>
  </div>

  <section>
    <h2>Run statistics</h2>
    <p>Catalogue pages processed: ${runReport.catalogue_pages_processed ?? 0}</p>
    <p>Successful network fetches: ${runReport.pages_fetched ?? 0}</p>
    <p>Cache hits: ${runReport.cache_hits ?? 0}</p>
    <p>Run duration: ${runReport.duration_ms ?? 0} ms</p>
    ${changeSummary}
  </section>

  <section>
    <h2>Failed page requests</h2>
    <div class="table-wrap">
      <table>
        <thead>
          <tr><th>Stage</th><th>URL</th><th>Reason</th></tr>
        </thead>
        <tbody>${failureRows}</tbody>
      </table>
    </div>
  </section>

  <footer>
    <p class="muted">
      Generated locally by the A9 scraper. Refresh this file after another run
      to view the latest saved statistics.
    </p>
    <p><a href="books.csv">Open CSV export</a></p>
  </footer>
</body>
</html>`;

  await fs.mkdir(OUTPUT_DIR, { recursive: true });
  await fs.writeFile(DASHBOARD_FILE, html, "utf8");
}

async function readJsonIfExists(filePath, fallback) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

// Exclude fetched_at so a new run timestamp doesn't count as a content change.
const CHANGE_FIELDS = [
  "title",
  "price_text",
  "price_gbp",
  "availability_text",
  "rating_text",
  "description",
];

function contentHash(book) {
  const content = {};

  for (const field of CHANGE_FIELDS) {
    content[field] = book[field];
  }

  return crypto
    .createHash("sha256")
    .update(JSON.stringify(content))
    .digest("hex");
}

function changedFields(previous, current) {
  return CHANGE_FIELDS.filter((field) => previous[field] !== current[field]);
}

function compareSnapshots(currentBooks, previousBooks, comparisonComplete) {
  const previousByUrl = new Map(
    previousBooks.map((book) => [book.product_url, book]),
  );

  const currentByUrl = new Map(
    currentBooks.map((book) => [book.product_url, book]),
  );

  const changes = {
    comparison_complete: comparisonComplete,
    baseline_count: previousBooks.length,
    current_count: currentBooks.length,
    new: [],
    changed: [],
    unchanged: [],
    gone: [],
  };

  for (const current of currentBooks) {
    const previous = previousByUrl.get(current.product_url);

    if (!previous) {
      changes.new.push({
        product_url: current.product_url,
        title: current.title,
        hash: contentHash(current),
      });
      continue;
    }

    const previousHash = contentHash(previous);
    const currentHash = contentHash(current);

    if (previousHash !== currentHash) {
      changes.changed.push({
        product_url: current.product_url,
        title: current.title,
        previous_hash: previousHash,
        current_hash: currentHash,
        changed_fields: changedFields(previous, current),
      });
    } else {
      changes.unchanged.push(current.product_url);
    }
  }

  // Never infer removals from a partial scrape.
  if (comparisonComplete) {
    for (const previous of previousBooks) {
      if (!currentByUrl.has(previous.product_url)) {
        changes.gone.push(previous.product_url);
      }
    }
  }

  return changes;
}

async function main() {
  const startedAt = new Date();
  const startedAtMs = Date.now();

  let validRecords = [];
  let invalidRecords = [];
  let rawRecords = [];
  let previousSnapshot = [];
  let changeReport = null;
  let fatalError = null;
  let catalogueBooks = [];

  try {
    // Prefer the last complete baseline. Fall back to Stage 4's books.json
    // when creating the baseline for the first time.
    previousSnapshot = await readJsonIfExists(
      BASELINE_FILE,
      await readJsonIfExists(BOOKS_FILE, []),
    );

    catalogueBooks = await discoverCatalogue();

    console.log("\n--- Extracting book details ---");
    rawRecords = await extractBookDetails(catalogueBooks);

    console.log("\n--- Detail extraction summary ---");
    console.log(`detail_records=${rawRecords.length}`);
    console.log(`failed_pages=${metrics.failedPages.length}`);

    const validation = validateRecords(rawRecords);
    validRecords = validation.validRecords;
    invalidRecords = validation.invalidRecords;

    // Save every valid record even if another page failed.
    await writeJson(BOOKS_FILE, validRecords);
    await writeJson(ERRORS_FILE, invalidRecords);

    const detailFailures = metrics.failedPages.filter(
      (failure) => failure.stage === "detail",
    );

    const comparisonComplete =
      detailFailures.length === 0 &&
      rawRecords.length === catalogueBooks.length &&
      validRecords.length === 60 &&
      invalidRecords.length === 0;

    changeReport = compareSnapshots(
      validRecords,
      previousSnapshot,
      comparisonComplete,
    );

    if (!comparisonComplete) {
      changeReport.gone_detection_skipped_reason =
        "The scrape was incomplete or contained invalid records.";
    }

    await writeJson(CHANGE_REPORT_FILE, changeReport);

    // Only replace the baseline after a fully successful scrape.
    if (comparisonComplete) {
      await writeJson(BASELINE_FILE, validRecords);
    }

    console.log("\n--- Validation and storage summary ---");
    console.log(`valid_records=${validRecords.length}`);
    console.log(`invalid_records=${invalidRecords.length}`);
    console.log(
      `unique_valid_urls=${new Set(validRecords.map((book) => book.product_url)).size}`,
    );
    console.log(`books_output=${path.relative(process.cwd(), BOOKS_FILE)}`);
    console.log(`errors_output=${path.relative(process.cwd(), ERRORS_FILE)}`);

    console.log("\n--- Change detection summary ---");
    console.log(`new=${changeReport.new.length}`);
    console.log(`changed=${changeReport.changed.length}`);
    console.log(`unchanged=${changeReport.unchanged.length}`);
    console.log(`gone=${changeReport.gone.length}`);
    console.log(`comparison_complete=${changeReport.comparison_complete}`);

    if (detailFailures.length > 0) {
      console.warn(
        `${detailFailures.length} detail page(s) failed. Valid records were retained; inspect the run report.`,
      );
    }

    if (invalidRecords.length > 0) {
      console.warn(
        `${invalidRecords.length} invalid record(s). Inspect output/errors.json.`,
      );
    }
  } catch (error) {
    fatalError = error;
    console.error(`Scraper failed: ${error.message}`);
  } finally {
    const endedAt = new Date();

    const runReport = {
      started_at: startedAt.toISOString(),
      ended_at: endedAt.toISOString(),
      duration_ms: Date.now() - startedAtMs,
      catalogue_pages_processed: metrics.cataloguePagesProcessed,
      pages_fetched: metrics.pagesFetched,
      cache_hits: metrics.cacheHits,
      discovered_books: catalogueBooks.length,
      detail_records_extracted: rawRecords.length,
      valid_records: validRecords.length,
      invalid_records: invalidRecords.length,
      failed_pages: metrics.failedPages,
      change_detection: changeReport
        ? {
            comparison_complete: changeReport.comparison_complete,
            new: changeReport.new.length,
            changed: changeReport.changed.length,
            unchanged: changeReport.unchanged.length,
            gone: changeReport.gone.length,
          }
        : null,
      fatal_error: fatalError ? fatalError.message : null,
    };

    try {
      await writeJson(REPORT_FILE, runReport);
      await writeCsv(validRecords);
      await writeDashboard(runReport, validRecords, invalidRecords);

      console.log(`\nRun report saved to ${REPORT_FILE}`);
      console.log(`CSV export saved to ${CSV_FILE}`);
      console.log(`Dashboard saved to ${DASHBOARD_FILE}`);
    } catch (outputError) {
      console.error(`Could not write generated output: ${outputError.message}`);
      fatalError = fatalError || outputError;
    }
  }

  if (fatalError) process.exitCode = 1;
}

main();
