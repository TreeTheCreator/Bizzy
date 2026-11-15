/** A small set of line icons, drawn inline so no icon package is needed. */
const PATHS = {
  home: "M4 11l8-7 8 7M6 10v9h4v-5h4v5h4v-9",
  tasks: "M4 5h16v14H4zM8 12l3 3 5-6",
  docs: "M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5",
  customers: "M9 11a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM2.5 20c0-3.3 2.9-5.5 6.5-5.5s6.5 2.2 6.5 5.5M16 4.3a3.5 3.5 0 010 6.4M18 14.8c2.1.7 3.5 2.4 3.5 5.2",
  money: "M12 21a9 9 0 100-18 9 9 0 000 18zM15 9.2c-.5-1-1.6-1.7-3-1.7-1.8 0-3 1-3 2.3 0 3 6 1.4 6 4.5 0 1.300-1.300 2.300-3 2.300-1.500 0-2.700-.700-3.200-1.800M12 5.800v1.700M12 16.600v1.700",
  bell: "M6 16V11a6 6 0 1112 0v5l1.500 2h-15zM10 20a2 2 0 004 0",
  settings: "M4 7h9M17 7h3M4 17h3M11 17h9M15 5v4M9 15v4",
  plus: "M12 5v14M5 12h14",
  search: "M11 18a7 7 0 100-14 7 7 0 000 14zM20 20l-4-4",
  download: "M12 4v11M7 11l5 5 5-5M5 20h14",
  menu: "M4 7h16M4 12h16M4 17h16",
  close: "M6 6l12 12M18 6L6 18",
  check: "M5 12.500l4.500 4.500L19 7.500",
  chevron: "M6 9l6 6 6-6",
  back: "M15 6l-6 6 6 6",
  swap: "M7 4L3 8l4 4M3 8h14M17 12l4 4-4 4M21 16H7",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 20, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      className={`shrink-0 ${className ?? ""}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
