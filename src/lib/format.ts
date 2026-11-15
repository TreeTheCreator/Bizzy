const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });
const usdWhole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Money for display. Bizzy has one currency for now. */
export function formatMoney(amount: number, whole = false): string {
  return (whole ? usdWhole : usd).format(amount);
}

/** "in_progress" → "In progress", "read_only" → "Read only". */
export function humanize(value: string): string {
  const words = value.replace(/[_.]/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const DAY_MS = 24 * 60 * 60 * 1000;
const dayOf = (value: string) => Date.parse(`${value.slice(0, 10)}T00:00:00Z`);

/** A calendar date for display: "Fri, Nov 20", with the year when it is not this year. */
export function formatDate(value: string | null | undefined): string {
  if (!value) return "";
  const time = dayOf(value);
  if (Number.isNaN(time)) return value;
  const date = new Date(time);
  const sameYear = date.getUTCFullYear() === new Date().getUTCFullYear();
  return new Intl.DateTimeFormat("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: sameYear ? undefined : "numeric",
    timeZone: "UTC",
  }).format(date);
}

export type Tone = "neutral" | "info" | "ok" | "warn" | "danger";

/** The CSS class for a status pill of the given tone. */
export function pillClass(tone: Tone): string {
  return tone === "neutral" ? "pill" : `pill pill-${tone}`;
}

/** How to describe a due date next to today's date: "3 days late", "Due today", or the date. */
export function dueLabel(due: string | null | undefined, today: string): { label: string; tone: Tone } | null {
  if (!due) return null;
  const days = Math.round((dayOf(due) - dayOf(today)) / DAY_MS);
  if (Number.isNaN(days)) return null;
  if (days < -1) return { label: `${-days} days late`, tone: "danger" };
  if (days === -1) return { label: "1 day late", tone: "danger" };
  if (days === 0) return { label: "Due today", tone: "warn" };
  if (days === 1) return { label: "Due tomorrow", tone: "neutral" };
  return { label: `Due ${formatDate(due)}`, tone: "neutral" };
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}
