import { useEffect, useRef } from "react";
import {
  GUIDE_CATEGORIES,
  searchGuideSections,
  type GuideSection,
} from "../content/user-guide";
import { useGuideStore } from "../store/guide-store";
import { useAppStore } from "../store/app-store";
import { SideSheet } from "./ui/Surfaces";
import { Icon } from "./ui/Icon";

export function UserGuidePanel() {
  const {
    isOpen,
    activeSectionId,
    searchQuery,
    closeGuide,
    setActiveSection,
    setSearchQuery,
  } = useGuideStore();
  const mainRef = useRef<HTMLDivElement>(null);

  const sections = searchGuideSections(searchQuery);
  const activeSection =
    sections.find((s) => s.id === activeSectionId) ?? sections[0];

  useEffect(() => {
    if (activeSection && activeSection.id !== activeSectionId) {
      setActiveSection(activeSection.id);
    }
  }, [searchQuery]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    mainRef.current?.scrollTo({ top: 0 });
  }, [activeSectionId]);

  const sectionsByCategory = GUIDE_CATEGORIES.map((cat) => ({
    ...cat,
    items: sections.filter((s) => s.category === cat.id),
  })).filter((cat) => cat.items.length > 0);

  return (
    <SideSheet
      open={isOpen}
      onClose={closeGuide}
      title="User guide"
      subtitle="Every workflow, with what to expect"
      width="max-w-[560px]"
    >
      <div className="px-5 py-2.5">
        <label className="relative flex items-center">
          <Icon
            name="search"
            size={14}
            className="pointer-events-none absolute left-3 opacity-45"
          />
          <input
            type="search"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search workflows…"
            aria-label="Search the guide"
            className="field pl-8"
          />
        </label>
        <button
          type="button"
          onClick={() => {
            closeGuide();
            useAppStore.getState().openTrustCenter();
          }}
          className="btn btn-outline btn-sm mt-2.5 w-full gap-1.5"
        >
          <Icon name="shield" size={13} />
          Trust &amp; permissions
        </button>
      </div>

      <div className="flex min-h-0 flex-1">
        <nav
          className="scroll w-44 shrink-0 p-2"
          style={{ background: "var(--fill)" }}
          aria-label="Guide sections"
        >
          {sectionsByCategory.map((cat) => (
            <div key={cat.id} className="mb-3">
              <p className="eyebrow px-2 text-[10px]">{cat.label}</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {cat.items.map((section) => {
                  const active = activeSection?.id === section.id;
                  return (
                    <li key={section.id}>
                      <button
                        type="button"
                        onClick={() => setActiveSection(section.id)}
                        className="w-full rounded-[9px] px-2 py-1.5 text-left text-[12px] leading-snug transition-colors"
                        style={{
                          background: active ? "var(--fill-on)" : "transparent",
                          boxShadow: active ? "var(--shadow-1)" : "none",
                          fontWeight: active ? 600 : 400,
                          color: active ? "var(--ink)" : "var(--ink-2)",
                        }}
                      >
                        {section.title}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        <div ref={mainRef} className="scroll flex-1 p-5">
          {activeSection ? (
            <GuideSectionView
              section={activeSection}
              onNavigate={setActiveSection}
            />
          ) : (
            <p className="hint">No matching topics.</p>
          )}
        </div>
      </div>
    </SideSheet>
  );
}

function GuideSectionView({
  section,
  onNavigate,
}: {
  section: GuideSection;
  onNavigate: (id: string) => void;
}) {
  return (
    <article className="anim-rise" key={section.id}>
      <h3 className="text-[19px] font-semibold tracking-[-0.015em]">
        {section.title}
      </h3>
      <p className="hint mt-1.5 text-[13px]">{section.whenToUse}</p>

      {section.steps.length > 0 && (
        <section className="mt-5">
          <h4 className="eyebrow">Steps</h4>
          <ol className="mt-2 flex flex-col gap-2">
            {section.steps.map((step, i) => (
              <li key={step} className="flex gap-2.5 text-[13px] leading-snug">
                <span
                  className="mt-px grid h-[17px] w-[17px] shrink-0 place-items-center rounded-full text-[10px] font-semibold"
                  style={{ background: "var(--fill-hi)", color: "var(--ink-2)" }}
                >
                  {i + 1}
                </span>
                <span style={{ color: "var(--ink-2)" }}>{step}</span>
              </li>
            ))}
          </ol>
        </section>
      )}

      <section className="mt-5">
        <h4 className="eyebrow">What you should see</h4>
        <ul className="mt-2 flex flex-col gap-2">
          {section.expectedResults.map((r) => (
            <li key={r} className="flex gap-2.5 text-[13px] leading-snug">
              <span className="mt-px shrink-0" style={{ color: "var(--ok)" }}>
                <Icon name="check" size={14} />
              </span>
              <span style={{ color: "var(--ink-2)" }}>{r}</span>
            </li>
          ))}
        </ul>
      </section>

      {section.commonMistakes && section.commonMistakes.length > 0 && (
        <section
          className="mt-5 rounded-[14px] p-3.5"
          style={{ background: "var(--warn-soft)" }}
        >
          <h4 className="eyebrow" style={{ color: "var(--warn)" }}>
            Common mistakes
          </h4>
          <ul className="mt-2 flex flex-col gap-1.5">
            {section.commonMistakes.map((m) => (
              <li
                key={m}
                className="text-[12.5px] leading-snug"
                style={{ color: "var(--warn)" }}
              >
                {m}
              </li>
            ))}
          </ul>
        </section>
      )}

      {section.relatedSectionIds && section.relatedSectionIds.length > 0 && (
        <section className="mt-6">
          <div className="divider mb-3" />
          <p className="eyebrow">Related</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {section.relatedSectionIds.map((id) => {
              const related = searchGuideSections("").find((s) => s.id === id);
              if (!related) return null;
              return (
                <button
                  key={id}
                  type="button"
                  onClick={() => onNavigate(id)}
                  className="chip chip-accent"
                >
                  {related.title}
                </button>
              );
            })}
          </div>
        </section>
      )}
    </article>
  );
}

export function GuideHelpButton({
  sectionId,
  className = "",
}: {
  sectionId?: string;
  className?: string;
}) {
  const openGuide = useGuideStore((s) => s.openGuide);
  return (
    <button
      type="button"
      onClick={() => openGuide(sectionId)}
      className={`btn btn-ghost btn-icon ${className}`}
      title="Open user guide"
      aria-label="Help"
    >
      <Icon name="help" size={14} />
    </button>
  );
}
