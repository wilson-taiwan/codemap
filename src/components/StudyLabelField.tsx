import { checkStudyLabel } from "../lib/study-label";
import { Icon } from "./ui/Icon";

/**
 * The study-label input, everywhere it appears.
 *
 * Shared because the label is the interview's identity across machines, and
 * two entry points that check it differently would be two different contracts.
 * The guidance is inline rather than in the guide: the mistake happens at the
 * keystroke and is unrecoverable by the time anyone would think to look it up.
 *
 * When the study already knows some labels — including ones learned from a
 * colleague through the roster — they are offered as buttons. Reproducing a
 * label you never chose is exactly the joining coder's problem, and picking is
 * not typo-prone in the way typing is.
 */
export function StudyLabelField({
  value,
  onChange,
  knownLabels,
  filenameGuess,
  autoFocus,
  id = "participant-id",
}: {
  value: string;
  onChange: (label: string) => void;
  knownLabels: string[];
  filenameGuess?: string;
  autoFocus?: boolean;
  id?: string;
}) {
  const verdict = checkStudyLabel(value, knownLabels, filenameGuess);

  return (
    <>
      <label className="label" htmlFor={id}>
        Participant ID
      </label>
      <p className="hint mb-1.5 text-[11.5px]">
        Participant IDs come from your study protocol — <strong>P07</strong>, not
        a name and not a filename. Your colleague&apos;s copy uses the same ID —
        that is how the two line up.
      </p>

      {knownLabels.length > 0 && (
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          <span className="hint text-[11.5px]">Already in this study:</span>
          {knownLabels.map((label) => (
            <button
              key={label}
              type="button"
              onClick={() => onChange(label)}
              className="chip"
              style={{ cursor: "pointer" }}
              title={`Use "${label}"`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      <input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onFocus={(e) => e.target.select()}
        placeholder="P07"
        className="field"
        autoFocus={autoFocus}
      />

      {verdict.status === "matches" && (
        <p
          className="mt-2 flex items-start gap-1.5 text-[12.5px]"
          style={{ color: "var(--ok)" }}
        >
          <Icon name="check" size={13} />
          <span>
            Matches <strong>{verdict.matched}</strong>, already in this study —
            your coding will line up with your colleague's.
          </span>
        </p>
      )}

      {verdict.didYouMean && (
        <p
          className="mt-2 flex items-start gap-1.5 text-[12.5px]"
          style={{ color: "var(--warn)" }}
        >
          <Icon name="alert" size={13} />
          <span>
            This study already has <strong>{verdict.didYouMean}</strong>. Did you
            mean that?{" "}
            <button
              type="button"
              onClick={() => onChange(verdict.didYouMean!)}
              className="underline"
              style={{ color: "var(--warn)" }}
            >
              Use {verdict.didYouMean}
            </button>
          </span>
        </p>
      )}

      {verdict.warnings.map((w) => (
        <p
          key={w}
          className="mt-2 flex items-start gap-1.5 text-[12.5px]"
          style={{ color: "var(--warn)" }}
        >
          <Icon name="alert" size={13} />
          <span>{w}</span>
        </p>
      ))}

      {verdict.status === "new" && !verdict.didYouMean && value.trim() && (
        <p className="hint mt-2 text-[12px]">
          New participant. Your colleague must type this exactly — capitals and
          spacing are ignored, everything else is not.
        </p>
      )}
    </>
  );
}
