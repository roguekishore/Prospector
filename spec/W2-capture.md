# W2 — Capture Engine

**Read `MASTER.md` first.** This spec owns one stage.

**Owns:** `src/capture/`
**Writes:** `mobile.png`, `desktop.png`, `full.png`, `raw/home.html`,
`raw/headers.json` — per domain
**Reads:** `data/<vertical>/_qualified.json` (`MASTER.md §4.0`)
**Blocked by:** nothing. A three-line `_qualified.json` you hand-write is enough
to develop against, and real fixtures already exist under `data/`.

---

## 1. Goal

For every qualified domain, produce three screenshots and a verbatim copy of the
HTML plus response metadata, then never touch the network again.

Two consequences follow, and both are load-bearing:

**The mobile screenshot is the product.** It is the single asset the pitch email
attaches. If it contains a cookie banner, a blank lazy-load band, or a
half-rendered hero, the lead is worthless regardless of its tier. Capture quality
is this workstream's entire reason to exist.

**`raw/` must be complete enough that `extract` never needs the network.** Any
value W3 cannot derive from `raw/home.html` + `raw/headers.json` is a bug in this
spec's output, not in W3.

---

## 2. Browser setup

```js
const { chromium } = require('playwright');   // pinned exact version

const browser = await chromium.launch({
  channel: 'chromium',            // headless-shell, not full Chromium
  headless: true,
  args: ['--disable-blink-features=AutomationControlled',
         '--disable-features=IsolateOrigins,site-per-process'],
});
```

Install with `npx playwright install --with-deps chromium-headless-shell`.

**One browser, N contexts.** Contexts cost ~5–10MB against ~80MB for a process,
so the pool is contexts, not browsers. Default `--concurrency 4`.

A context is created per domain and **always** closed in a `finally`. A leaked
context is the one failure mode that will exhaust memory on a 200-site run.

### 2.1 Context options — identical for every capture

```js
const ctx = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 1,
  locale: 'en-IN',
  timezoneId: 'Asia/Kolkata',
  userAgent: UA,                        // §2.2
  ignoreHTTPSErrors: true,              // expired certs must still be captured
  serviceWorkers: 'block',
  reducedMotion: 'reduce',
  colorScheme: 'light',
  bypassCSP: false,
});
```

`ignoreHTTPSErrors: true` is essential. An expired certificate is among the most
valuable findings in the system (`MASTER.md §6`, `cert-expired` angle), and the
capture must still succeed so the operator can see the site behind the warning.

`locale`, `timezoneId`, `deviceScaleFactor`, and `reducedMotion` are pinned for
reproducibility — a capture must look the same tomorrow.

### 2.2 User agent — identify, do not spoof

```js
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
           '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36 ' +
           'ProspectorBot/1.0 (+mailto:YOUR_EMAIL_HERE)';
```

The Chrome prefix is required because many sites serve broken markup to unknown
agents, which would corrupt the measurement. The `ProspectorBot` suffix with a
contact address is the honest part and is **not optional** — `MASTER.md §8`
requires identification. Put a real address in config before the first run.

Do not strip the suffix to improve success rates. If a site blocks an identified
crawler, record the block and move on.

---

## 3. Navigation

```js
const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
```

`domcontentloaded`, never `networkidle`. These sites have analytics beacons,
chat widgets, and autoplay video that never go idle; `networkidle` would burn the
full timeout on every lead.

### 3.1 Settle sequence — in this exact order

After `goto`, the following runs before any screenshot. Order matters: fonts
before measurement, consent before scroll, scroll before capture.

```
1. inject the freeze stylesheet          (§3.2)
2. dismiss consent                       (§4)
3. await document.fonts.ready            (capped 3s)
4. scroll to bottom in steps, then back to top   (§5)
5. await image decode                    (capped 5s, §5.2)
6. re-inject the freeze stylesheet       (lazy content may add animations)
7. settle wait: 1200ms
```

Total budget is 30s navigation + 10s settle. **On timeout, capture whatever
rendered.** A partial screenshot of a real page is useful; an exception is not.

### 3.2 Freeze animations — before measuring anything

```js
await page.addStyleTag({ content: `
  *, *::before, *::after {
    animation-duration: 0s !important;
    animation-delay: 0s !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0s !important;
    transition-delay: 0s !important;
    caret-color: transparent !important;
  }
  html { scroll-behavior: auto !important; }
  video { visibility: visible !important; }
`});
await page.evaluate(() => document.querySelectorAll('video').forEach(v => {
  try { v.pause(); v.currentTime = 0; v.removeAttribute('autoplay'); } catch {}
}));
```

Carousels are the reason. An un-frozen slider produces a different hero on every
run, which makes captures non-comparable and makes "your slider is from 2015"
impossible to demonstrate from the image. Pausing video at frame 0 also gives a
deterministic poster frame.

---

## 4. Cookie consent — the biggest single ruiner of screenshots

Three strategies, applied in order. **Record what happened either way** — a
banner is a UX finding in its own right.

**1. Block the script.** Before navigation:

```js
await ctx.route('**/*', route => {
  const u = route.request().url();
  if (/cookiebot|onetrust|cookieyes|termly|iubenda|osano|quantcast|
      cookie-?consent|cookie-?notice|gdpr|borlabs/i.test(u))
    return route.abort();
  return route.continue();
});
```

**2. Click by text.** After navigation, first match wins, 2s timeout:

```
Accept all · Accept All Cookies · I accept · Accept · Allow all · Got it ·
OK · I agree · Agree · Understood · Continue · Close · Sounds good
```

Use `page.getByRole('button', { name: /^(accept|agree|got it|ok)/i })` and
`page.getByText(...)` as fallback. Never click anything matching
`/settings|preferences|manage|customi[sz]e|reject|decline|more info/i` — those
open a modal instead of closing one, which is worse than the banner.

**3. Remove fixed overlays that survive.** Last resort, after the two above:

```js
await page.evaluate(() => {
  for (const el of document.querySelectorAll('body *')) {
    const s = getComputedStyle(el);
    if ((s.position === 'fixed' || s.position === 'sticky') &&
        parseInt(s.zIndex || '0', 10) > 900 &&
        el.getBoundingClientRect().height > 60 &&
        /cookie|consent|gdpr|privacy/i.test(el.textContent || ''))
      el.remove();
  }
});
```

The text test prevents this from deleting a legitimate sticky header — which is
itself a measured signal and must survive into the capture.

Write the outcome to `headers.json` as
`consent: {"seen": true, "method": "click", "label": "Accept all"}` or
`{"seen": false}`.

---

## 5. Lazy loading

Naive full-page screenshots of these sites come back with blank bands where
images never entered the viewport. Two mechanisms, both required.

### 5.1 Stepped scroll

```js
await page.evaluate(async () => {
  const step = Math.floor(window.innerHeight * 0.8);
  const max = Math.min(document.body.scrollHeight, 30000);   // cap runaway pages
  for (let y = 0; y < max; y += step) {
    window.scrollTo(0, y);
    await new Promise(r => setTimeout(r, 120));
  }
  window.scrollTo(0, 0);
  await new Promise(r => setTimeout(r, 250));
});
```

Stepped, not a single jump to the bottom — `IntersectionObserver`-based loaders
only fire for viewports actually traversed. The 30000px cap stops an infinite
-scroll page from consuming the whole budget.

### 5.2 Force and await decode

```js
await page.evaluate(() => {
  document.querySelectorAll('img[loading="lazy"]').forEach(i => i.loading = 'eager');
  document.querySelectorAll('img[data-src]').forEach(i => {
    if (!i.src) i.src = i.dataset.src;          // pre-native lazy libs
  });
});
await page.evaluate(() => Promise.all(
  [...document.images].filter(i => !i.complete)
    .map(i => i.decode().catch(() => {}))
).then(() => {}));
```

Wrap the whole block in a 5s `Promise.race` timeout. A single broken image must
not stall the capture — and broken images are themselves a measured signal.

---

## 6. The three captures

Order matters: mobile last, because switching viewport re-triggers responsive
layout and lazy loading, so it gets a fresh settle.

### 6.1 desktop.png — 1440×900, viewport only

```js
await page.setViewportSize({ width: 1440, height: 900 });
await page.screenshot({ path: 'desktop.png', fullPage: false, type: 'png' });
```

Above-the-fold at desktop width. This is the "what does it look like" shot.

### 6.2 full.png — 1440 wide, full page

```js
await page.screenshot({ path: 'full.png', fullPage: true, type: 'png' });
```

If `document.body.scrollHeight > 20000`, clip to 20000px and record
`full_clipped: true`. Some sites have pathological heights and a 40MB PNG helps
nobody.

### 6.3 mobile.png — 390×844, viewport only

```js
await page.setViewportSize({ width: 390, height: 844 });
await page.evaluate(() => window.scrollTo(0, 0));
// re-run §5 scroll + decode, then:
await page.waitForTimeout(800);
await page.screenshot({ path: 'mobile.png', fullPage: false, type: 'png' });
```

**Do not emulate a device with `isMobile: true` or a touch-enabled UA.** The
finding this capture exists to prove is what a *desktop-layout* site does when
squeezed into a phone viewport. A mobile UA may trigger a separate mobile theme
and hide the very defect being measured.

This is the screenshot the pitch attaches. It gets the extra settle.

### 6.4 Measure overflow at mobile width, while you are there

```js
const overflow = await page.evaluate(() => {
  const d = document.documentElement;
  return {
    scrollWidth: d.scrollWidth,
    clientWidth: d.clientWidth,
    overflowPx: Math.max(0, d.scrollWidth - d.clientWidth),
    hasViewportMeta: !!document.querySelector('meta[name="viewport" i]'),
    tapTargetsUnder44: [...document.querySelectorAll('a,button,[role="button"],input,select')]
      .filter(e => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && (r.width < 44 || r.height < 44);
      }).length,
    smallText: [...document.querySelectorAll('p,li,span,div')]
      .filter(e => e.textContent.trim().length > 20 &&
                   parseFloat(getComputedStyle(e).fontSize) < 14).length,
  };
});
```

These go into `headers.json` under `mobile`. They must be measured **at 390px**,
which is why this belongs here and not in W3 — W3 only has static HTML and cannot
compute a layout.

---

## 7. raw/ — the archive that makes re-runs free

### 7.1 raw/home.html

**Two documents, and the distinction matters:**

```js
const rawHtml = await resp.text();                  // pre-JS, as served
const domHtml = await page.content();               // post-JS, as rendered
```

Write `raw/home.html` = the **served** bytes. Write `raw/rendered.html` = the DOM
after settle. W3 prefers `rendered.html` for link and text extraction (JS-injected
nav is real nav) but needs `home.html` for generator detection, since build tools
often strip their own `<meta name="generator">` at runtime.

Preserve the original encoding. If `content-type` declares a charset other than
UTF-8, write the bytes verbatim and record the charset — do not transcode, or
Tamil text in contact blocks will corrupt.

### 7.2 raw/headers.json

Exactly the shape in `MASTER.md §4.6`, plus the `consent` and `mobile` blocks
above. Collect it by instrumenting requests:

```js
const assets = [];
page.on('response', async r => {
  const h = r.headers();
  assets.push({
    url: r.url(),
    type: r.request().resourceType(),
    status: r.status(),
    bytes: Number(h['content-length'] || 0),
    last_modified: h['last-modified'] || null,
  });
});
page.on('console', m => { if (m.type() === 'error') consoleErrors++; });
page.on('requestfailed', r => brokenRequests.push({url: r.url(), status: 0}));
```

`last_modified` on the newest asset is a genuinely good staleness signal and
costs nothing to collect.

### 7.3 Performance metrics — no Lighthouse

```js
const timing = await page.evaluate(() => new Promise(resolve => {
  let lcp = 0, cls = 0;
  try {
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) lcp = Math.max(lcp, e.renderTime || e.loadTime || e.startTime);
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver(l => {
      for (const e of l.getEntries()) if (!e.hadRecentInput) cls += e.value;
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  setTimeout(() => resolve({ lcp_ms: Math.round(lcp), cls: Math.round(cls * 1000) / 1000 }), 1500);
}));
```

Lighthouse is deliberately **not** a dependency: 40MB and ~10s per site for two
numbers already available here, whose composite scores are the least reproducible
input in the system. `MASTER.md §5.2` buckets LCP precisely because it varies.

Record `lcp_ms` raw in `headers.json`; bucketing happens in the scorer, not here.

---

## 8. Failure handling

Every failure is per-domain and produces `error.json`, never an aborted run:

```jsonc
{
  "domain": "...", "stage": "audit", "at": "2026-09-18T09:41:02Z",
  "kind": "nav-timeout",
  "message": "Timeout 30000ms exceeded",
  "partial": ["desktop.png"],
  "attempts": 2
}
```

`kind` ∈ `dns · refused · nav-timeout · cert · blocked-403 · blocked-429 ·
crash · oom · unknown`.

### 8.1 Retry policy

One retry, only for `nav-timeout`, `crash`, and `blocked-429`. Wait 5s (30s for
429). Never retry `dns`, `refused`, or `403` — those are settled answers.

### 8.2 Headful fallback

When a domain returns 403 twice in headless, retry once with `headless: false`.
If more than ~10% of a run needs this, promote it from fallback to default
(`MASTER.md §14.5`). Record `headful: true` in `headers.json` when used.

### 8.3 Crash recovery

Wrap each domain so a browser crash rebuilds the browser and requeues the domain
once. A `browser.isConnected()` check before each context creation catches most
cases cheaply.

---

## 9. CLI

```
node src/cli audit [<vertical>] [--resume] [--concurrency 4]
                   [--only <domain>] [--headful] [--timeout 30000]
```

`--resume` skips a domain when all three PNGs **and** `raw/headers.json` exist.
A domain with two PNGs is incomplete and is re-run.

`--only <domain>` is the development loop. Use it constantly.

Progress line, one per completion:

```
[ 34/124]  A  blitzglobe.com            3 shots  11.2MB  lcp 8.4s  consent:no   6.1s
[ 35/124]  ×  someplace.in              nav-timeout (retry 1)
```

---

## 10. Politeness

`MASTER.md §8` in full. Specifically enforced here:

- One in-flight request per host, 1500ms minimum spacing.
- robots.txt honoured; a disallowed homepage is skipped with `error.json`
  `kind: "robots"`. Parse once per host, cache for the run.
- Homepage only, plus **at most one** contact page when the homepage links to an
  obvious `/contact*` path — needed for `contacts.json`. Nothing else. This is a
  survey, not a crawl.
- Hard 40s ceiling per domain including retries.

---

## 11. Acceptance criteria

1. Three PNGs plus `raw/home.html`, `raw/rendered.html`, `raw/headers.json`
   written for a live site, matching `MASTER.md §4.6`.
2. `mobile.png` at 390×844 shows the desktop layout squeezed — **no mobile UA
   emulation**, verified by asserting the UA string contains no `Mobile`.
3. A site with an expired certificate is captured successfully and
   `cert`-related info reaches `headers.json`.
4. A site with a known consent banner produces a screenshot with no banner, and
   `consent.seen === true`.
5. A lazy-loading gallery shows no blank bands in `full.png`.
6. Two runs over the same site produce byte-identical `overflowPx`,
   `hasViewportMeta`, and `tapTargetsUnder44`. (PNGs may differ; those three
   must not.)
7. A domain that times out yields `error.json` and the run continues to the next
   domain.
8. Killing the process mid-run leaves no `.tmp` files and no half-written PNG;
   `--resume` then completes the remainder.
9. 50 domains at `--concurrency 4` complete without memory growth beyond ~600MB.
10. `--only <domain>` round-trips in under 15s for a typical site.

## 12. Do not

- Do not use `waitUntil: 'networkidle'`.
- Do not emulate a mobile device or send a mobile UA.
- Do not add Lighthouse, Puppeteer, or a second browser driver.
- Do not strip the bot identifier from the UA to defeat blocks.
- Do not crawl beyond the homepage plus one contact page.
- Do not transcode HTML to UTF-8; preserve bytes and record the charset.
- Do not compute tier, score, or any signal here. This stage captures; W3
  interprets. The only interpretation allowed is the at-390px layout measurement
  in §6.4, which is impossible anywhere else.
