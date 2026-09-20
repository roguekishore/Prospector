'use strict';

/**
 * Brave Search API adapter (stub — requires separate BRAVE_KEY in .env).
 * Implements the same provider interface as places.js.
 */

/**
 * @param {object} opts
 * @param {string} opts.keyword
 * @param {object} opts.tile       { south, west, north, east }
 * @param {string} opts.apiKey
 * @param {AbortSignal} [opts.signal]
 * @param {string} opts.city
 * @returns {Promise<import('./provider').RawBusiness[]>}
 */
async function search({ keyword, tile: _tile, apiKey, signal, city }) {
  const q = encodeURIComponent(`${keyword} ${city}`);
  const url = `https://api.search.brave.com/res/v1/web/search?q=${q}&count=20`;

  const res = await fetch(url, {
    headers: {
      'Accept': 'application/json',
      'Accept-Encoding': 'gzip',
      'X-Subscription-Token': apiKey,
    },
    signal,
  });

  if (!res.ok) {
    throw new Error(`Brave Search API error ${res.status}`);
  }

  const data = await res.json();
  const results = [];

  for (const item of (data.web?.results || [])) {
    results.push({
      provider_id:     item.url,
      name:            item.title || '',
      website_raw:     item.url || null,
      rating:          null,
      review_count:    null,
      address:         null,
      phone:           null,
      lat:             null,
      lng:             null,
      business_status: null,
      primary_type:    null,
    });
  }

  return results;
}

module.exports = { search };
