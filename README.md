# zFrontier Lottery Crawler

Node.js script using Crawlee's `PlaywrightCrawler` to open `https://www.zfrontier.com/app/#info`, collect posts from the `情报` tab only, check whether each post is within the last 3 days, click the thumb-up button for eligible lottery posts, and participate when a post exposes `点击抽奖`.

## Run

Create a local `.env` file:

```sh
cp .env.example .env
```

Then edit `.env`:

```sh
ZF_PHONE=19129572110
ZF_PASSWORD='your-password'
```

Start the crawler:

```sh
npm start
```

The script reads login credentials from `.env`, or from shell environment variables. Shell variables override `.env` values.

Useful options:

```sh
npm run dry-run
HEADLESS=1 ZF_PHONE='your-phone' ZF_PASSWORD='your-password' npm start
USE_CHROME=0 ZF_PHONE='your-phone' ZF_PASSWORD='your-password' npm start
PROXY_URL='http://host:port' ZF_PHONE='your-phone' ZF_PASSWORD='your-password' npm start
ENV_FILE=/path/to/custom.env npm start
VIEWPORT_WIDTH=1600 VIEWPORT_HEIGHT=1200 npm start
MAX_POSTS=20 npm start
MAX_SCROLLS=120 npm start
```

## CAPTCHA and Login

Crawlee runs Playwright with a persistent browser profile in `.browser-profile/`. Visible runs prefer the installed Google Chrome app by default; set `USE_CHROME=0` to use Playwright's bundled Chromium instead. The default viewport is `1600x1200`, and `VIEWPORT_WIDTH` is clamped to at least `960`. If zFrontier shows a slider verification or a login prompt, the script pauses in the visible browser. Complete the verification/login manually, or provide `ZF_PHONE` and `ZF_PASSWORD`; the script clicks `登录/注册`, then `手机号注册登录`, then fills the visible login form when possible.

The script does not bypass CAPTCHA. Once the site accepts the browser session, later runs reuse the saved profile.

## Crawling

The crawler keeps one browser page open: it collects `情报` tab links first, then visits each post sequentially in that same page. It does not enqueue every post as a separate browser page.

## State

Successful participations are recorded in `engaged-lotteries.sqlite` with the post title, URL, and engaged date. Only posts where the script clicked a lottery entry are stored there. Re-running the script skips those post IDs.

The crawler also generates `engaged-lotteries.html` after each saved record. To rebuild the HTML viewer from SQLite at any time:

```sh
npm run view
```

Then open `engaged-lotteries.html` in a browser.

## Rust Report Server

To serve the report from SQLite and generate the HTML on every request:

```sh
npm run serve:report
```

Then open `http://127.0.0.1:8787`.

The server reads `ZF_ENGAGED_DB`, `REPORT_HOST`, and `REPORT_PORT` from `.env` or shell environment variables.
