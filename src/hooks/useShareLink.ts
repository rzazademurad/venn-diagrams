/**
 * Shareable-URL plumbing: keeps the hash in sync with the current diagram and
 * provides the copy-link action with its transient "Copied ✓" state.
 */

import { useCallback, useEffect, useState } from 'react';
import { encodeShareHash, type ShareState } from '../app/share.ts';

export function useShareLink(current: ShareState | null): {
  linkCopied: boolean;
  copyShareLink: () => void;
} {
  const [linkCopied, setLinkCopied] = useState(false);

  useEffect(() => {
    if (current !== null) {
      const hash = encodeShareHash(current);
      window.history.replaceState(null, '', `${window.location.pathname}${window.location.search}${hash}`);
    }
  }, [current]);

  const copyShareLink = useCallback((): void => {
    void navigator.clipboard
      ?.writeText(window.location.href)
      .then(() => {
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 1500);
      })
      .catch(() => {
        /* clipboard unavailable */
      });
  }, []);

  return { linkCopied, copyShareLink };
}
