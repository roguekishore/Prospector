'use strict';

/**
 * Google Places API (New) adapter.
 * POST https://places.googleapis.com/v1/places:searchText
 *
 * Paginates up to 3 pages per tile×keyword. Returns RawBusiness[].
 * The key is NEVER logged or written to disk.
 */

const PLACES_URL = 'https://places.googleapis.com/v1/places:searchText';

const FIELD_MASK = [
  // Response-level field, NOT place data. Places API (New) omits nextPageToken
  // from the response unless it is named in the mask, so leaving it out caps
  // every tile at pageSize results and pagination silently never happens.
  'nextPageToken',
  'places.id',
  'places.displayName',
  'places.websiteUri',
  'places.rating',
  'places.userRatingCount',
  'places.formattedAddress',
  'places.nationalPhoneNumber',
  'places.location',
  'places.businessStatus',
  'places.primaryType',
].join(',');

// ---------------------------------------------------------------------------
// Rate limiting — SearchTextRequest is capped at 600/min and is NOT adjustable.
//
// Google will not raise this on request, so the pacing has to live here. At the
// pipeline's default concurrency every tile x keyword would fire at once,
// several thousand per minute, and the overflow comes back as 429
// RESOURCE_EXHAUSTED. That failure is silent in the worst way: fewer results,
// no crash, and a vertical that looks thin rather than truncated.
//
// 8 req/sec = 480/min, leaving 120/min of headroom. Module-level ticket
// dispenser, so it holds across every concurrent caller in the process.
// ---------------------------------------------------------------------------
const MIN_SPACING_MS = 125;          // 8 requests/sec
let nextSlot = 0;

async function acquireSlot() {
  const now  = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot   = slot + MIN_SPACING_MS;
  const wait = slot - now;
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/**
 * POST to Places with rate limiting and backoff on 429/5xx.
 * Retries are paced by the same dispenser, so a retry storm cannot exceed quota.
 * @returns {Promise<{ok:boolean, status:number, data:?object}>}
 */
async function postSearch(body, apiKey, signal, log) {
  let delay = 1000;
  for (let attempt = 0; attempt < 5; attempt++) {
    await acquireSlot();
    let res;
    try {
      res = await fetch(PLACES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': apiKey,
          'X-Goog-FieldMask': FIELD_MASK,
        },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      if (attempt === 4) throw err;
      await sleep(delay); delay *= 2;
      continue;
    }

    if (res.ok) return { ok: true, status: res.status, data: await res.json() };

    // 429 = quota, 5xx = transient. Both are worth waiting out.
    if (res.status === 429 || res.status >= 500) {
      if (log) log(`[places] ${res.status}, backing off ${delay}ms`);
      await sleep(delay); delay *= 2;
      continue;
    }

    // 4xx other than 429 is a real error (bad key, bad request). Do not retry.
    const text = await res.text().catch(() => '');
    // Never include the key in the error message
    throw new Error(`Places API error ${res.status}: ${text.slice(0, 200)}`);
  }
  return { ok: false, status: 429, data: null };
}

/**
 * @param {object} opts
 * @param {string} opts.keyword   e.g. "interior designer"
 * @param {object} opts.tile      { south, west, north, east }
 * @param {string} opts.apiKey
 * @param {AbortSignal} [opts.signal]
 * @param {string} opts.city
 * @returns {Promise<import('./provider').RawBusiness[]>}
 */
async function search({ keyword, tile, apiKey, signal, city, log }) {
  const results = [];
  let pageToken = null;
  let page = 0;
  let httpCalls = 0;   // actual requests billed, retries included

  while (page < 3) {
    const body = {
      textQuery: `${keyword} ${city}`,
      locationRestriction: {
        rectangle: {
          low:  { latitude: tile.south, longitude: tile.west },
          high: { latitude: tile.north, longitude: tile.east },
        },
      },
      pageSize: 20,
      languageCode: 'en',
    };
    if (pageToken) body.pageToken = pageToken;

    let { ok, data } = await postSearch(body, apiKey, signal, log);
    httpCalls++;

    // A pageToken is not always valid the instant the previous page returns.
    // Treating that rejection as "no more pages" would cap every tile at 20
    // results instead of 60 and silently lose two thirds of the city, so give
    // the token one more chance before believing it.
    if (!ok && pageToken) {
      await sleep(2000);
      ({ ok, data } = await postSearch(body, apiKey, signal, log));
      httpCalls++;
    }
    if (!ok || !data) break;

    const places = data.places || [];

    for (const p of places) {
      results.push(placeToRaw(p));
    }

    pageToken = data.nextPageToken || null;
    page++;
    if (!pageToken) break;
  }

  // Request accounting for the caller. Attached to the array rather than
  // changing the return type, so `brave` and `fixture` — which never paginate —
  // keep satisfying the same provider contract untouched. Run 1 left no record
  // of either number, which is why its truncation went unnoticed for two days.
  Object.defineProperty(results, '_pages',    { value: page,      enumerable: false });
  Object.defineProperty(results, '_requests', { value: httpCalls, enumerable: false });
  return results;
}

/**
 * Convert a raw Places API place object to a RawBusiness.
 * @param {object} p
 * @returns {import('./provider').RawBusiness}
 */
function placeToRaw(p) {
  return {
    provider_id:     p.id || null,
    name:            p.displayName?.text || '',
    website_raw:     p.websiteUri || null,
    rating:          typeof p.rating === 'number' ? p.rating : null,
    review_count:    typeof p.userRatingCount === 'number' ? p.userRatingCount : null,
    address:         p.formattedAddress || null,
    phone:           p.nationalPhoneNumber || null,
    lat:             p.location?.latitude ?? null,
    lng:             p.location?.longitude ?? null,
    business_status: p.businessStatus || null,
    primary_type:    p.primaryType || null,
  };
}

module.exports = { search };
