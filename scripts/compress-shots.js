#!/usr/bin/env node
/* Compress capture PNGs to WebP.
 *
 *   node scripts/compress-shots.js --src data --out data-webp [flags]
 *
 * Screenshots are kept only to show page structure, so they are downscaled and
 * lossy-encoded hard. Originals are never touched: output goes to a parallel
 * tree, and --swap is what replaces them once verification passes.
 *
 * Flags
 *   --src <dir>        input tree        (default data)
 *   --out <dir>        output tree       (default data-webp)
 *   --width <px>       max width, never upscales   (default 720)
 *   --quality <1-100>  webp quality      (default 50)
 *   --effort <0-6>     webp encode effort, higher = slower/smaller (default 4)
 *   --concurrency <n>  parallel encodes  (default cpus-1, capped 8)
 *   --only <vertical>  restrict to one vertical
 *   --limit <n>        stop after n files (calibration)
 *   --sample           one domain per vertical, for a fast size estimate
 *   --dry-run          report what would happen, write nothing
 *   --verify           decode every output and check dimensions
 *   --swap             after verify passes, delete src PNGs and move WebP in place
 *   --allow-failed     let --swap proceed despite conversion errors; those
 *                      originals are kept (use for known-unconvertible files)
 *   --skip-existing    leave outputs that already exist (resume)
 *   --quiet            per-vertical totals only
 */
'use strict';

const fs   = require('fs');
const path = require('path');
const os   = require('os');

let sharp;
try { sharp = require('sharp'); }
catch { die('sharp is not installed. Run: npm i sharp'); }

// WebP refuses either dimension above this.
const WEBP_MAX_DIM = 16383;
const HEIGHT_CAP   = 16000;   // margin under the hard limit
const IMAGE_RE     = /\.(png|jpe?g|webp|avif|gif)$/i;

function die(msg) { console.error('error: ' + msg); process.exit(1); }

// ---- args ----------------------------------------------------------------
function parseArgs(argv) {
  const o = {
    src: 'data', out: 'data-webp', width: 720, quality: 50, effort: 4,
    concurrency: Math.max(1, Math.min(8, os.cpus().length - 1)),
    only: null, limit: 0,
    sample: false, dryRun: false, verify: false, swap: false,
    skipExisting: false, quiet: false, allowFailed: false,
  };
  const need = (i, f) => {
    if (i + 1 >= argv.length) die(f + ' needs a value');
    return argv[i + 1];
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '--src':         o.src = need(i, a); i++; break;
      case '--out':         o.out = need(i, a); i++; break;
      case '--width':       o.width = +need(i, a); i++; break;
      case '--quality':     o.quality = +need(i, a); i++; break;
      case '--effort':      o.effort = +need(i, a); i++; break;
      case '--concurrency': o.concurrency = +need(i, a); i++; break;
      case '--only':        o.only = need(i, a); i++; break;
      case '--limit':       o.limit = +need(i, a); i++; break;
      case '--sample':        o.sample = true; break;
      case '--dry-run':       o.dryRun = true; break;
      case '--verify':        o.verify = true; break;
      case '--swap':          o.swap = true; break;
      case '--skip-existing': o.skipExisting = true; break;
      case '--allow-failed':  o.allowFailed = true; break;
      case '--quiet':         o.quiet = true; break;
      default: die('unknown flag ' + a);
    }
  }
  if (!(o.width > 0))                        die('--width must be positive');
  if (!(o.quality >= 1 && o.quality <= 100)) die('--quality must be 1-100');
  if (!(o.effort >= 0 && o.effort <= 6))     die('--effort must be 0-6');
  if (!(o.concurrency > 0))                  die('--concurrency must be positive');
  if (o.swap && o.dryRun)                    die('--swap and --dry-run are contradictory');
  return o;
}

function safeStat(p) { try { return fs.statSync(p); } catch { return null; } }

// ---- discovery -----------------------------------------------------------
// Layout is <src>/<vertical>/<domain>/<shot>.png — loose files are ignored.
function collect(opt) {
  if (!fs.existsSync(opt.src)) die('src tree not found: ' + opt.src);
  const jobs = [];
  for (const vertical of fs.readdirSync(opt.src).sort()) {
    if (opt.only && vertical !== opt.only) continue;
    const vdir = path.join(opt.src, vertical);
    if (!safeStat(vdir) || !safeStat(vdir).isDirectory()) continue;

    let domains = fs.readdirSync(vdir).sort()
      .filter(d => { const s = safeStat(path.join(vdir, d)); return s && s.isDirectory(); });
    if (opt.sample) domains = domains.slice(0, 1);

    for (const domain of domains) {
      const ddir = path.join(vdir, domain);
      for (const f of fs.readdirSync(ddir).sort()) {
        if (!IMAGE_RE.test(f)) continue;
        const src = path.join(ddir, f);
        const st  = safeStat(src);
        if (!st || !st.isFile() || st.size === 0) continue;
        const shot = f.replace(IMAGE_RE, '');
        jobs.push({
          vertical, domain, shot,
          src, srcBytes: st.size,
          out: path.join(opt.out, vertical, domain, shot + '.webp'),
        });
      }
    }
  }
  if (opt.only && !jobs.length) die('no images under vertical "' + opt.only + '"');
  return opt.limit ? jobs.slice(0, opt.limit) : jobs;
}

// ---- one file ------------------------------------------------------------
async function convert(job, opt) {
  const meta = await sharp(job.src).metadata();
  job.srcDim = [meta.width, meta.height];

  if (opt.skipExisting) {
    const prev = safeStat(job.out);
    if (prev && prev.size > 0) { job.outBytes = prev.size; job.skipped = true; return job; }
  }

  const scale   = Math.min(1, opt.width / meta.width);
  const scaledW = Math.round(meta.width * scale);
  const scaledH = Math.round(meta.height * scale);

  if (opt.dryRun) {
    job.outDim = [scaledW, Math.min(HEIGHT_CAP, scaledH)];
    if (scaledH > HEIGHT_CAP) job.truncated = scaledH;
    return job;
  }

  fs.mkdirSync(path.dirname(job.out), { recursive: true });

  let pipe = sharp(job.src).resize({
    width: opt.width,
    withoutEnlargement: true,   // a 390px mobile shot stays 390px
    fit: 'inside',
  });

  // Tall full-page shots can still exceed WebP's limit after downscaling;
  // keep the top of the page rather than failing the encode.
  if (scaledH > HEIGHT_CAP) {
    pipe = pipe.extract({ left: 0, top: 0, width: scaledW, height: HEIGHT_CAP });
    job.truncated = scaledH;
  }

  // Write to a temp name and rename, so a killed run never leaves a torn file
  // and a concurrent reader never sees a partial image.
  const tmp  = job.out + '.tmp-' + process.pid;
  const info = await pipe.webp({ quality: opt.quality, effort: opt.effort }).toFile(tmp);
  fs.renameSync(tmp, job.out);

  job.outBytes = info.size;
  job.outDim   = [info.width, info.height];
  if (info.width > WEBP_MAX_DIM || info.height > WEBP_MAX_DIM) job.oversize = true;
  return job;
}

// ---- pool ----------------------------------------------------------------
async function runPool(jobs, concurrency, work, onDone) {
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= jobs.length) return;
      const job = jobs[i];
      try { await work(job); }
      catch (err) { job.error = err.message; }
      if (onDone) onDone(job, i + 1);
    }
  });
  await Promise.all(workers);
}

// ---- verify --------------------------------------------------------------
// metadata() only reads a header; stats() forces a full decode, which is what
// actually proves the file is not truncated.
async function verifyAll(jobs, opt) {
  // Every output that --swap may move must be decoded here, including ones
  // --skip-existing left alone. Filtering those out would let
  // `--skip-existing --verify --swap` delete originals having verified
  // nothing in this run.
  const targets = jobs.filter(j => !j.error && safeStat(j.out));
  const bad = [];
  await runPool(targets, opt.concurrency, async job => {
    try {
      const m = await sharp(job.out).metadata();
      await sharp(job.out).stats();
      if (m.format !== 'webp')      bad.push([job.out, 'format ' + m.format]);
      else if (!(m.width > 0))      bad.push([job.out, 'zero width']);
      else if (job.outDim && m.width !== job.outDim[0])
        bad.push([job.out, 'width ' + m.width + ' != ' + job.outDim[0]]);
    } catch (err) { bad.push([job.out, err.message]); }
  });
  return { checked: targets.length, bad };
}

// ---- swap ----------------------------------------------------------------
function swapInPlace(jobs) {
  let moved = 0, removed = 0, bytesFreed = 0;
  for (const job of jobs) {
    if (job.error || !safeStat(job.out)) continue;
    const dest = path.join(path.dirname(job.src), path.basename(job.out));
    fs.renameSync(job.out, dest);
    moved++;
    if (path.resolve(dest) !== path.resolve(job.src)) {
      bytesFreed += job.srcBytes;
      fs.unlinkSync(job.src);
      removed++;
    }
  }
  return { moved, removed, bytesFreed };
}

// ---- reporting -----------------------------------------------------------
const mb   = b => (b / 1048576).toFixed(1);
const kb   = b => (b / 1024).toFixed(1);
const pad  = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

// A dry run cannot know output sizes, so it reports planned geometry only —
// printing an "after" column here would look like a measurement it isn't.
function dryReport(jobs) {
  const shots = new Map();
  let srcTotal = 0, truncated = 0;
  for (const job of jobs) {
    if (job.error) continue;
    if (!shots.has(job.shot)) shots.set(job.shot, { n: 0, src: 0, dims: new Map() });
    const s = shots.get(job.shot);
    s.n++; s.src += job.srcBytes; srcTotal += job.srcBytes;
    const key = (job.srcDim ? job.srcDim.join('x') : '?') + ' -> ' +
                (job.outDim ? job.outDim.join('x') : '?');
    s.dims.set(key, (s.dims.get(key) || 0) + 1);
    if (job.truncated) truncated++;
  }
  console.log('\nplanned geometry (no files written)');
  for (const entry of [...shots].sort((a, b) => a[0].localeCompare(b[0]))) {
    const name = entry[0], s = entry[1];
    console.log('  ' + pad(name, 10) + lpad(s.n, 5) + ' file(s), ' +
                lpad(mb(s.src) + ' MB', 10) + '  ' +
                lpad(kb(s.src / s.n) + ' KB avg', 14));
    for (const d of [...s.dims].sort((a, b) => b[1] - a[1]).slice(0, 4))
      console.log('      ' + pad(d[0], 30) + lpad('x' + d[1], 6));
    if (s.dims.size > 4) console.log('      ... ' + (s.dims.size - 4) + ' more size(s)');
  }
  console.log('\n' + jobs.length + ' file(s), ' + mb(srcTotal) + ' MB of input');
  if (truncated)
    console.log(truncated + ' file(s) would be clipped to ' + HEIGHT_CAP + 'px tall');
  console.log('re-run without --dry-run to measure actual output sizes');
  return { srcTotal, outTotal: 0, errors: jobs.filter(j => j.error).length };
}

function report(jobs, opt, elapsedMs) {
  if (opt.dryRun) return dryReport(jobs);
  const byVertical = new Map();
  let srcTotal = 0, outTotal = 0, errors = 0, truncated = 0, skipped = 0;

  for (const job of jobs) {
    if (!byVertical.has(job.vertical))
      byVertical.set(job.vertical, { n: 0, src: 0, out: 0, shots: new Map(), err: 0 });
    const v = byVertical.get(job.vertical);
    if (job.error) { v.err++; errors++; continue; }
    const outBytes = job.outBytes || 0;
    v.n++; v.src += job.srcBytes; v.out += outBytes;
    if (!v.shots.has(job.shot)) v.shots.set(job.shot, { n: 0, src: 0, out: 0 });
    const s = v.shots.get(job.shot);
    s.n++; s.src += job.srcBytes; s.out += outBytes;
    srcTotal += job.srcBytes; outTotal += outBytes;
    if (job.truncated) truncated++;
    if (job.skipped) skipped++;
  }

  console.log('');
  console.log(pad('VERTICAL', 22) + lpad('IMGS', 6) + lpad('BEFORE', 11) +
              lpad('AFTER', 10) + lpad('RATIO', 8) + lpad('SAVED', 11));
  for (const entry of [...byVertical].sort((a, b) => a[0].localeCompare(b[0]))) {
    const name = entry[0], v = entry[1];
    if (!v.n) continue;
    console.log(pad(name, 22) + lpad(v.n, 6) + lpad(mb(v.src) + ' MB', 11) +
                lpad(mb(v.out) + ' MB', 10) +
                lpad((v.src / (v.out || 1)).toFixed(1) + '×', 8) +
                lpad(mb(v.src - v.out) + ' MB', 11));
  }
  const n = jobs.length - errors;
  console.log('-'.repeat(68));
  console.log(pad('TOTAL', 22) + lpad(n, 6) + lpad(mb(srcTotal) + ' MB', 11) +
              lpad(mb(outTotal) + ' MB', 10) +
              lpad((srcTotal / (outTotal || 1)).toFixed(1) + '×', 8) +
              lpad(mb(srcTotal - outTotal) + ' MB', 11));

  if (!opt.quiet) {
    console.log('\nper shot type');
    const shots = new Map();
    for (const entry of byVertical)
      for (const s of entry[1].shots) {
        const name = s[0], val = s[1];
        if (!shots.has(name)) shots.set(name, { n: 0, src: 0, out: 0 });
        const t = shots.get(name);
        t.n += val.n; t.src += val.src; t.out += val.out;
      }
    for (const entry of [...shots].sort((a, b) => a[0].localeCompare(b[0]))) {
      const name = entry[0], s = entry[1];
      console.log('  ' + pad(name, 12) + lpad(s.n, 6) +
                  lpad(kb(s.src / s.n) + ' KB', 12) + '  ->' +
                  lpad(kb(s.out / s.n) + ' KB', 11) +
                  lpad((s.src / (s.out || 1)).toFixed(1) + '×', 8) + '  avg');
    }
  }

  if (truncated)
    console.log('\nnote: ' + truncated + ' file(s) taller than ' + HEIGHT_CAP +
                'px after scaling; kept the top ' + HEIGHT_CAP + 'px');
  if (skipped)
    console.log('note: ' + skipped + ' output(s) already present, left alone (--skip-existing)');
  if (errors) {
    console.log('\n' + errors + ' file(s) failed:');
    for (const job of jobs.filter(j => j.error).slice(0, 20))
      console.log('  ' + job.src + ' — ' + job.error);
    if (errors > 20) console.log('  ... and ' + (errors - 20) + ' more');
  }
  if (elapsedMs != null) {
    const sec = elapsedMs / 1000;
    console.log('\n' + n + ' file(s) in ' + sec.toFixed(1) + 's' +
                (n ? ' (' + (n / sec).toFixed(1) + '/s)' : ''));
  }
  return { srcTotal, outTotal, errors };
}

// ---- main ----------------------------------------------------------------
(async () => {
  const opt  = parseArgs(process.argv.slice(2));
  const jobs = collect(opt);
  if (!jobs.length) die('no images found under ' + opt.src);

  console.log(jobs.length + ' image(s) under ' + opt.src +
              (opt.only ? ' [vertical: ' + opt.only + ']' : '') +
              (opt.sample ? ' [sample: 1 domain/vertical]' : ''));
  console.log('-> ' + opt.width + 'px wide, webp q' + opt.quality + ' effort' + opt.effort +
              ', ' + opt.concurrency + ' worker(s)' +
              (opt.dryRun ? '  [DRY RUN]' : ' -> ' + opt.out));

  const started = Date.now();
  let lastLine = 0;
  await runPool(jobs, opt.concurrency, job => convert(job, opt), (job, done) => {
    if (opt.quiet || !process.stdout.isTTY) return;
    if (done !== jobs.length && Date.now() - lastLine < 250) return;
    lastLine = Date.now();
    process.stdout.write(('\r  ' + done + '/' + jobs.length + '  ' +
                          job.vertical + '/' + job.domain).padEnd(78).slice(0, 78));
  });
  if (!opt.quiet && process.stdout.isTTY) process.stdout.write('\r' + ' '.repeat(78) + '\r');

  const summary = report(jobs, opt, Date.now() - started);

  if (opt.verify && !opt.dryRun) {
    console.log('\nverifying outputs (full decode)...');
    const res = await verifyAll(jobs, opt);
    if (res.bad.length) {
      console.log('FAILED: ' + res.bad.length + ' of ' + res.checked + ' bad');
      for (const b of res.bad.slice(0, 20)) console.log('  ' + b[0] + ' — ' + b[1]);
      process.exitCode = 1;
      if (opt.swap) { console.log('\nrefusing to --swap: verification failed'); return; }
    } else {
      console.log('all ' + res.checked + ' output(s) decode cleanly');
    }
  }

  if (opt.swap) {
    if (!opt.verify) die('--swap requires --verify');
    // A conversion error means that source has no output to replace it, so its
    // original must survive the swap. swapInPlace already skips those jobs;
    // --allow-failed says the remaining failures are known and permanent
    // rather than a signal that the run went wrong.
    if (summary.errors && !opt.allowFailed) {
      console.log('\nrefusing to --swap: ' + summary.errors + ' conversion error(s)');
      console.log('re-run with --allow-failed to swap the rest and keep those originals');
      process.exitCode = 1;
      return;
    }
    if (summary.errors) {
      console.log('\n--allow-failed: keeping ' + summary.errors +
                  ' unconverted original(s), swapping the rest');
    }
    const sw = swapInPlace(jobs);
    console.log('\nswapped in place: ' + sw.moved + ' webp moved, ' +
                sw.removed + ' original(s) deleted, ' + mb(sw.bytesFreed) + ' MB freed');
  }
})().catch(err => die(err.stack || err.message));
