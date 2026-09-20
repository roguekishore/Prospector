'use strict';

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

const { getDomain } = require('tldts');

/**
 * Return the registrable domain (public-suffix + 1 label) for a URL,
 * lowercased with no scheme, www, port, path, or trailing slash.
 * Uses tldts — handles co.in, co.uk correctly.
 * Returns null when the URL is absent or unparseable.
 *
 * @param {?string} url
 * @returns {?string}
 */
function registrable(url) {
  if (!url) return null;
  try {
    const h = new URL(url).hostname.toLowerCase();
    return getDomain(h) || null;
  } catch {
    return null;
  }
}

module.exports = { registrable };
