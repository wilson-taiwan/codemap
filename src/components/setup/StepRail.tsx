import { Icon } from "../ui/Icon";

export interface StepSpec {
  id: string;
  title: string;
  caption: string;
}

/**
 * Left rail of the setup wizard. Its whole job is answering "how much is
 * left?" before the user commits — the question an all-at-once form can't.
 */
export function StepRail({
  steps,
  activeIndex,
  eyebrow = "New project",
  footnote = "Everything here can be changed after setup.",
}: {
  steps: StepSpec[];
  activeIndex: number;
  /** The rail's header — what is being set up. */
  eyebrow?: string;
  /** Quiet line pinned to the rail's foot. Pass null to omit. */
  footnote?: string | null;
}) {
  return (
    <nav
      aria-label="Setup steps"
      className="hidden w-60 shrink-0 flex-col gap-1 p-5 sm:flex"
      style={{ background: "var(--fill)" }}
    >
      <p className="eyebrow mb-3 px-2">{eyebrow}</p>

      <ol className="flex flex-col gap-0.5">
        {steps.map((step, i) => {
          const done = i < activeIndex;
          const active = i === activeIndex;
          return (
            <li key={step.id}>
              <div
                aria-current={active ? "step" : undefined}
                className="flex items-start gap-2.5 rounded-[12px] px-2 py-2 transition-colors"
                style={{
                  background: active ? "var(--fill-on)" : "transparent",
                  boxShadow: active ? "var(--shadow-1)" : "none",
                }}
              >
                <span
                  className="mt-px grid h-[19px] w-[19px] shrink-0 place-items-center rounded-full text-[10px] font-semibold transition-colors"
                  style={
                    done
                      ? { background: "var(--ok)", color: "#fff" }
                      : active
                        ? { background: "var(--accent)", color: "var(--accent-ink)" }
                        : { background: "var(--fill-hi)", color: "var(--ink-3)" }
                  }
                >
                  {done ? <Icon name="check" size={11} /> : i + 1}
                </span>
                <span className="min-w-0">
                  <span
                    className="block text-[13px] font-medium leading-tight"
                    style={{ color: active ? "var(--ink)" : "var(--ink-2)" }}
                  >
                    {step.title}
                  </span>
                  <span
                    className="mt-0.5 block text-[11.5px] leading-snug"
                    style={{ color: "var(--ink-3)" }}
                  >
                    {step.caption}
                  </span>
                </span>
              </div>
            </li>
          );
        })}
      </ol>

      {footnote && <p className="hint mt-auto px-2 text-[11.5px]">{footnote}</p>}
    </nav>
  );
}
