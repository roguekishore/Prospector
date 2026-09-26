'use strict';

/**
 * One run at a time, and the log it produces.
 *
 * ## Why only one
 *
 * Two concurrent local captures would fight for the same 2 GB and the same
 * per-host throttle, and the second would re-capture what the first is mid-way
 * through. The single-slot lock is the whole concurrency design: `start()`
 * refuses while a run is live, and the UI disables its buttons on the same flag.
 *
 * ## Why the log is a ring
 *
 * A 9,600-domain run emits a line per domain plus retries — tens of thousands of
 * lines over sixteen hours. Keeping them all would grow the server's heap for the
 * entire run to serve a scrollback nobody reads past the last screen. The ring
 * holds the last 500; the full log belongs in a file if it is ever wanted, not in
 * memory.
 *
 * ## Stopping
 *
 * SIGTERM, then SIGKILL after a grace period. Capture writes per-domain atomic
 * files, so a killed run loses at most the domain in flight and `--resume` picks
 * up exactly where it stopped. That is what makes "stop" a safe button rather
 * than a destructive one.
 */

const { spawn } = require('child_process');
const path      = require('path');
const EventEmitter = require('events');

const LOG_LINES   = 500;
const KILL_GRACE  = 8_000;

class Runner extends EventEmitter {
  constructor(root) {
    super();
    this.root   = root;
    this.child  = null;
    this.state  = null;   // { mode, label, argv, startedAt, pid }
    this.lines  = [];
    this.exit   = null;   // { code, signal, at } of the last finished run
    this._sequence = null;
  }

  get running() { return this.child !== null; }

  snapshot() {
    return {
      running:  this.running,
      state:    this.state,
      lastExit: this.exit,
      lines:    this.lines.slice(-LOG_LINES),
    };
  }

  _push(stream, text) {
    for (const raw of String(text).split(/\r?\n/)) {
      const line = raw.trimEnd();
      if (!line) continue;
      const entry = { at: Date.now(), stream, line };
      this.lines.push(entry);
      if (this.lines.length > LOG_LINES) this.lines.shift();
      this.emit('line', entry);
    }
  }

  /**
   * Start a run.
   *
   * @param {object} opts
   * @param {string} opts.mode   'local' | 'lambda' | 'pipeline'
   * @param {string[]} opts.argv  argv for the child, already assembled
   * @param {string} opts.label   human description, shown in the UI
   * @param {string} opts.script  module to run — src/cli or scripts/dispatch.js
   * @param {Array}  [opts.steps] remaining steps, for a sequence
   */
  start({ mode, argv, label, script, steps = null }) {
    if (this.running) throw new Error('A run is already in progress');
    this.lines = [];
    this.exit  = null;
    this._spawn({ mode, argv, label, script, steps, stepIndex: 0,
                  totalSteps: steps ? steps.length : 1 });
    this.emit('start', this.state);
    return this.state;
  }

  /**
   * Run stages back to back — discover → qualify → capture for a new vertical.
   *
   * A failing stage ends the sequence. Qualifying domains that discover never
   * found, or capturing a list that qualify never vetted, produces a confidently
   * empty result rather than an error, which is the worse outcome.
   *
   * @param {Array<{script: string, argv: string[], label: string}>} steps
   */
  startSequence(steps, label) {
    if (this.running) throw new Error('A run is already in progress');
    if (!steps.length) throw new Error('No steps to run');
    this.lines = [];
    this.exit  = null;
    this._sequence = { steps, label, index: 0 };
    this._spawn({
      mode: 'pipeline', label, steps,
      script: steps[0].script, argv: steps[0].argv,
      stepIndex: 0, totalSteps: steps.length, stepLabel: steps[0].label,
    });
    this.emit('start', this.state);
    return this.state;
  }

  _spawn({ mode, argv, label, script, steps, stepIndex, totalSteps, stepLabel }) {
    const file = path.join(this.root, script);
    this.child = spawn(process.execPath, [file, ...argv], {
      cwd: this.root,
      env: { ...process.env, FORCE_COLOR: '0' },
    });

    this.state = {
      mode, label, argv,
      startedAt: this.state?.startedAt || Date.now(),
      pid: this.child.pid,
      stepIndex, totalSteps,
      stepLabel: stepLabel || label,
    };

    this._push('sys',
      totalSteps > 1
        ? `[${stepIndex + 1}/${totalSteps}] ${stepLabel} — node ${script} ${argv.join(' ')}`
        : `$ node ${script} ${argv.join(' ')}`);

    this.child.stdout.on('data', d => this._push('out', d));
    this.child.stderr.on('data', d => this._push('err', d));

    this.child.on('exit', (code, signal) => {
      this.child = null;
      const seq = this._sequence;

      // Advance the sequence only on a clean exit. A stage that failed leaves the
      // next one nothing valid to read, and a stop is a stop.
      if (seq && code === 0 && !signal && seq.index + 1 < seq.steps.length) {
        seq.index += 1;
        const next = seq.steps[seq.index];
        this._push('sys', `step ${seq.index} ok → ${next.label}`);
        this._spawn({
          mode: 'pipeline', label: seq.label, steps: seq.steps,
          script: next.script, argv: next.argv,
          stepIndex: seq.index, totalSteps: seq.steps.length, stepLabel: next.label,
        });
        this.emit('start', this.state);
        return;
      }

      if (seq && (code !== 0 || signal)) {
        this._push('err',
          `pipeline halted at step ${seq.index + 1}/${seq.steps.length} (${seq.steps[seq.index].label})`);
      }

      this._push('sys', `exited code=${code} signal=${signal || 'none'}`);
      this.exit  = { code, signal, at: Date.now(), label, mode };
      this._sequence = null;
      this.state = null;
      this.emit('exit', this.exit);
    });

    this.child.on('error', err => {
      this._push('err', `spawn failed: ${err.message}`);
      this.exit  = { code: -1, signal: null, at: Date.now(), label, mode, error: err.message };
      this.child = null;
      this._sequence = null;
      this.state = null;
      this.emit('exit', this.exit);
    });
    // No 'start' emit here — every caller does it, and emitting in both places
    // would double every step transition on the wire.
  }

  stop() {
    if (!this.running) return false;
    // Drop the remaining steps first: a stop must end the pipeline, not advance
    // it to the next stage when this child exits.
    this._sequence = null;
    const child = this.child;
    this._push('sys', 'stop requested — SIGTERM');
    child.kill('SIGTERM');
    // A Chromium that has stopped responding will not honour SIGTERM. Capture is
    // per-domain atomic, so escalating loses at most the page in flight.
    setTimeout(() => {
      if (this.child === child) {
        this._push('sys', 'still alive after grace — SIGKILL');
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    }, KILL_GRACE).unref();
    return true;
  }
}

module.exports = { Runner, LOG_LINES };
