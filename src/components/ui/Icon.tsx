/**
 * Inline SVG icon set. Deliberately dependency-free: the app runs under a
 * strict CSP with no external hosts, so icons ship as path data.
 *
 * All glyphs are drawn on a 24×24 grid with a 1.7 stroke, rounded caps —
 * the weight that sits closest to SF Symbols at small sizes.
 */

export type IconName =
  | "alert"
  | "arrowLeft"
  | "arrowRight"
  | "book"
  | "check"
  | "checkCircle"
  | "chevronDown"
  | "clock"
  | "close"
  | "code"
  | "dots"
  | "edit"
  | "export"
  | "eye"
  | "filter"
  | "folder"
  | "grip"
  | "help"
  | "import"
  | "layers"
  | "minus"
  | "note"
  | "people"
  | "plus"
  | "refresh"
  | "search"
  | "settings"
  | "shield"
  | "sparkle"
  | "trash";

const PATHS: Record<IconName, string> = {
  alert: "M12 8.5v4.2M12 16.4h.01M10.3 3.9 2.7 17a2 2 0 0 0 1.7 3h15.2a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  arrowLeft: "M19 12H5m0 0 6.5-6.5M5 12l6.5 6.5",
  arrowRight: "M5 12h14m0 0-6.5-6.5M19 12l-6.5 6.5",
  book: "M4 5.5A2.5 2.5 0 0 1 6.5 3H20v14.5H6.5A2.5 2.5 0 0 0 4 20V5.5ZM4 20a2.5 2.5 0 0 1 2.5-2.5H20V21H6.5A2.5 2.5 0 0 1 4 20Z",
  check: "M4.5 12.8 9.5 17.8 19.5 6.5",
  checkCircle: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-12.8.4 2.9 2.9 5.7-6.2",
  chevronDown: "m6 9.5 6 6 6-6",
  clock: "M12 7.2V12l3.2 2.1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  close: "M6 6l12 12M18 6 6 18",
  code: "M8.5 4.8 4 12l4.5 7.2M15.5 4.8 20 12l-4.5 7.2",
  dots: "M6 12h.01M12 12h.01M18 12h.01",
  edit: "M17 3.5a2.1 2.1 0 0 1 3 3L8.5 18 4 19.5 5.5 15 17 3.5Z",
  export: "M12 15.5V3.5m0 0L7.8 7.8M12 3.5l4.2 4.3M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15",
  eye: "M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Zm12 0a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0Z",
  filter: "M4 5h16l-6.2 7.2v5.1l-3.6 1.7v-6.8L4 5Z",
  folder: "M3 7.5A2.5 2.5 0 0 1 5.5 5h3.2a2 2 0 0 1 1.5.7l1.1 1.3h7.2A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5v-9Z",
  grip: "M9 6.5h.01M9 12h.01M9 17.5h.01M15 6.5h.01M15 12h.01M15 17.5h.01",
  help: "M9.4 9.2a2.7 2.7 0 1 1 3.6 2.5c-.7.3-1 .9-1 1.6v.6M12 17.6h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z",
  import: "M12 3.5V15.5m0 0-4.2-4.3M12 15.5l4.2-4.3M4 15v3.5A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5V15",
  layers: "m12 3 8.5 4.5L12 12 3.5 7.5 12 3Zm8.5 9L12 16.5 3.5 12m17 4.5L12 21l-8.5-4.5",
  note: "M6 3.5h8.5L19 8v12.5H6V3.5Zm8.2 0V8H19M9 12.5h7M9 16h4.5",
  people: "M15.5 20v-1.6a3.4 3.4 0 0 0-3.4-3.4H6.4A3.4 3.4 0 0 0 3 18.4V20M12.2 7.9a3.2 3.2 0 1 1-6.4 0 3.2 3.2 0 0 1 6.4 0ZM21 20v-1.6a3.4 3.4 0 0 0-2.6-3.3M15.6 4.7a3.2 3.2 0 0 1 0 6.2",
  plus: "M12 5.5v13M5.5 12h13",
  minus: "M5.5 12h13",
  refresh: "M20 11.5a8 8 0 1 0-.6 4M20 5.5V12h-6",
  search: "m20 20-3.6-3.6M18.5 11a7.5 7.5 0 1 1-15 0 7.5 7.5 0 0 1 15 0Z",
  settings:
    "M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  sparkle:
    "M12 3.2 13.6 8 18.4 9.6 13.6 11.2 12 16 10.4 11.2 5.6 9.6 10.4 8 12 3.2ZM18.6 15.4l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7.7-2Z",
  shield:
    "M12 3.2c2.6 1.3 4.9 1.9 7 2v5.5c0 4.4-2.7 7.7-7 9.6-4.3-1.9-7-5.2-7-9.6V5.2c2.1-.1 4.4-.7 7-2Z",
  trash: "M4.5 7h15M9.5 7V5.2A1.7 1.7 0 0 1 11.2 3.5h1.6A1.7 1.7 0 0 1 14.5 5.2V7M6.5 7l.8 12A1.8 1.8 0 0 0 9.1 20.7h5.8A1.8 1.8 0 0 0 16.7 19l.8-12",
};

interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
}

export function Icon({ name, size = 16, className = "" }: IconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      className={className}
      style={{ flexShrink: 0 }}
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
