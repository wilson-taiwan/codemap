/**
 * The one-line-truthful disclosure shown wherever an account form or join
 * flow appears: onboarding's collaborate card, Join Study, AccountForm.
 *
 * Kept in exactly one component so every credential-entry surface makes the
 * same three claims — what syncs, what never does, who must keep the synced
 * words safe — without drift. The copy is deliberately compact; "See exact
 * fields" links the full data-boundary table rather than restating it.
 */

import { OFFICIAL_URLS } from "../content/trust-and-permissions";

export function CollaborationDisclosure({ className = "" }: { className?: string }) {
  return (
    <div className={`notice notice-info ${className}`.trim()} role="note">
      <p>
        Collaborating sends your account email plus study, codebook, and coding
        metadata over encrypted HTTPS/WSS so teammates see each other&rsquo;s work.
        Transcript text and memos <strong>never leave this computer</strong>.
      </p>
      <p>
        Study/participant labels and every codebook field (definitions,
        criteria, examples) are <strong>synced word-for-word</strong> — write them
        de-identified from the start.
      </p>
      <a href={OFFICIAL_URLS.privacyGuide} target="_blank" rel="noreferrer">
        See exact fields
      </a>
    </div>
  );
}
