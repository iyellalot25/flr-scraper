# A9 — The Polite Scraper

A JavaScript-based web scraping pipeline built for FlyRank Internship — Backend Track, Week 5.

## Target classification

- **Target:** [Books to Scrape](https://books.toscrape.com/)
- **Purpose:** A fictional bookstore explicitly designed for practising web scraping.
- **Scope:** The first three catalogue pages and the 60 book-detail pages discovered through their links.
- **Data collected:** Book title, product URL, price, availability, rating, description, source catalogue page, and fetch timestamp.
- **Robots check:** `https://books.toscrape.com/robots.txt` — 404 Not Found
- **Justification:** This target is appropriate because its official sandbox description explicitly identifies it as a practice environment for web scraping.

I will not reuse this code on another site without checking its rules and terms first.

## Ethics and politeness

- Use an identifying User-Agent.
- Set a request timeout and check HTTP status codes.
- Wait at least 500 ms between real requests.
- Cache downloaded HTML to avoid unnecessary repeat requests.
- Collect only the fields required for this assignment.
- Never bypass logins, paywalls, or access restrictions.
- Prefer an official API when one is available.

## Implementation

**Language:** JavaScript (Node.js)

**Libraries:** Cheerio, Zod

**Status:** Stage 0 — target classification.

Run instructions, schema details, validation results, sample output, and the run report will be documented as the implementation progresses.
