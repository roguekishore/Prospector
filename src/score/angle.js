/* src/score/angle.js
   Angle and reason selection. W3 §4, MASTER.md §6.
   Pure function of flagged + measured + templates. */
'use strict';

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');

function loadAngles() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'angles.json'), 'utf8'));
}

function loadReasons() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'reasons.json'), 'utf8'));
}

// Walk the angles table in order; first template whose `when` keys are all
// present in flagged wins. Guard, when present, must substring-match the
// raw measured value of the first `when` key.
function pickAngle(flagged, measured, templates) {
  for (const t of templates) {
    if (!t.when.every(k => flagged.includes(k))) continue;
    if (t.guard) {
      const val = String(measured[t.when[0]] ?? '').toLowerCase();
      if (!val.includes(t.guard)) continue;
    }
    return t;
  }
  // fallback: generic catch-all (last entry)
  return templates[templates.length - 1];
}

// Generate one reason sentence per flagged key, ordered by descending weight,
// capped at 5. W3 §4, MASTER.md §4.7.
function buildReasons(flagged, reasonTemplates) {
  return flagged
    .slice(0, 5)
    .map(k => reasonTemplates[k])
    .filter(Boolean);
}

// Build pitch_angle and angle_template for score.json / index.json
function selectAngle(flagged, measured, gate) {
  const templates = loadAngles();
  const reasons   = loadReasons();

  // Gate overrides everything
  if (gate) {
    const gateAngle = gate.includes('no measurable pain') || gate.includes('nothing to sell')
      ? 'No measurable pain. Skip.'
      : `Gate: ${gate}.`;
    return {
      pitch_angle:    gateAngle,
      angle_template: 'gate',
      reasons:        [],
    };
  }

  const tpl = pickAngle(flagged, measured, templates);
  return {
    pitch_angle:    tpl.text,
    angle_template: tpl.key,
    reasons:        buildReasons(flagged, reasons),
  };
}

module.exports = { selectAngle, pickAngle, loadAngles, loadReasons };
