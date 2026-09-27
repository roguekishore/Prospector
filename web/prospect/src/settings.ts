import { createStore } from '@ui/store';
import type { CaptureMode, Mode } from './api';

/**
 * The run form's choices, shared with the pipeline form so "capture on this
 * box at concurrency 4" means the same thing on both tabs. Not persisted.
 */
export const settings = createStore<{ mode: Mode; vertical: string; concurrency: number; deadline: number; batch: number; pipeVertical: string; pipeMode: Exclude<CaptureMode, 'none'> }>({
  mode: 'local', vertical: '', concurrency: 2, deadline: 60_000, batch: 10, pipeVertical: '', pipeMode: 'local',
});

export const CONCURRENCY = [
  { value: 1,  label: '1 — gentlest' },
  { value: 2,  label: '2 — overnight on 2 GB' },
  { value: 4,  label: '4' },
  { value: 8,  label: '8' },
  { value: 16, label: '16 — big box only' },
];
export const DEADLINES = [
  { value: 60_000,  label: '60 s' },
  { value: 90_000,  label: '90 s' },
  { value: 120_000, label: '120 s' },
];
export const BATCHES = [
  { value: 5,  label: '5' },
  { value: 10, label: '10 — fits the 900 s ceiling' },
  { value: 15, label: '15 — risky: the worst case hits the wall' },
];
