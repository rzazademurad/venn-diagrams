/**
 * Help dialog — the "Quick Guide of Usage" content ported from
 * `BottomPanel.Help` in the original application, plus the web port's
 * interaction cheatsheet. Accessible: focus is trapped while open, Escape
 * closes, and focus returns to the previously focused element.
 */

import { useEffect, useRef } from 'react';

export interface HelpModalProps {
  open: boolean;
  onClose(): void;
}

const GUIDE_ROWS: [string, string][] = [
  ['Propositions', 'letters A, B, …, Z'],
  ['Universal Set', '1'],
  ['Empty Set', '0'],
  ['Parentheses', '( )'],
  ['Exclusive-or', '+'],
  ['Or', '|'],
  ['Negation', '~ , !'],
  ['And', '& , ^'],
  ['Implication', '=> , ->'],
  ['Bi-Implication', '<=> , <->'],
];

export function HelpModal(props: HelpModalProps): React.JSX.Element | null {
  const dialogRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  // Focus trap + Escape + focus restore.
  useEffect(() => {
    if (!props.open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    const dialog = dialogRef.current;
    dialog?.querySelector<HTMLElement>('button')?.focus();
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        props.onClose();
        return;
      }
      if (e.key !== 'Tab' || dialog === null) return;
      const focusables = [...dialog.querySelectorAll<HTMLElement>('button, [href], input, [tabindex]:not([tabindex="-1"])')];
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      restoreFocusRef.current?.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.open]);

  if (!props.open) return null;
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 dark:bg-black/60"
      onClick={props.onClose}
      role="dialog"
      aria-modal="true"
      aria-label="Quick Guide of Usage"
    >
      <div
        ref={dialogRef}
        className="w-full max-w-md rounded-xl bg-white p-6 shadow-2xl dark:bg-slate-900 dark:ring-1 dark:ring-slate-700"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-1 text-center text-lg font-bold text-slate-800 dark:text-slate-100">Quick Guide of Usage</h2>
        <div className="mb-3 border-b border-dashed border-slate-300 dark:border-slate-600" />
        <table className="w-full text-sm">
          <tbody>
            {GUIDE_ROWS.map(([label, symbols]) => (
              <tr key={label} className="border-b border-slate-100 last:border-0 dark:border-slate-800">
                <td className="py-1.5 pr-4 text-slate-600 dark:text-slate-300">{label}</td>
                <td className="py-1.5 font-mono font-semibold text-slate-900 dark:text-slate-100">{symbols}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-slate-500 dark:text-slate-400">
          <li>Scroll / pinch to zoom; drag to pan; the buffer re-crisps automatically.</li>
          <li>Hover a region for its minterm; click to spotlight its truth-table row.</li>
          <li>
            Keyboard: <kbd>+</kbd>/<kbd>−</kbd> zoom, <kbd>0</kbd> fit, <kbd>L</kbd> labels, <kbd>D</kbd> theme,{' '}
            <kbd>[</kbd>/<kbd>]</kbd> walk regions (canvas focused).
          </li>
          <li>Regions where the statement is true are flood-filled orange.</li>
          <li>▶ Replay animates Venn's inductive construction curve by curve.</li>
        </ul>
        <p className="mt-4 border-t border-slate-100 pt-3 text-center text-[11px] leading-relaxed text-slate-400 dark:border-slate-800 dark:text-slate-500">
          Algorithms &amp; application by <span className="font-semibold">Murad Rzazade</span>
          <br />
          School of Computer Science, University of Manchester
        </p>
        <div className="mt-4 text-center">
          <button
            className="rounded-md bg-uom-600 px-6 py-1.5 text-sm font-semibold text-white hover:bg-uom-500 focus-visible:outline-2 focus-visible:outline-uom-400"
            onClick={props.onClose}
          >
            Ok
          </button>
        </div>
      </div>
    </div>
  );
}
