import type { ReactNode } from "react";
import { Icon, type IconName } from "../ui/Icon";

/** Big radio target: one visible decision, no hidden default. */
export function OptionCard({
  selected,
  onSelect,
  icon,
  title,
  blurb,
  children,
}: {
  selected: boolean;
  onSelect: () => void;
  icon: IconName;
  title: string;
  blurb: string;
  children?: ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      className="w-full rounded-[16px] p-3.5 text-left transition-all"
      style={{
        background: selected ? "var(--accent-soft)" : "var(--fill)",
        boxShadow: selected
          ? "inset 0 0 0 1.5px var(--accent)"
          : "inset 0 0 0 1px var(--g-rim)",
      }}
    >
      <span className="flex items-start gap-3">
        <span
          className="mt-px grid h-7 w-7 shrink-0 place-items-center rounded-full"
          style={{
            background: selected ? "var(--accent)" : "var(--fill-hi)",
            color: selected ? "var(--accent-ink)" : "var(--ink-2)",
          }}
        >
          <Icon name={icon} size={15} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            <span className="text-[14px] font-medium">{title}</span>
            {selected && (
              <Icon name="checkCircle" size={14} className="opacity-80" />
            )}
          </span>
          <span
            className="mt-1 block text-[12.5px] leading-snug"
            style={{ color: "var(--ink-2)" }}
          >
            {blurb}
          </span>
          {children}
        </span>
      </span>
    </button>
  );
}
