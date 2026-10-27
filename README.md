# The Polite Scraper

A JavaScript-based web scraping pipeline built for the FlyRank Internship — Backend Track, Week 5.

The scraper collects book data from the first three catalogue pages of [Books to Scrape](https://books.toscrape.com/), validates and normalizes the records, and generates JSON, CSV, change reports, and a local HTML dashboard.

## Target Classification

- **Target:** [Books to Scrape](https://books.toscrape.com/)
- **Purpose:** A fictional bookstore explicitly designed for practising web scraping.
- **Scope:** The first three catalogue pages and the 60 book-detail pages discovered through their links.
- **Data collected:** Book title, product URL, price, availability, rating, description, source catalogue page, and fetch timestamp.
- **Robots check:** [https://books.toscrape.com/robots.txt](https://books.toscrape.com/robots.txt) returned `404 Not Found` when checked during initial setup. This is not treated as permission to scrape arbitrary websites.
- **Justification:** This target is appropriate because it is a practice environment for learning web scraping.

The scraper is deliberately scoped to this site. Check the target's current rules and terms before adapting the implementation to another website.

## Requirements

- Node.js 20 or later.
- npm.
- An internet connection for the first uncached run.

No browser automation is required. The catalogue and book details are available in the HTML returned by ordinary HTTP requests, so Cheerio can parse the pages directly.

## Installation

Clone the repository and enter the assignment directory:

```bash
git clone https://github.com/iyellalot25/flr-scraper.git
cd flr-scraper
npm install
```

Create the required directories if they do not exist:

```bash
mkdir -p cache output
```

On Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force cache, output
```

## Running the Scraper

Run with nodemon during development:

```bash
npm run dev
```

Run normally:

```bash
npm start
```

To exercise the detail-page failure-isolation path with an intentionally invalid URL:

```bash
node src/index.js --test-broken-page
```

The deliberate failure is recorded in the run report. Valid records from the remaining pages are retained. This test run should not be treated as a complete snapshot.

## How It Works

1. **Catalogue discovery:** follows the catalogue's next-page links and discovers book-detail URLs across the first three catalogue pages.
2. **Polite fetching:** sends an identifying User-Agent, enforces a 10-second request timeout, checks HTTP status codes, and spaces real request starts by at least 500 milliseconds in the sequential workflow.
3. **Caching:** stores HTML responses locally to reduce repeat requests during development.
4. **Extraction:** uses Cheerio to extract book fields from server-rendered HTML.
5. **Normalization:** converts GBP price text, such as `£51.77`, into the numeric value `51.77`.
6. **Validation:** uses Zod to validate records and logs invalid records with field-level error messages.
7. **Storage:** writes validated records to JSON and CSV files.
8. **Change detection:** compares record content using SHA-256 hashes, excluding `fetched_at` so timestamp changes alone do not count as content changes.
9. **Reporting:** writes a run report and change report, then generates a local HTML dashboard.

## Generated Files

Generated files are stored in `output/`.

| File                  | Purpose                                                                                 |
| --------------------- | --------------------------------------------------------------------------------------- |
| `books.json`          | Valid, normalized book records from the current run.                                    |
| `books.csv`           | Spreadsheet-friendly export of the valid records.                                       |
| `errors.json`         | Invalid records and their validation errors.                                            |
| `run-report.json`     | Run timestamps, duration, fetch and cache metrics, validation counts, and failed pages. |
| `change-report.json`  | New, changed, unchanged, and gone records compared with the previous complete baseline. |
| `baseline-books.json` | The last complete validated snapshot used for future comparisons.                       |
| `dashboard.html`      | Local summary of record counts, price range, failures, and run statistics.              |

The cache is stored separately under `cache/`. Cached HTML is development data, not the canonical output dataset.

## CSV Format

The CSV contains these columns:

`title`, `product_url`, `price_text`, `price_gbp`, `availability_text`, `rating_text`, `description`, `source_page`, `fetched_at`.

Every cell is quoted, and embedded double quotes are escaped by doubling them, following standard CSV conventions. Nullable values, such as a missing description or rating, are represented as empty cells. `price_gbp` is numeric text, so spreadsheet software can use it for sorting and calculations.

## Local HTML Dashboard

Open `output/dashboard.html` in a browser after a run.

The dashboard displays:

- Number of valid book records.
- Minimum and maximum normalized prices.
- Failed page requests and their reasons.
- Invalid record count.
- Fetch/cache statistics, run duration, and change-detection summary.

The dashboard is a static local HTML file. Run the scraper again to refresh it; it does not run a server or fetch live data by itself.

## Caching and Repeatability

The scraper uses local cached HTML to avoid repeatedly downloading the same pages during development. Once the required pages are cached, repeat runs should reuse them.

The output files are regenerated from the records extracted during each run. Duplicate product URLs are rejected during validation.

Change detection compares book content fields rather than the fetch timestamp. The baseline is updated only after a complete run with 60 valid records and no detail-page failures or invalid records. When a run is incomplete, the scraper does not classify absent records as gone.

If the target's catalogue changes, remove the relevant cached HTML files before a fresh scrape. Keep the baseline until you deliberately want to reset change history.

## Ethics and Politeness

- Use an identifying User-Agent.
- Set request timeouts and check HTTP status codes.
- Wait at least 500 milliseconds between real request start times.
- Cache downloaded HTML to avoid unnecessary repeat requests.
- Collect only the fields required for this assignment.
- Never bypass logins, paywalls, or access restrictions.
- Prefer an official API when one is available.
- Check the target's current terms and scraping policies before reuse.

## Limitations

- The scraper is intentionally limited to three catalogue pages and expects 60 unique book URLs.
- The target's HTML structure and selectors may change.
- Cached HTML can become stale until the relevant cache files are removed.
- The dashboard is a static report and must be regenerated by running the scraper.
- A failed detail page is recorded and skipped; an incomplete run should not be interpreted as a complete representation of the catalogue.
- The robots.txt endpoint returned 404 during the initial check; this observation may change and is not a general authorization to scrape.

## Technology Stack

- **JavaScript / Node.js** — execution and filesystem operations.
- **Cheerio** — HTML parsing and extraction.
- **Zod** — record validation.
- **Node.js Fetch API** — HTTP requests.
- **Node.js crypto** — SHA-256 content hashes.
