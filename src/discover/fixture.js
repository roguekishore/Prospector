'use strict';

/**
 * Fixture adapter — replays recorded provider responses from
 * fixtures/places/<vertical>-tile<N>-<kw-slug>.json
 *
 * Returns an empty array (not an error) when the fixture file is absent,
 * so partial fixture sets work fine during development.
 */

const path = require('path');
const fs   = require('fs');

const ROOT = path.resolve(__dirname, '..', '..', 'fixtures', 'places');

/**
 * @param {object} opts
 * @param {string} opts.keyword
 * @param {object} opts.tile        { south, west, north, east, _index }
 * @param {string} opts.vertical
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<import('./provider').RawBusiness[]>}
 */
async function search({ keyword, tile, vertical }) {
  const kwSlug = keyword.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9-]/g, '');
  const tileId = `tile${tile._index}`;
  const file   = path.join(ROOT, `${vertical}-${tileId}-${kwSlug}.json`);

  if (!fs.existsSync(file)) return [];

  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw);
}

module.exports = { search };
