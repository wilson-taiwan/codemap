import { useEffect, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import { Icon } from "./ui/Icon";
import { api } from "../lib/api";
import { useAppStore } from "../store/app-store";
import { useProjectStore } from "../store/project-store";
import { useSyncStore } from "../store/sync-store";
import { StepRail } from "./setup/StepRail";
import { OptionCard } from "./setup/OptionCard";
import { AccountForm } from "./AccountForm";
import { pickProjectPath } from "../lib/open-project";
import { normalizeLabel } from "../lib/study-label";
import {
  guessNameFromEmail,
  joinConnectReady,
  joinRailSteps,
} from "../lib/join-flow";
import type { Interview, MembershipSummary, MissingTranscript } from "../lib/types";
import { CollaborationDisclosure } from "./CollaborationDisclosure";

/**
 * Resolve an interview against SQLite directly, matching normalized labels.
 * Only falls back to creating an interview if the database genuinely lacks it.
 */
export async function resolveInterviewForImport(
  label: string,
  createFallback?: (label: string) => Promise<Interview>,
): Promise<Interview> {
  const dbInterviews = await api.listInterviews();
  const existing = dbInterviews.find(
    (i) => normalizeLabel(i.participant_label) === normalizeLabel(label),
  );
  if (existing) return existing;
  if (createFallback) {
    return createFallback(label);
  }
  return useProjectStore.getState().createInterview(label);
}

/**
 * Joining a group somebody else started — as a wizard, not a form.
 *
 * The steps run in the order the joiner actually knows the answers: they have
 * a group key and their own name (Connect), and they have the transcript
 * files in the shared folder (Transcripts). A key leads straight to the group,
 * so the picker between them only appears for somebody who arrived without
 * one — browsing the groups their account already belongs to.
 *
 * The transcript step is gated, not advisory: a join that ends without the
 * transcripts linked leaves a coder who can see the codebook and nothing to
 * code — collaboration has not started until both copies hold the same words,
 * so the wizard does not pronounce itself done before then.
 *
 * After the key works, the joiner chooses a new folder or an existing unbound
 * one. Binding a folder already in a different group is refused.
 */

type Stage = "connect" | "pick" | "copy" | "creating" | "imports";
type CopyChoice = "new" | "existing";

/** What one linked transcript knows. */
interface LinkedTranscript {
  /** Passages the file produced on this machine. */
  count: number;
  /** What the colleague's copy reports, via the roster. */
  expected: number;
  /** The coder saw the counts disagree and chose this file regardless. */
  keptAnyway: boolean;
}

/** "Teacher Interviews 2026" -> "teacher-interviews-2026" */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "shared-study"
  );
}

/** Letters and digits only, uppercased — the server's storage form. */
function normaliseKey(raw: string): string {
  return raw.replace(/[^a-z0-9]/gi, "").toUpperCase();
}

export function JoinStudyModal() {
  const open = useAppStore((s) => s.showJoinStudy);
  const close = useAppStore((s) => s.closeJoinStudy);
  const setSyncServer = useAppStore((s) => s.setSyncServer);
  const presetMembership = useAppStore((s) => s.joinStudyMembership);
  const preferences = useAppStore((s) => s.preferences);
  const openProject = useProjectStore((s) => s.openProject);
  const refreshStatus = useSyncStore((s) => s.refreshStatus);
  // True when this build already knows its server, which is the ordinary case:
  // then the only thing anyone has to carry is the group key. Status is null
  // on the first paint of the welcome screen, before refresh returns — treat
  // that as "hide the server" so a shipping build never flashes the URL/JWT
  // form. Self-hosted builds have `serverPreset: false` and show it after.
  const hideServer = useSyncStore((s) => s.status?.serverPreset !== false);
  const signedIn = useSyncStore((s) => s.status?.signedIn ?? false);
  const signedInEmail = useSyncStore((s) => s.status?.signedInEmail);
  const signOut = useSyncStore((s) => s.signOut);

  const [stage, setStage] = useState<Stage>("connect");
  const [setup, setSetup] = useState("");
  const [key, setKey] = useState("");
  const [linked, setLinked] = useState<Record<string, LinkedTranscript>>({});
  const [importing, setImporting] = useState<string | null>(null);
  const [importError, setImportError] = useState<string | null>(null);
  const [coderName, setCoderName] = useState("");
  /** The name field is prefilled from the email until the joiner edits it. */
  const [nameTouched, setNameTouched] = useState(false);
  const [memberships, setMemberships] = useState<MembershipSummary[]>([]);
  const [pendingMembership, setPendingMembership] =
    useState<MembershipSummary | null>(null);
  const [copyChoice, setCopyChoice] = useState<CopyChoice>("new");
  const [needed, setNeeded] = useState<MissingTranscript[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) {
      setLinked({});
      setImporting(null);
      setImportError(null);
      return;
    }
    void refreshStatus();
    if (presetMembership && signedIn) {
      setStage("copy");
      setPendingMembership(presetMembership);
      setCoderName(presetMembership.coderName);
      setNameTouched(true);
    } else {
      setStage("connect");
      setPendingMembership(null);
      setCoderName("");
      setNameTouched(false);
    }
    setSetup(
      [preferences.sync_url, preferences.sync_anon_key].filter(Boolean).join("\n"),
    );
    setKey("");
    setMemberships([]);
    setCopyChoice("new");
    setNeeded([]);
    setError(null);
  }, [open, presetMembership, signedIn, preferences.sync_url, preferences.sync_anon_key, refreshStatus]);

  useEffect(() => {
    if (!open || nameTouched || coderName.trim()) return;
    if (!signedInEmail) return;
    const guess = guessNameFromEmail(signedInEmail);
    if (guess) setCoderName(guess);
  }, [open, signedInEmail, nameTouched, coderName]);

  const hasKey = hideServer
    ? key.trim().length > 0
    : /(^|\s)(key|invite):\S/.test(setup);

  /**
   * Pull the address, anon key and group key out of whatever was pasted.
   *
   * A URL and a JWT are unambiguous — one starts with http, the other is
   * dot-separated base64 — so the block your colleague sent needs no format of
   * its own and no instructions about which line is which. The group key is
   * the one prefixed token, since eight characters of base32 could otherwise
   * be mistaken for a fragment of the JWT.
   */
  function parseSetup(
    raw: string,
  ): { url: string; key: string; groupKey: string | null } | null {
    const parts = raw.split(/\s+/).map((t) => t.trim()).filter(Boolean);
    const url = parts.find((t) => /^https?:\/\//.test(t));
    const anon = parts.find((t) => /^ey[A-Za-z0-9_-]+\./.test(t));
    const groupKey = parts
      .find((t) => /^(key|invite):/.test(t))
      ?.replace(/^(key|invite):/, "");
    return url && anon
      ? { url: url.replace(/\/+$/, ""), key: anon, groupKey: groupKey ?? null }
      : null;
  }

  async function connect() {
    // Two shapes of arrival. Normally this build already knows its server and
    // the coder carries nothing but the group key. A build that does not — or
    // one being pointed at a different group — still takes the pasted block.
    let groupKey: string | null = null;
    let server: { url: string; key: string } | null = null;
    if (hideServer) {
      groupKey = key.trim() || null;
    } else {
      const parsed = parseSetup(setup);
      if (!parsed) {
        setError(
          "That does not look complete. Paste the whole block your colleague sent — it has an address and a long key.",
        );
        return;
      }
      groupKey = parsed.groupKey;
      server = { url: parsed.url, key: parsed.key };
    }

    setBusy(true);
    setError(null);
    try {
      if (server) {
        await setSyncServer(server.url, server.key);
      }

      setLinked({});
      setImporting(null);
      setImportError(null);

      // With a key, joining is what grants access, so it happens before
      // anything is listed — otherwise a first-time coder would be shown an
      // empty picker and left to conclude the key had not worked. A group
      // join settles the name on the spot; the next step is choosing a folder.
      if (groupKey) {
        try {
          const joined = await api.syncJoinGroup(groupKey, coderName.trim());
          setPendingMembership({
            projectId: joined.projectId,
            title: joined.title,
            coderName: joined.coderName,
            members: [joined.coderName],
            role: "coder",
          });
          setCoderName(joined.coderName);
          setNameTouched(true);
          setStage("copy");
          return;
        } catch (e) {
          // A six-character "key" is a legacy single-use invitation from
          // before groups existed. Honour it quietly rather than asking the
          // joiner to know the difference.
          if (normaliseKey(groupKey).length === 6) {
            try {
              const redeemed = await api.syncRedeemInvite(groupKey);
              setCoderName(redeemed.coderName);
              setNameTouched(true);
            } catch (e2) {
              setError(String(e2));
              return;
            }
          } else {
            setError(String(e));
            return;
          }
        }
      }

      const found = await api.listMemberships();
      setMemberships(found);
      setStage("pick");
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  /**
   * Link one of the transcripts the group is waiting for, and check the match.
   *
   * The label comes from the roster, never from a keystroke. That is the whole
   * point: `interview_id` is a hash of the label, so a coder who retypes `P7`
   * for the study's `P07` creates a second interview holding the same words,
   * and the two coders' work never meets. The list on screen already knows the
   * right answer — asking anybody to copy it by hand was the bug.
   *
   * The count check is the "correct transcript" half of the step. Passage ids
   * are content-derived, so the same file produces the same count on both
   * machines; a disagreement means a different export, a different file, or a
   * different merge setting — all worth surfacing before coding starts, none
   * of them provably wrong, which is why the coder may keep the file after
   * seeing the numbers.
   */
  async function importFor(m: MissingTranscript) {
    setImporting(m.studyLabel);
    setImportError(null);
    try {
      const store = useProjectStore.getState();
      const interview = await resolveInterviewForImport(m.studyLabel, store.createInterview);

      const file = await openFileDialog({
        multiple: false,
        filters: [
          {
            name: "Transcripts",
            extensions: ["vtt", "srt", "txt", "md", "csv", "tsv", "docx"],
          },
          { name: "All files", extensions: ["*"] },
        ],
        title: `Choose the transcript for ${m.studyLabel}`,
      });
      if (!file || Array.isArray(file)) return;

      await store.selectInterview(interview.id);
      const count = await store.importVtt(file);
      setLinked((prev) => ({
        ...prev,
        // A re-pick after a mismatch replaces the transcript, so the new count
        // is judged on its own — the earlier "kept anyway" must not carry over.
        [m.studyLabel]: { count, expected: m.segmentCount, keptAnyway: false },
      }));
    } catch (e) {
      setImportError(
        `Could not import ${m.studyLabel}: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setImporting(null);
    }
  }

  async function join(
    membership: MembershipSummary,
    opts: { existingPath?: string } = {},
  ) {
    setStage("creating");
    setError(null);
    const hadProject = !!useProjectStore.getState().project;
    try {
      if (opts.existingPath) {
        await openProject(opts.existingPath);
        await api.syncJoinProject(membership.projectId);
      } else {
        // The local project is scaffolding: the title and the coder's name both
        // come off the server — the name on the membership is the name the group
        // knows, so filing under anything else would split their work across two
        // names.
        const parentDir = await api.getProjectsLibraryDir();
        const created = await api.createProject({
          parent_dir: parentDir,
          project_name: slugify(membership.title),
          title: membership.title,
          coders: [membership.coderName],
        });
        await api.syncJoinProject(membership.projectId);
        await openProject(created.path);
      }
      useProjectStore.getState().adoptCoderName(membership.coderName);
      const outcome = await api.syncNow();
      await useProjectStore.getState().loadInterviews();
      useSyncStore.setState({ lastOutcome: outcome, error: null });
      void useSyncStore.getState().refreshGroup();
      void useSyncStore.getState().refreshStatus();

      // That first sync is pull-only: this machine has no transcripts, so it
      // takes the codebook and the interview roster and contributes nothing.
      // What comes back is the list of files to fetch from the shared folder,
      // and it is the wizard's last step — not a footnote on the way out.
      if (outcome && outcome.missingTranscripts && outcome.missingTranscripts.length > 0) {
        setNeeded(outcome.missingTranscripts);
        setStage("imports");
        return;
      }
      close();
    } catch (e) {
      setError(String(e));
      if (opts.existingPath && !hadProject) {
        try {
          await useProjectStore.getState().closeProject();
        } catch {
          // The bind failed; getting back to the wizard matters more than
          // whether the half-opened folder closed cleanly.
        }
      }
      setStage(hasKey ? "copy" : pendingMembership ? "copy" : "pick");
    }
  }

  async function continueFromCopy() {
    const membership = pendingMembership;
    if (!membership) return;
    if (copyChoice === "new") {
      await join(membership);
      return;
    }
    const path = await pickProjectPath();
    if (!path) return;
    await join(membership, { existingPath: path });
  }

  const canConnect = joinConnectReady({
    signedIn,
    hideServer,
    setupFilled: setup.trim().length > 0,
    coderName,
  });

  const linkedOk = (m: MissingTranscript) => {
    const l = linked[m.studyLabel];
    return !!l && (l.count === l.expected || l.keptAnyway);
  };
  const allLinked = needed.length > 0 && needed.every(linkedOk);

  const isPreset = !!presetMembership && signedIn;
  const steps = joinRailSteps({ hasKey, signedIn, presetMembership: isPreset });
  const stepIndex = isPreset
    ? stage === "copy" || stage === "creating"
      ? 0
      : 1
    : stage === "connect"
      ? 0
      : stage === "pick"
        ? 1
        : stage === "copy" || stage === "creating"
          ? hasKey
            ? 1
            : 2
          : hasKey
            ? 2
            : 3;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <button
        type="button"
        className="scrim"
        aria-label="Cancel joining"
        onClick={() => !busy && stage !== "creating" && close()}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Join a study"
        className="glass-sheet anim-sheet relative flex h-[600px] w-full max-w-3xl overflow-hidden"
      >
        <StepRail
          steps={steps}
          activeIndex={stepIndex}
          eyebrow="Join a study"
          footnote="Transcripts never travel through sync — you will pick matching transcript files on this computer."
        />

        <div className="flex min-w-0 flex-1 flex-col">
          <div className="scroll flex-1 px-9 pb-4 pt-9">
            {error && (
              <div
                className="mb-4 flex items-start gap-2 rounded-[12px] px-3 py-2.5 text-[12.5px]"
                style={{ background: "var(--danger-soft)", color: "var(--danger)" }}
                role="alert"
              >
                <Icon name="alert" size={15} />
                <span>{error}</span>
              </div>
            )}

            {stage === "connect" && (
              <Section
                heading={signedIn ? "Join a shared study" : "Your Fleuron account"}
                lede={
                  signedIn
                    ? hideServer
                      ? "Enter the 8-character study key from the person who started the study. You will choose a local folder and pick your transcript files on this computer."
                      : "Paste the connection block from the person who started the study. You will choose a local folder and pick your transcript files on this computer."
                    : "Create an account or sign in first. Enter the study key from the person who started the study."
                }
              >
                {!signedIn && (
                  <>
                    {/* Truth before credentials: what collaboration shares and
                        keeps local, stated once above the form. No second
                        confirmation is demanded of the user afterwards. */}
                    <CollaborationDisclosure />
                    <AccountForm
                      idPrefix="join"
                      autoFocus
                      onSignedIn={() => void refreshStatus()}
                    />
                  </>
                )}

                {hideServer ? (
                  <div>
                    <label className="label" htmlFor="join-code">
                      Study key
                    </label>
                    <input
                      id="join-code"
                      className="field font-mono uppercase tracking-[0.2em]"
                      value={key}
                      onChange={(e) => setKey(e.target.value)}
                      placeholder="ABCD-1234"
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={12}
                      autoFocus={signedIn}
                    />
                    <p className="hint mt-1">
                      Eight characters from the person who started the study. Upper or lower case, dashes or spaces — all work.
                    </p>
                  </div>
                ) : (
                  <div>
                    <label className="label" htmlFor="join-setup">
                      Connection block
                    </label>
                    <textarea
                      id="join-setup"
                      className="field"
                      rows={3}
                      value={setup}
                      onChange={(e) => setSetup(e.target.value)}
                      placeholder={"https://your-project.supabase.co\neyJhbGciOi…\nkey:ABCD-1234"}
                      spellCheck={false}
                      autoFocus={signedIn}
                    />
                    <p className="hint mt-1">
                      Paste the whole block — Fleuron works out which line is which.
                    </p>
                  </div>
                )}

                {signedIn ? (
                  <>
                    <div>
                      <label className="label" htmlFor="join-coder">
                        Your coder name
                      </label>
                      <input
                        id="join-coder"
                        className="field"
                        value={coderName}
                        onChange={(e) => {
                          setCoderName(e.target.value);
                          setNameTouched(true);
                        }}
                        placeholder="Your name"
                      />
                      <p className="hint mt-1">
                        Confirm this before you continue. Everything you code is
                        filed under this name, and it is how your colleagues tell
                        your work apart. If you have joined this group before, you
                        keep the name it already knows you by.
                      </p>
                    </div>
                    <div
                      className="flex flex-wrap items-center gap-2 rounded-[12px] px-3 py-2 text-[12.5px]"
                      style={{ background: "var(--ok-soft)", color: "var(--ok)" }}
                    >
                      <Icon name="check" size={15} />
                      <span className="min-w-0 flex-1">
                        Signed in
                        {signedInEmail ? (
                          <>
                            {" "}
                            as <span className="font-medium">{signedInEmail}</span>
                          </>
                        ) : null}
                        . Confirm the name, then continue.
                      </span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm shrink-0"
                        style={{ color: "var(--ok)" }}
                        onClick={() => void signOut()}
                      >
                        Use a different account
                      </button>
                    </div>
                  </>
                ) : (
                  <p className="hint">
                    Continue appears once you are signed in.
                  </p>
                )}
              </Section>
            )}

            {stage === "pick" && (
              <Section
                heading="Which group is this machine joining?"
                lede="These are the groups your account already belongs to. Fleuron sets up your copy — you do not need a project file from anybody."
              >
                <div className="flex flex-col gap-2">
                  {memberships.map((m) => (
                    <button
                      key={m.projectId}
                      type="button"
                      className="btn btn-outline btn-block justify-between"
                      onClick={() => {
                        setPendingMembership(m);
                        setStage("copy");
                      }}
                    >
                      <span className="truncate">
                        {m.title}
                        <span className="hint ml-1.5">— joining as {m.coderName}</span>
                      </span>
                      <Icon name="arrowRight" size={15} />
                    </button>
                  ))}
                  {memberships.length === 0 && (
                    <p className="hint">
                      No groups yet — an account on its own joins nothing. Go
                      back and enter the group key your colleague sent; joining
                      with it is what grants access.
                    </p>
                  )}
                </div>
              </Section>
            )}

            {stage === "copy" && pendingMembership && (
              <Section
                heading="Your copy of the study"
                lede={`“${pendingMembership.title}” — as ${pendingMembership.coderName}. A new folder is the usual path. Use an existing folder only if this machine already has the study, unbound.`}
              >
                <div className="flex flex-col gap-2.5" role="radiogroup">
                  <OptionCard
                    selected={copyChoice === "new"}
                    onSelect={() => setCopyChoice("new")}
                    icon="plus"
                    title="Create a new copy"
                    blurb="Fleuron makes a project folder on this computer and pulls the codebook. You then link the transcripts from Box."
                  />
                  <OptionCard
                    selected={copyChoice === "existing"}
                    onSelect={() => setCopyChoice("existing")}
                    icon="folder"
                    title="Use a folder already on this computer"
                    blurb="Binds that folder to the group. Refused if it is already in a different group — that would mix two studies."
                  />
                </div>
              </Section>
            )}

            {stage === "creating" && (
              <Section
                heading="Setting up your copy"
                lede="Creating the project, joining the group, and pulling the codebook…"
              >
                <p className="hint">This takes a few seconds.</p>
              </Section>
            )}

            {stage === "imports" && (
              <Section
                heading="Link your transcripts"
                lede="The codebook is here; the transcripts are not — they never travel through sync. Link each one from your shared folder and your colleague's coding attaches itself. The wizard ends when every copy is linked."
              >
                <ul className="flex flex-col gap-2">
                  {needed.map((m) => {
                    const l = linked[m.studyLabel];
                    const done = linkedOk(m);
                    const mismatch = l && l.count !== l.expected && !l.keptAnyway;
                    return (
                      <li
                        key={m.studyLabel}
                        className="rounded-[14px] p-3"
                        style={{
                          background: "var(--fill)",
                          boxShadow: mismatch
                            ? "inset 0 0 0 1px var(--warn)"
                            : done
                              ? "inset 0 0 0 1px var(--ok)"
                              : "none",
                        }}
                      >
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 flex-1 text-[13px]">
                            <strong>{m.studyLabel}</strong>{" "}
                            <span className="hint">
                              — {m.segmentCount} passage
                              {m.segmentCount === 1 ? "" : "s"} on your
                              colleague's copy
                            </span>
                          </span>
                          {done ? (
                            <span
                              className="flex shrink-0 items-center gap-1 text-[12px]"
                              style={{ color: "var(--ok)" }}
                            >
                              <Icon name="check" size={13} />
                              {l.count === l.expected
                                ? `Linked — ${l.count} passages, matching`
                                : "Linked"}
                            </span>
                          ) : (
                            <button
                              type="button"
                              className="btn btn-outline btn-sm shrink-0"
                              disabled={importing !== null}
                              onClick={() => void importFor(m)}
                            >
                              <Icon name="import" size={13} />
                              {importing === m.studyLabel
                                ? "Importing…"
                                : l
                                  ? "Choose a different file…"
                                  : "Link file…"}
                            </button>
                          )}
                        </div>

                        {mismatch && l && (
                          <div className="notice notice-warn mt-2.5">
                            <p>
                              This file has <strong>{l.count}</strong> passages;
                              your colleague's copy has{" "}
                              <strong>{l.expected}</strong>. A different export
                              — or a different merge setting — will not line up
                              with their coding.
                            </p>
                            <div className="mt-2 flex gap-2">
                              <button
                                type="button"
                                className="btn btn-outline btn-sm"
                                disabled={importing !== null}
                                onClick={() => void importFor(m)}
                              >
                                Choose a different file
                              </button>
                              <button
                                type="button"
                                className="btn btn-ghost btn-sm"
                                onClick={() =>
                                  setLinked((prev) => ({
                                    ...prev,
                                    [m.studyLabel]: { ...l, keptAnyway: true },
                                  }))
                                }
                              >
                                Keep this file anyway
                              </button>
                            </div>
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {/* The label is filled in for them. Retyping it from a list on
                    the screen is the most consequential typo available in this
                    app — it decides the interview's identity — and there is no
                    reason to ask anybody to do it by hand. */}
                <p className="hint mt-3 text-[12px]">
                  Fleuron fills in the participant ID for you, so your copy lines
                  up with your colleague's exactly.
                </p>
                {importError && (
                  <p className="mt-2 text-[12.5px]" style={{ color: "var(--danger)" }}>
                    {importError}
                  </p>
                )}
              </Section>
            )}
          </div>

          <footer className="flex items-center justify-between gap-3 px-9 pb-7 pt-2">
            <div>
              {stage !== "creating" && stage !== "imports" && (
                <button
                  type="button"
                  onClick={close}
                  disabled={busy}
                  className="btn btn-ghost"
                >
                  Cancel
                </button>
              )}
              {stage === "imports" && !allLinked && (
                /* A gate, not a wall. Linking is mandatory for *finishing* —
                   that is the whole point of the wizard — but somebody whose
                   shared folder is not to hand must not be trapped in a modal,
                   so the way out says what it costs. */
                <button
                  type="button"
                  onClick={close}
                  className="btn btn-ghost"
                  title="The workspace opens with empty transcripts; link them later from More actions → Import transcript…"
                >
                  Link these later
                </button>
              )}
            </div>

            <div className="flex items-center gap-2">
              {stage === "creating" && (
                <span className="hint">Working…</span>
              )}
              {stage === "pick" && (
                <button
                  type="button"
                  onClick={() => setStage("connect")}
                  className="btn btn-outline"
                >
                  <Icon name="arrowLeft" size={14} />
                  Back
                </button>
              )}
              {stage === "copy" && (
                <button
                  type="button"
                  onClick={() => {
                    if (isPreset) close();
                    else setStage(hasKey ? "connect" : "pick");
                  }}
                  className="btn btn-outline"
                >
                  <Icon name="arrowLeft" size={14} />
                  Back
                </button>
              )}
              {stage === "connect" && signedIn && (
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={!canConnect || busy}
                  onClick={() => void connect()}
                >
                  {busy ? "Connecting…" : "Continue"}
                  {!busy && <Icon name="arrowRight" size={15} />}
                </button>
              )}
              {stage === "copy" && (
                <button
                  type="button"
                  className="btn btn-primary btn-lg"
                  disabled={busy}
                  onClick={() => void continueFromCopy()}
                >
                  {copyChoice === "existing" ? "Choose folder…" : "Create copy"}
                  <Icon name="arrowRight" size={15} />
                </button>
              )}
              {stage === "imports" && (
                <button
                  type="button"
                  onClick={close}
                  disabled={!allLinked}
                  className="btn btn-primary btn-lg"
                  title={
                    allLinked
                      ? undefined
                      : "Link every transcript first — coding together needs both copies to hold the same words"
                  }
                >
                  Start coding
                </button>
              )}
            </div>
          </footer>
        </div>
      </div>
    </div>
  );
}

function Section({
  heading,
  lede,
  children,
}: {
  heading: string;
  lede: string;
  children: React.ReactNode;
}) {
  return (
    <div className="anim-rise flex flex-col gap-5" key={heading}>
      <div>
        <h2 className="text-[21px] font-semibold tracking-[-0.02em]">
          {heading}
        </h2>
        <p className="hint mt-1.5 max-w-prose text-[13px]">{lede}</p>
      </div>
      {children}
    </div>
  );
}
