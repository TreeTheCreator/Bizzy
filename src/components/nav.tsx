"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { type ReactNode, useState } from "react";
import { Icon, type IconName } from "./icons";

function isCurrent(pathname: string, href: string, exact: boolean): boolean {
  return exact ? pathname === href : pathname === href || pathname.startsWith(`${href}/`);
}

/** A sidebar link that is highlighted while you are on its page. */
export function NavLink({
  href,
  icon,
  exact = false,
  children,
}: {
  href: string;
  icon: IconName;
  exact?: boolean;
  children: ReactNode;
}) {
  const current = isCurrent(usePathname(), href, exact);
  return (
    <Link href={href} className={`nav-link ${current ? "nav-link-on" : ""}`} aria-current={current ? "page" : undefined}>
      <Icon name={icon} />
      {children}
    </Link>
  );
}

/** A tab that is a link to another page (used for the Settings sections). */
export function TabLink({ href, exact = false, children }: { href: string; exact?: boolean; children: ReactNode }) {
  const current = isCurrent(usePathname(), href, exact);
  return (
    <Link href={href} className={`tab ${current ? "tab-on" : ""}`} aria-current={current ? "page" : undefined}>
      {children}
    </Link>
  );
}

/**
 * The frame around the sidebar. On a computer the sidebar is always visible.
 * On a phone it becomes a slim bar with a Menu button, and the menu closes
 * again as soon as a page is chosen.
 */
export function SidebarShell({ title, children }: { title: string; children: ReactNode }) {
  const pathname = usePathname();
  const [openOn, setOpenOn] = useState<string | null>(null);
  const open = openOn === pathname;
  return (
    <aside className="border-b border-border bg-surface md:sticky md:top-0 md:h-screen md:w-64 md:shrink-0 md:overflow-y-auto md:border-b-0 md:border-r">
      <div className="flex items-center justify-between gap-3 px-4 py-2 md:hidden">
        <span className="truncate text-lg font-semibold">{title}</span>
        <button
          type="button"
          className="btn btn-sm"
          aria-expanded={open}
          aria-controls="sidebar-menu"
          onClick={() => setOpenOn(open ? null : pathname)}
        >
          <Icon name={open ? "close" : "menu"} size={18} />
          {open ? "Close" : "Menu"}
        </button>
      </div>
      <div id="sidebar-menu" className={`${open ? "block" : "hidden"} p-4 pt-2 md:block md:pt-4`}>
        {children}
      </div>
    </aside>
  );
}
