"use client";

import { FlaskConical, Layers3, Network } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";

const NAV_ITEMS = [
  { href: "/", label: "Multi Agent System", Icon: Network },
  { href: "/testing", label: "Testing", Icon: FlaskConical },
] as const;

export function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="sidebar">
      <Link className="brand" href="/" aria-label="Research Control home">
        <span className="brand-mark" aria-hidden="true">
          <Layers3 size={19} strokeWidth={1.8} />
        </span>
        <span className="brand-copy">
          <strong>Research Control</strong>
          <span>Admin console</span>
        </span>
      </Link>

      <nav className="sidebar-nav" aria-label="Primary">
        {NAV_ITEMS.map(({ href, label, Icon }) => {
          const isActive = pathname === href;
          return (
            <Link
              key={href}
              className={isActive ? "sidebar-link is-active" : "sidebar-link"}
              href={href}
              aria-current={isActive ? "page" : undefined}
            >
              <span className="sidebar-link-icon" aria-hidden="true">
                <Icon size={17} strokeWidth={1.8} />
              </span>
              {label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
