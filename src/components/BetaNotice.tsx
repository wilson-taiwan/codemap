/**
 * The standing "hosted sync is free during beta, and becomes paid after"
 * disclosure.
 *
 * Kept in one component so the wording lives in exactly one place: it is shown
 * both where an account is created (AccountForm) and where sync is set up or
 * managed (SyncSheet), and those two must never drift apart. The commitments
 * here — local work stays free, beta joiners keep founder pricing — are
 * deliberate, so the copy is held here rather than scattered.
 *
 * Scope of the promise, and the model behind it:
 *   - Hosted sync is per-user and subscription-based once the beta ends.
 *   - Local/offline Codemap stays free and accountless; sync is optional.
 *   - A lapsed account can still work locally and pull the study's latest;
 *     it simply cannot push, create, or join until subscribed again.
 */
export function BetaNotice({ className = "" }: { className?: string }) {
  return (
    <div className={`notice notice-info ${className}`.trim()} role="note">
      <strong>Free beta.</strong> Hosted sync is free while Codemap is in beta.
      When the beta ends, hosted sync will require a subscription. Your
      transcripts stay on your computer, and Codemap's local/offline coding
      tools remain free. People who join during the beta keep founder pricing
      when paid plans arrive.
    </div>
  );
}
