/* src/extract/contacts.js
   Extract phones, emails, address, socials from rendered HTML.
   owner is provisional ("business") — report finalises via cross-site rule.
   W3 §1.4, MASTER.md §7.3 */
'use strict';

const REJECT_EMAIL_DOMAINS = new Set([
  'example.com','sentry.io','wixpress.com','cloudflare.com',
  'schema.org','w3.org','google.com','googleapis.com',
]);

// Normalise phone for cross-site comparison
function normalisePhone(v) {
  return v.replace(/[\s\-().+]/g, '').replace(/^(?:91|0)/, '');
}

// Normalise email for cross-site comparison
function normaliseEmail(v) {
  return v.toLowerCase().trim();
}

function extractContacts($rendered, qualified, domain) {
  const contacts = [];
  const seen     = new Map(); // normalised → contact

  // ---- phones ----
  const phoneRe1 = /(?:\+?91[\s\-]?)?(?:0)?([6-9]\d{9})\b/g;
  const phoneRe2 = /(?:\+?91[\s\-]?)?(?:0?422)[\s\-]?(\d{6,7})\b/g;

  const badPhoneRe = /^\d{6}$/;

  function addPhone(raw) {
    const normalised = normalisePhone(raw);
    if (normalised.length < 7) return;
    if (badPhoneRe.test(normalised)) return;
    if (seen.has('p:' + normalised)) return;
    seen.set('p:' + normalised, true);

    // Format as +91 XXXXX XXXXX for 10-digit, or +91 422 XXXXXX for landline
    let formatted;
    if (normalised.length === 10 && /^[6-9]/.test(normalised)) {
      formatted = `+91 ${normalised.slice(0,5)} ${normalised.slice(5)}`;
    } else if (normalised.length >= 6 && normalised.startsWith('422')) {
      formatted = `+91 ${normalised.slice(0,3)} ${normalised.slice(3)}`;
    } else {
      formatted = `+91 ${normalised}`;
    }
    contacts.push({ kind:'phone', value:formatted, owner:'business' });
  }

  // Prefer tel: hrefs
  $rendered('a[href^="tel:"]').each((_, el) => {
    const href = $rendered(el).attr('href') || '';
    const num  = href.replace('tel:', '').trim();
    addPhone(num);
  });

  // Body text phones
  const bodyText = $rendered('body').text();
  let m;
  phoneRe1.lastIndex = 0;
  while ((m = phoneRe1.exec(bodyText))) addPhone(m[0]);
  phoneRe2.lastIndex = 0;
  while ((m = phoneRe2.exec(bodyText))) addPhone(m[0]);

  // Fallback: if no phone found on the page, use the Places-supplied number.
  // Marked owner:'places' so the cross-site frequency rule never reassigns it.
  if (!contacts.some(c => c.kind === 'phone') && qualified?.phone) {
    const normalised = normalisePhone(qualified.phone);
    if (normalised.length >= 7 && !badPhoneRe.test(normalised)) {
      contacts.push({ kind:'phone', value:qualified.phone, owner:'places' });
    }
  }

  // ---- emails ----
  const emailRe = /[\w.+\-]+@[\w\-]+\.[\w.]{2,}/g;

  function addEmail(v) {
    const low = v.toLowerCase().trim();
    if (seen.has('e:' + low)) return;
    // Reject bad domains
    const domainPart = low.split('@')[1] || '';
    if (REJECT_EMAIL_DOMAINS.has(domainPart)) return;
    if (/\.(png|jpg|gif|webp|svg)$/.test(domainPart)) return;
    if (/^(noreply|no-reply|donotreply)@/.test(low)) return;
    seen.set('e:' + low, true);
    contacts.push({ kind:'email', value:low, owner:'business' });
  }

  // mailto: hrefs first
  $rendered('a[href^="mailto:"]').each((_, el) => {
    const href = $rendered(el).attr('href') || '';
    const email = href.replace('mailto:', '').split('?')[0].trim();
    if (email) addEmail(email);
  });

  // Body text scan — skip script content
  const bodyNoScript = $rendered('body').clone();
  bodyNoScript.find('script').remove();
  const cleanText = bodyNoScript.text();
  emailRe.lastIndex = 0;
  while ((m = emailRe.exec(cleanText))) addEmail(m[0]);

  // ---- whatsapp ----
  $rendered('a[href*="wa.me/"]').each((_, el) => {
    const href = $rendered(el).attr('href') || '';
    const raw  = href.replace(/.*wa\.me\//,'').split(/[/?#]/)[0];
    if (!raw) return;
    const normalised = normalisePhone(raw);
    if (normalised.length < 7) return;
    if (seen.has('wa:' + normalised)) return;
    seen.set('wa:' + normalised, true);
    contacts.push({ kind:'whatsapp', value:`https://wa.me/91${normalised}`, owner:'business' });
  });

  // ---- socials ----
  $rendered('a[href*="instagram.com/"]').each((_, el) => {
    const href = $rendered(el).attr('href') || '';
    const path = href.replace(/.*instagram\.com\//,'').split(/[/?#]/)[0];
    if (path && path !== 'share' && path !== 'p' && path.length > 0) {
      const val = `@${path}`;
      if (!seen.has('i:' + path)) {
        seen.set('i:' + path, true);
        contacts.push({ kind:'instagram', value:val, owner:'business' });
      }
    }
  });

  $rendered('a[href*="facebook.com/"]').each((_, el) => {
    const href = $rendered(el).attr('href') || '';
    const path = href.replace(/.*facebook\.com\//,'').split(/[/?#]/)[0];
    if (path && !['share','sharer','dialog'].includes(path) && path.length > 0) {
      if (!seen.has('fb:' + path)) {
        seen.set('fb:' + path, true);
        contacts.push({ kind:'facebook', value:`facebook.com/${path}`, owner:'business' });
      }
    }
  });

  // ---- address ----
  let address = 'none';

  // 1. <address> tag
  const addrEl = $rendered('address').first();
  if (addrEl.length) {
    address = addrEl.text().replace(/\s+/g, ' ').trim();
  }

  // 2. JSON-LD PostalAddress
  if (address === 'none') {
    $rendered('script[type="application/ld+json"]').each((_, el) => {
      if (address !== 'none') return false;
      try {
        const data = JSON.parse($rendered(el).html() || '{}');
        const findAddr = obj => {
          if (!obj || typeof obj !== 'object') return null;
          if (obj['@type'] === 'PostalAddress') {
            return [obj.streetAddress, obj.addressLocality,
                    obj.addressRegion, obj.postalCode]
              .filter(Boolean).join(', ');
          }
          for (const v of Object.values(obj)) {
            const r = findAddr(Array.isArray(v) ? v[0] : v);
            if (r) return r;
          }
          return null;
        };
        const found = findAddr(data);
        if (found) address = found;
      } catch(_) {}
    });
  }

  // 3. Text block with Coimbatore PIN
  if (address === 'none') {
    const bodyTxt = $rendered('body').text();
    const pinRe = /([^.!?\n]{0,80}6[34]\d{4}[^.!?\n]{0,40})/g;
    const pinM  = pinRe.exec(bodyTxt);
    if (pinM) address = pinM[1].replace(/\s+/g, ' ').trim();
  }

  // 4. Fallback to Places address
  if (address === 'none' && qualified?.address) {
    address = qualified.address;
  }

  // ---- hours (JSON-LD) ----
  $rendered('script[type="application/ld+json"]').each((_, el) => {
    try {
      const data = JSON.parse($rendered(el).html() || '{}');
      const hours = data.openingHours || data.openingHoursSpecification;
      if (hours) {
        const hStr = Array.isArray(hours) ? hours.join(', ') : String(hours);
        if (!seen.has('h:' + hStr)) {
          seen.set('h:' + hStr, true);
          contacts.push({ kind:'hours', value:hStr, owner:'business' });
        }
      }
    } catch(_) {}
  });

  return { address, contacts };
}

module.exports = { extractContacts, normalisePhone, normaliseEmail };
