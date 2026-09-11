"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/", label: "Home" },
  { href: "/snacks", label: "Search" },
  { href: "/shop", label: "Shop" },
];

export function SiteNav() {
  const pathname = usePathname();

  return (
    <header className="border-b border-border bg-card">
      <nav className="mx-auto flex w-full max-w-6xl items-center gap-6 px-6 py-3">
        <span className="font-mono text-xs font-bold tracking-wide text-foreground uppercase">
          Snack Shop
        </span>
        <div className="flex gap-1">
          {LINKS.map((link) => {
            const active = pathname === link.href;
            return (
              <Link
                key={link.href}
                href={link.href}
                className={`px-3 py-1.5 text-sm font-medium ${
                  active ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </div>
      </nav>
    </header>
  );
}
