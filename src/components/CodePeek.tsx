"use client";

import { useMemo, useState } from "react";

export interface CodePanel {
  label: string;
  caption?: string;
  code: string;
}

// Strings (JSON keys included), numbers, literals, keywords, comments.
// Scoped to the two snippets in @/lib/codeSamples, not a general highlighter.
const TOKEN =
  /(\/\/[^\n]*)|("(?:[^"\\]|\\.)*")|(\b(?:true|false|null)\b)|(-?\b\d+(?:\.\d+)?\b)|(\b(?:await|const|new|return|type)\b)/g;

const CLASS = [
  "text-muted-foreground italic", // comment
  "text-[var(--chart-2)]", // string
  "text-[var(--chart-3)]", // literal
  "text-[var(--chart-3)]", // number
  "text-primary font-bold", // keyword
];

function highlight(code: string) {
  const out: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(code)) !== null) {
    if (m.index > last) out.push(code.slice(last, m.index));
    const group = m.slice(1).findIndex(Boolean);
    out.push(
      <span key={`${m.index}`} className={CLASS[group]}>
        {m[0]}
      </span>,
    );
    last = m.index + m[0].length;
  }
  if (last < code.length) out.push(code.slice(last));
  return out;
}

function Code({ code }: { code: string }) {
  const nodes = useMemo(() => highlight(code), [code]);
  return (
    <pre className="flex-1 overflow-x-auto bg-muted p-3 font-mono text-[11px] leading-relaxed text-foreground">
      <code>{nodes}</code>
    </pre>
  );
}

export function CodePeek({ panels, summary }: { panels: CodePanel[]; summary: string }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="mt-3">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex items-center gap-2 font-mono text-xs font-bold tracking-wide text-muted-foreground uppercase transition-colors hover:text-foreground"
      >
        <span aria-hidden className={`inline-block transition-transform ${open ? "rotate-90" : ""}`}>
          ▸
        </span>
        {summary}
      </button>

      {open && (
        <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-2">
          {panels.map((panel) => (
            <div key={panel.label} className="flex min-w-0 flex-col border border-border bg-background">
              <p className="border-b border-border px-3 py-2 font-mono text-[10px] font-bold tracking-wide text-muted-foreground uppercase">
                {panel.label}
              </p>
              <Code code={panel.code} />
              {panel.caption && (
                <p className="border-t border-border px-3 py-2 font-mono text-[10px] text-muted-foreground">
                  {panel.caption}
                </p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
