import Link from "next/link";
import type { ReactNode } from "react";
import { Icon, type IconName } from "./icons";

/** The top of every page: its name on the left, its main button(s) on the right. */
export function PageHeader({ title, children }: { title: ReactNode; children?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <h1 className="h1">{title}</h1>
      {children && <div className="flex flex-wrap items-center gap-2">{children}</div>}
    </div>
  );
}

/** Tabs that switch what the page shows. Exactly one is selected. */
export function Tabs({ label, items }: { label: string; items: { href: string; label: string; active: boolean }[] }) {
  return (
    <nav aria-label={label} className="tabs">
      {items.map((item) => (
        <Link key={item.href} href={item.href} className={`tab ${item.active ? "tab-on" : ""}`} aria-current={item.active ? "page" : undefined}>
          {item.label}
        </Link>
      ))}
    </nav>
  );
}

/** Shown in place of a list that has nothing in it yet: what the page is for, and how to start. */
export function EmptyState({
  icon,
  title,
  body,
  children,
}: {
  icon: IconName;
  title: string;
  body?: string;
  children?: ReactNode;
}) {
  return (
    <div className="card flex flex-col items-center px-6 py-10 text-center">
      <Icon name={icon} size={28} className="mb-3 text-muted" />
      <h2 className="h2">{title}</h2>
      {body && <p className="muted mt-1 max-w-sm">{body}</p>}
      {children && <div className="mt-4">{children}</div>}
    </div>
  );
}

/** "← Tasks" at the top of a detail page. */
export function BackLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="link mb-4 inline-flex min-h-9 items-center gap-1 text-[15px]">
      <Icon name="back" size={18} />
      {children}
    </Link>
  );
}
