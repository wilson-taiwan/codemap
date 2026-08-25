import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useShallow } from "zustand/react/shallow";
import { useProjectStore } from "../store/project-store";
import { readableOn } from "../lib/code-colors";
import { THEME_GROUND, usePrefersDark } from "../hooks/useTheme";
import { shortcut } from "../lib/platform";
import { Icon } from "./ui/Icon";
import { Tooltip } from "./ui/Tooltip";
import { useMenuKeys } from "./ui/Menu";

export function CodeFilterButton() {
  const dark = usePrefersDark();
  const ground = dark ? THEME_GROUND.dark : THEME_GROUND.light;

  const { codes, codeFilter, setCodeFilter } = useProjectStore(
    useShallow((s) => ({
      codes: s.codes,
      codeFilter: s.codeFilter,
      setCodeFilter: s.setCodeFilter,
    })),
  );

  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const activeCode = useMemo(
    () => codes.find((c) => c.id === codeFilter) ?? null,
    [codes, codeFilter],
  );

  // Filterable codes: usage_count > 0, sorted by usage descending
  const filterableCodes = useMemo(() => {
    return codes
      .filter((c) => c.usage_count > 0)
      .sort((a, b) => b.usage_count - a.usage_count);
  }, [codes]);

  const displayedCodes = useMemo(() => {
    if (!query.trim()) return filterableCodes;
    const q = query.toLowerCase();
    return filterableCodes.filter((c) => c.name.toLowerCase().includes(q));
  }, [filterableCodes, query]);

  const updatePosition = useCallback(() => {
    if (!buttonRef.current) return;
    const rect = buttonRef.current.getBoundingClientRect();
    const gap = 6;
    const popoverWidth = 240;
    const viewportWidth = window.innerWidth;

    let left = rect.left;
    if (left + popoverWidth > viewportWidth - 16) {
      left = Math.max(16, viewportWidth - popoverWidth - 16);
    }
    const top = rect.bottom + gap;
    setPos({ top, left });
  }, []);

  const toggleOpen = () => {
    if (!open) {
      updatePosition();
      setQuery("");
      setOpen(true);
    } else {
      setOpen(false);
    }
  };

  const close = useCallback(() => {
    setOpen(false);
    buttonRef.current?.focus();
  }, []);

  const onMenuKeys = useMenuKeys(popoverRef, close);

  // ⇧⌘F keyboard shortcut
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMac = typeof navigator !== "undefined" && /Mac/.test(navigator.userAgent);
      const mod = isMac ? e.metaKey : e.ctrlKey;
      if (mod && e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        toggleOpen();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [open]);

  // Click outside to dismiss
  useEffect(() => {
    if (!open) return;
    const handleDown = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        buttonRef.current &&
        !buttonRef.current.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    window.addEventListener("mousedown", handleDown, true);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("mousedown", handleDown, true);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

  const filterShortcutLabel = shortcut("mod", "shift", "F");

  return (
    <>
      <Tooltip content={`Filter passages by code (${filterShortcutLabel})`}>
        <button
          ref={buttonRef}
          type="button"
          onClick={toggleOpen}
          aria-expanded={open}
          aria-label="Filter passages by code"
          className={`flex items-center gap-1.5 rounded-lg px-2 py-1 text-[12px] font-medium transition-colors ${
            activeCode
              ? "shadow-sm border border-[var(--g-rim)]"
              : "btn-ghost text-[var(--ink-3)] hover:text-[var(--ink)]"
          }`}
          style={
            activeCode
              ? {
                  backgroundColor: `${activeCode.color}22`,
                  color: readableOn(activeCode.color, ground),
                }
              : undefined
          }
        >
          {activeCode ? (
            <>
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: activeCode.color }}
              />
              <span className="max-w-[90px] truncate hidden sm:inline">
                {activeCode.name}
              </span>
              <span className="font-mono text-[10.5px] opacity-75 tabular-nums">
                {activeCode.usage_count}
              </span>
            </>
          ) : (
            <Icon name="filter" size={13} />
          )}
        </button>
      </Tooltip>

      {open &&
        pos &&
        createPortal(
          <div
            ref={popoverRef}
            role="menu"
            aria-label="Filter by code"
            onKeyDown={onMenuKeys}
            className="glass-pop anim-rise fixed z-[85] w-[240px] flex flex-col p-1.5 shadow-xl select-none"
            style={{
              top: pos.top,
              left: pos.left,
            }}
          >
            {filterableCodes.length > 8 && (
              <div className="p-1 pb-1.5 border-b border-[var(--g-rim)]/50">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Find code…"
                  className="field field-sm w-full text-[11.5px]"
                  autoFocus
                />
              </div>
            )}

            <div className="max-h-[260px] overflow-y-auto py-1 flex flex-col gap-0.5">
              {/* Row 1: All passages */}
              <button
                type="button"
                role="menuitem"
                onClick={() => {
                  setCodeFilter(null);
                  close();
                }}
                className={`flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                  codeFilter === null
                    ? "bg-[var(--fill-on)] text-[var(--accent)] font-medium"
                    : "hover:bg-[var(--fill)] text-[var(--ink)]"
                }`}
              >
                <span>All passages</span>
                {codeFilter === null && <Icon name="check" size={12} />}
              </button>

              <div className="divider my-0.5" />

              {displayedCodes.length === 0 ? (
                <div className="px-2 py-2 text-center text-[11.5px] text-[var(--ink-4)]">
                  No coded passages found
                </div>
              ) : (
                displayedCodes.map((code) => {
                  const isActive = codeFilter === code.id;
                  return (
                    <button
                      key={code.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setCodeFilter(isActive ? null : code.id);
                        close();
                      }}
                      className={`flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] transition-colors ${
                        isActive
                          ? "bg-[var(--fill-on)] font-medium"
                          : "hover:bg-[var(--fill)]"
                      }`}
                      style={
                        isActive
                          ? { color: readableOn(code.color, ground) }
                          : { color: "var(--ink)" }
                      }
                    >
                      <span
                        className="h-2 w-2 rounded-full shrink-0"
                        style={{ backgroundColor: code.color }}
                      />
                      <span className="min-w-0 flex-1 truncate">{code.name}</span>
                      <span
                        className="font-mono text-[10.5px] tabular-nums shrink-0 opacity-70"
                        style={{ color: "var(--ink-4)" }}
                      >
                        {code.usage_count}
                      </span>
                      {isActive && <Icon name="check" size={12} className="shrink-0" />}
                    </button>
                  );
                })
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
