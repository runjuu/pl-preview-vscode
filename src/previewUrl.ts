/**
 * Pure builder for the loopback preview URL the webview iframe points at.
 *
 * Kept free of any `vscode`/dockerode import so it can be unit-tested with
 * `tsx --test`. The Stable Preview Variant reroll seed lives here
 * ({@link randomBase36Variant}); the qid is resolved from the active editor by
 * the `PreviewController`, which also holds the per-question seed state.
 */

/**
 * Default variant seed for a question that has never been rerolled. The preview
 * server defaults to variant 1; keeping the seed stable across refreshes is what
 * makes edit-to-edit feedback comparable (the Stable Preview Variant semantics).
 */
export const DEFAULT_VARIANT = '1';

/** Loopback origin the container's published port is reachable at. */
export function previewOrigin(port: number): string {
  return `http://127.0.0.1:${port}`;
}

export interface PreviewUrlInput {
  /** Published loopback host port of the container. */
  port: number;
  /** Question id, possibly nested (e.g. `topic/sub/q1`). */
  qid: string;
  /** Variant seed; defaults to {@link DEFAULT_VARIANT}. */
  variant?: string;
}

/**
 * Build `http://127.0.0.1:<port>/questions/<encoded-qid>?variant=<seed>`.
 *
 * Each qid segment is percent-encoded so spaces and reserved characters are
 * safe, while the `/` separators of a nested qid are preserved as path
 * boundaries (matching the POC's `previewUrlForQid`).
 */
export function buildPreviewUrl({ port, qid, variant = DEFAULT_VARIANT }: PreviewUrlInput): string {
  const encodedQid = qid.split('/').map(encodeURIComponent).join('/');
  return `${previewOrigin(port)}/questions/${encodedQid}?variant=${encodeURIComponent(variant)}`;
}

/**
 * Fresh base-36 seed for the "New variant" reroll.
 *
 * PrairieLearn seeds a variant from a 32-bit integer, so this draws one random
 * uint32 (never 0, which the server would reject) and renders it base-36 to keep
 * the seed short in the URL. Ported from the POC's `previewUrlState.randomBase36Variant`.
 */
export function randomBase36Variant(): string {
  const bytes = new Uint32Array(1);
  crypto.getRandomValues(bytes);
  const value = bytes[0] === 0 ? 1 : bytes[0];
  return value.toString(36);
}
