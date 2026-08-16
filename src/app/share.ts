/**
 * Shareable links + persistence.
 *
 * - The URL hash encodes the statement and display options, so a copied link
 *   reproduces the exact diagram (`#s=A+%26+B&v=tf&a=1&l=0`).
 * - Formula history and display settings survive reloads via localStorage.
 */

import { TruthValue } from '../logic/TruthValue.ts';
import type { GeometryStyle } from '../geometry/VennsConstruction.ts';

export interface ShareState {
  statement: string;
  displayMethod: number; // TruthValue.TRUE_FALSE | ZERO_ONE
  alphabetize: boolean;
  showLabels: boolean;
  style: GeometryStyle;
}

export function encodeShareHash(state: ShareState): string {
  const params = new URLSearchParams();
  params.set('s', state.statement);
  params.set('v', state.displayMethod === TruthValue.ZERO_ONE ? '01' : 'tf');
  if (state.alphabetize) params.set('a', '1');
  if (!state.showLabels) params.set('l', '0');
  if (state.style === 'classic') params.set('g', 'q');
  return `#${params.toString()}`;
}

export function parseShareHash(hash: string): ShareState | null {
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (raw.length === 0) return null;
  try {
    const params = new URLSearchParams(raw);
    const statement = params.get('s');
    if (statement === null || statement.trim().length === 0) return null;
    return {
      statement,
      displayMethod: params.get('v') === '01' ? TruthValue.ZERO_ONE : TruthValue.TRUE_FALSE,
      alphabetize: params.get('a') === '1',
      showLabels: params.get('l') !== '0',
      style: params.get('g') === 'q' ? 'classic' : 'circular',
    };
  } catch {
    return null;
  }
}

/* ------------------------------ localStorage ------------------------------- */

const STORAGE_KEY = 'venn-diagrams-web:v1';

export interface PersistedState {
  history: string[];
  displayMethod: number;
  alphabetize: boolean;
  showLabels: boolean;
  highlightMainColumn: boolean;
  showRowNumbers: boolean;
  alternateRowColors: boolean;
  showColumnNumbers: boolean;
  style: GeometryStyle;
  theme?: 'light' | 'dark';
  viewMode?: 'fills' | 'sets';
}

export function loadPersisted(): Partial<PersistedState> | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    return parsed as Partial<PersistedState>;
  } catch {
    return null; // private mode / storage disabled — run with defaults
  }
}

export function savePersisted(state: PersistedState): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    /* storage unavailable — non-fatal */
  }
}
