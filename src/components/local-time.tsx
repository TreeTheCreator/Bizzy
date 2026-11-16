"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

function format(iso: string, timeZone?: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === new Date().getFullYear() ? undefined : "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone,
  }).format(date);
}

/**
 * A date and time shown in the reader's own time zone ("Nov 14, 3:20 PM").
 * The server does not know the time zone, so it renders UTC and the browser
 * swaps in the local time once the page is live.
 */
export function LocalTime({ iso }: { iso: string }) {
  const text = useSyncExternalStore(
    subscribe,
    () => format(iso),
    () => `${format(iso, "UTC")} UTC`,
  );
  return <time dateTime={iso}>{text}</time>;
}
