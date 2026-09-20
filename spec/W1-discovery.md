# W1 — Discovery & Qualification

**Read `MASTER.md` first.** This spec owns two stages and nothing else.

**Owns:** `src/discover/`, `src/qualify/`, `config/verticals.json`,
`config/city.json`
**Writes:** `data/<vertical>/_discovered.json`, `data/<vertical>/_qualified.json`
**Reads:** nothing produced by another workstream.
**Blocked by:** nothing. The Places key is injected at runtime; build and test
against the recorded-fixture path (§6) without it.

---

## 1. Goal

Turn a vertical name into a list of Coimbatore businesses that own a real,
reachable website worth rendering — and discard everything else as cheaply as
possible, before a browser ever launches.

Success is measured by what reaches `audit`: roughly 120 live candidate sites per
vertical out of 300–800 raw results, with **zero** parked domains, dead hosts,
social-only listings, or duplicates.

---

## 2. Stage 1 — `discover`

### 2.1 Provider contract — implement this interface, not a specific API

```js
// src/discover/provider.js
/**
 * @typedef {Object} RawBusiness
 * @property {string}  provider_id
 * @property {string}  name
 * @property {?string} website_raw     full URL as the provider gave it, or null
 * @property {?number} rating
 * @property {?number} review_count
 * @property {?string} address
 * @property {?string} phone
 * @property {?number} lat
 * @property {?number} lng
 * @property {?string} business_status
 * @property {?string} primary_type
 */

/** @returns {Promise<RawBusiness[]>} */
async function search({ keyword, tile, apiKey, signal }) {}
```

Three adapters, selected by `--source`:

| `--source` | Module | Needs key |
|---|---|---|
| `places-new` (default) | `src/discover/places.js` | yes |
| `brave` | `src/discover/brave.js` | yes, different key |
| `fixture` | `src/discover/fixture.js` | no — replays recorded JSON |

**Build `fixture` first.** Everything downstream is then testable with no
credential, and the recorded responses become regression tests.

### 2.2 Places API (New) adapter — exact request

```
POST https://places.googleapis.com/v1/places:searchText
Content-Type: application/json
X-Goog-Api-Key: <key>
X-Goog-FieldMask: nextPageToken,places.id,places.displayName,places.websiteUri,
                  places.rating,places.userRatingCount,places.formattedAddress,
                  places.nationalPhoneNumber,places.location,
                  places.businessStatus,places.primaryType

{
  "textQuery": "interior designer Coimbatore",
  "locationRestriction": {
    "rectangle": {
      "low":  {"latitude": 10.8900, "longitude": 76.8700},
      "high": {"latitude": 11.1400, "longitude": 77.1100}
    }
  },
  "pageSize": 20,
  "languageCode": "en"
}
```

Paginate with `pageToken` from the response until absent or 3 pages, whichever
comes first. A token is not always valid the instant the previous page returns,
so **retry a rejected token once after ~2s** before accepting it as the end of
results — treating the first rejection as "no more pages" caps every tile at 20
instead of 60 and silently loses two thirds of the city.

**Rate limit: 8 requests/sec, enforced in the adapter.** `SearchTextRequest` is
capped at 600/min and the quota is marked *not adjustable*, so Google will not
raise it. At pipeline concurrency every tile x keyword fires at once, thousands
per minute, and the overflow returns `429 RESOURCE_EXHAUSTED`. That failure is
silent in the worst way: fewer results, no crash, and a vertical that reads as
thin rather than truncated. Use one module-level dispenser so the ceiling holds
across concurrent callers, back off exponentially on 429 and 5xx, and pace
retries through the same dispenser so a retry storm cannot exceed quota. The field mask is **exhaustive** — requesting a field not on that
list is a bug (it raises the SKU tier for no benefit) — with one exception:
`nextPageToken` is a **response-level** field, not place data. It costs nothing,
and omitting it means the response never carries a token, so every tile caps at
`pageSize` and pagination silently never runs. It must be in the mask.

`websiteUri` is the entire reason for the call. A result with no `websiteUri` is
recorded with `domain: null` and counted in `discovered` but never qualified.

### 2.3 Grid tiling

A single query returns at most ~60 results, so the city is covered by tiles.

```jsonc
// config/city.json
{
  "city": "Coimbatore",
  "bbox": {"south": 10.89, "west": 76.87, "north": 11.14, "east": 77.11},
  "grid": {"rows": 3, "cols": 3}
}
```

Emit 9 sub-rectangles and run every keyword against every tile. 5 keywords × 9
tiles × up to 3 pages = at most 135 requests per vertical. That is the volume the
daily quota cap must accommodate.

The bbox is a **constant**. Do not geocode it at runtime — that would add an API
dependency for a value that never changes.

### 2.4 Keywords

```jsonc
// config/verticals.json
[
  {"slug":"interior-design","label":"Interior Design","enabled":true,
   "keywords":["interior designer","interior decorator","modular kitchen",
               "false ceiling","turnkey interiors"]},
  {"slug":"clinics","label":"Clinics & Polyclinics","enabled":false,
   "keywords":["multispeciality clinic","polyclinic","family physician"]},
  {"slug":"dental","label":"Dental","enabled":false,
   "keywords":["dental clinic","orthodontist","implant dentist"]}
]
```

Only `interior-design` is enabled for the first run. Query text is
`` `${keyword} ${city}` ``.

### 2.5 Deduplication — by registrable domain, not URL

```js
const { getDomain } = require('tldts');   // pinned. do not hand-roll.

function registrable(url) {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return getDomain(h) || null;          // handles co.in, co.uk correctly
  } catch { return null; }
}
```

Merge rules when two results share a domain:
- Keep the entry with the **higher `review_count`** (the main listing, not a
  branch).
- Union the contact fields — keep any non-null `phone` or `address`.
- Record both `provider_id`s in `also_seen_as` for traceability.

Also dedupe by `provider_id` first (the same place appears in adjacent tiles).

**Never merge on a portal domain** (the §2.6.1 list, or any §2.6 reject). Forty
brokers each listing a `99acres.com` profile share one registrable domain, so
merging would keep the single highest-review entry and discard the other
thirty-nine — not as skips, but entirely. Route those to the no-domain path,
which keeps every business separate. Dedup runs *before* classification, so this
guard has to live in the dedup itself.

### 2.6 Domains that are never leads

Reject at discovery, before writing:

```
facebook.com  instagram.com  linkedin.com  twitter.com  x.com  youtube.com
justdial.com  sulekha.com  indiamart.com  tradeindia.com  urbanpro.com
wa.me  api.whatsapp.com  linktr.ee  bit.ly  goo.gl  maps.app.goo.gl
sites.google.com  business.site          ← Google Business auto-sites
wixsite.com  weebly.com  blogspot.com  wordpress.com  webnode.*  jimdosite.com
```

A business whose only "website" is one of these has no site to redesign. Record
it with `domain: null` and `skip_reason: "aggregator-or-social-only"`.

Note `business.site` and `sites.google.com` specifically: these are free Google
auto-generated pages, which is the strongest possible signal of *zero* ability to
pay.

### 2.6.1 Portal profiles are greenfield leads, not rejects

A business whose only "website" is a vertical lead portal is a **different kind
of lead, not a worse one**. It pays that portal monthly for leads it does not
own, which proves budget and proves intent — the pitch is a first website, not a
redesign. Keep it with `domain: null` and
`skip_reason: "aggregator-profile-only"`, distinct from the social-only reason
above, so `report` can bucket the two differently.

```
99acres.com  magicbricks.com  housing.com  nobroker.in  commonfloor.com
squareyards.com  proptiger.com  olx.in                ← property
practo.com  lybrate.com  credihealth.com  1mg.com      ← health
makemytrip.com  booking.com  agoda.com  goibibo.com
tripadvisor.in  oyorooms.com  airbnb.co.in            ← hospitality
wedmegood.com  shaadisaga.com  weddingwire.in         ← weddings
urbancompany.com  cult.fit  zomato.com  swiggy.com     ← services
```

The portal itself is never a lead — 99acres is Info Edge, Practo is a unicorn,
and both have in-house design teams. Only the business whose profile lives there
is.

### 2.7 Output

Write `data/<vertical>/_discovered.json` exactly as specified in
`MASTER.md §4.0`. Include the query provenance block (`tiles`, `keywords`,
`raw_results`) — it is how you later explain why a business was missed.

---

## 3. Stage 2 — `qualify`

Cheap, no browser, ~50ms per site. Runs over `_discovered.json` entries that have
a non-null `domain`.

### 3.1 Four probes, in this order, short-circuiting

**1. HTTP reachability.** `HEAD` with `redirect: follow`, 8s timeout, then `GET`
with `Range: bytes=0-8191` if `HEAD` returns 405 (common on old Apache).
Record `http_status`, `final_url`, the full `redirect_chain`, and the `server`
and `x-powered-by` headers.

```
skip when: DNS failure · connection refused · timeout · status >= 400
           · final_url host is in the §2.6 reject list (a redirect to Facebook)
```

**2. TLS.** From the TLS socket for the `https://` attempt, capture
`valid_to`. An expired or invalid certificate is **not** a skip — it is one of the
highest-value findings in the whole system, because it is provable in one
screenshot and urgent today. Record it and continue.

```js
// https.get(..., res => { const c = res.socket.getPeerCertificate(); ... })
// → cert_expires: c.valid_to, and https: "expired 2024-11" when past
```

**3. Parked-page detection.** Read the first 8KB of body and reject on:

```
/this domain (is for sale|has expired)/i     /buy this domain/i
/sedoparking|parkingcrew|bodis|afternic|dan\.com/i
/default web site page|apache2 (ubuntu|debian) default/i
/index of \//i                               /coming soon/i  (when body < 2KB)
/<title>\s*(untitled|new page \d)/i
```

Also reject when the body is under 512 bytes with no `<img>` and no `<a href>`.

**4. Wayback first snapshot.** One request, no key:

```
https://web.archive.org/cdx/search/cdx
  ?url=<domain>&output=json&fl=timestamp&limit=1&filter=statuscode:200
```

Record the year as `wayback_first`. On any failure or empty result, record
`"none"` and continue — Wayback being down must never fail a run. Cache per
domain so a re-run with `--resume` does not re-request.

Also grab `&limit=-1` for the **last** snapshot only if the first call succeeded;
skip otherwise. Two requests per domain maximum.

### 3.2 Viewport probe — the one HTML read

From the body already fetched, a single regex decides the highest-signal field in
the system:

```js
const hasViewport = /<meta[^>]+name\s*=\s*["']?viewport["']?/i.test(head8k);
```

Record `viewport_meta: true|false`. W3 re-derives this properly from the full
saved HTML later; this early copy exists so `qualify` can report how many
candidates are mobile-broken before the slow stage runs.

### 3.3 Politeness

`MASTER.md §8` applies in full. In particular: robots.txt is honoured **here
too** — a domain that disallows `/` is skipped with
`skip_reason: "robots-disallow"`, not fetched anyway. Global concurrency 8, one
request per host at a time, 1500ms minimum between requests to the same host.

### 3.4 Output

Write `data/<vertical>/_qualified.json` per `MASTER.md §4.0`. Every input
business appears in the output — `verdict: "skip"` entries are retained with
their `reason`, never dropped. You need them to answer "why isn't X in my list".

Print a summary table to stdout:

```
discovered      412
with domain     147   (35%)
qualified       124
  skipped        23
    dead host     9
    parked        7
    aggregator    5
    robots        2
mobile-broken    71   (57% of qualified)
expired certs     3   ← highest-value leads
```

---

## 4. CLI surface

```
node src/cli discover <vertical> [--source places-new|brave|fixture]
                                 [--limit N] [--dry-run]
node src/cli qualify  [<vertical>] [--resume] [--concurrency 8]
```

`--dry-run` prints the exact request list and estimated call count without
sending anything. Run it before the first real sweep so the quota impact is known
in advance.

`--limit N` caps businesses processed, for development.

## 5. Config and secrets

```
.env                      GOOGLE_PLACES_KEY=...     (gitignored, never logged)
config/city.json          bbox + grid
config/verticals.json     slugs + keywords
```

Never log the key, never include it in an error message, never write it into
`_discovered.json`. Read it once at startup; fail immediately with a clear
message if `--source places-new` is requested and the key is absent.

## 6. Recorded fixtures — build these as you go

Save every raw provider response to `fixtures/places/<vertical>-<tile>-<kw>.json`
on the first real run. The `fixture` adapter replays them. This gives:

- a credential-free development loop,
- deterministic tests,
- the ability to re-run discovery logic changes without spending quota.

## 7. Acceptance criteria

1. `discover interior-design --source fixture` produces a valid
   `_discovered.json` against `MASTER.md §4.0` with no network access.
2. Two results sharing a registrable domain collapse to one entry, keeping the
   higher `review_count`.
3. `co.in` and `co.uk` domains are split correctly (`lakshmifalseceiling.co.in`
   is one domain, not `co.in`).
4. `rating` and `review_count` survive into `_qualified.json` for every entry.
   **This is the ability-to-pay axis; losing it silently ruins every tier.**
5. A domain redirecting to `facebook.com` is skipped with a reason, not audited.
5b. Forty businesses each listing a `99acres.com` profile produce **forty**
   entries with `skip_reason: "aggregator-profile-only"`, not one merged entry.
5c. `discover` issues no more than 8 Places requests per second, and a 429 is
   retried with backoff rather than dropping the tile.
6. An expired certificate is recorded and the domain still qualifies.
7. Wayback unreachable → `wayback_first: "none"`, run completes normally.
8. `qualify --resume` re-runs in under 2s when everything is already qualified.
9. robots.txt disallowing `/` results in a skip, and no request to that path
   appears in the log.
10. The key never appears in stdout, any JSON file, or any error message.

## 8. Do not

- Do not scrape Google Maps HTML. The API path is cheap and the terms are clear.
- Do not fetch more than 2 pages of a lead's own site here — that is W2's job.
- Do not guess a website URL from a business name.
- Do not cache Places `displayName`/`rating` beyond the run; derive durable
  contact data from the business's own site in W3 instead.
- Do not add fields to the field mask "in case they're useful later".
