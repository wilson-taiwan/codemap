/**
 * The standing "hosted sync is free during beta, and becomes paid after"
 * disclosure.
 *
 * Kept in one component so the wording lives in exactly one place: it is shown
 * both where an account is created (AccountForm) and where sync is set up or
 * managed (SyncSheet), and those two must never drift apart. The commitments
 * here — local work stays free, paid plans and beta-user terms are announced before charging — are
 * deliberate, so the copy is held here rather than scattered.
 *
 * Scope of the promise, and the model behind it:
 *   - Hosted sync is per-user and subscription-based once the beta ends.
 *   - Local/offline Fleuron stays free and accountless; sync is optional.
 *   - A lapsed account can still work locally and pull the study's latest;
 *     it simply cannot push, create, or join until subscribed again.
 */
export function BetaNotice({ className = "" }: { className?: string }) {
  return (
    <div className={`notice notice-info ${className}`.trim()} role="note">
      <strong>Free beta.</strong> Offline coding is free forever. Hosted
      collaboration is optional and free during beta. Paid plans and terms for
      beta users will be announced before charging begins. There is no Fleuron
      software fee for self-hosting; you are responsible for infrastructure and
      administration costs. Collaboration sync excludes transcript text and memo
      fields; codebook text syncs as written.
    </div>
  );
}
