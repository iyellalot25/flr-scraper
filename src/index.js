const fs = require("node:fs/promises");
const path = require("node:path");

const PAGE_URL = "https://books.toscrape.com/";
const USER_AGENT =
  "FlyRankInternship-A9/1.0 (+https://github.com/iyellalot25/flr-scraper)";
const TIMEOUT_MS = 10_000;

const CACHE_DIR = path.resolve(__dirname, "../cache");
const CACHE_FILE = path.join(CACHE_DIR, "catalogue-page-1.html");

async function main() {
  // Reuse previously downloaded HTML whenever possible.
  try {
    const cachedHtml = await fs.readFile(CACHE_FILE, "utf8");
    const sizeBytes = Buffer.byteLength(cachedHtml, "utf8");

    console.log("CACHE HIT");
    console.log(`url=${PAGE_URL}`);
    console.log(`response_size_bytes=${sizeBytes}`);

    return;
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }

  // No cache exists, so make one polite HTTP request.
  console.log("FETCH");

  const response = await fetch(PAGE_URL, {
    headers: {
      "User-Agent": USER_AGENT,
      Accept: "text/html",
    },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

  // Never treat an unsuccessful HTTP response as valid HTML.
  if (response.status !== 200) {
    await response.body?.cancel();

    throw new Error(
      `HTTP ${response.status} ${response.statusText} for ${PAGE_URL}`,
    );
  }

  const html = await response.text();
  const sizeBytes = Buffer.byteLength(html, "utf8");

  // Create the cache directory and save the successful response.
  await fs.mkdir(CACHE_DIR, { recursive: true });
  await fs.writeFile(CACHE_FILE, html, "utf8");

  console.log(`status=${response.status}`);
  console.log(`url=${PAGE_URL}`);
  console.log(`response_size_bytes=${sizeBytes}`);
  console.log(`cached_file=${path.relative(process.cwd(), CACHE_FILE)}`);
}

main().catch((error) => {
  console.error(`Scraper failed: ${error.message}`);
  process.exitCode = 1;
});
