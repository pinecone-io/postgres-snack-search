// Owns its own show/hide state: nothing outside this panel reads it.
// Type-only imports because @/lib/shopperBrain reads @/lib/env at module
// load, which throws in the browser.
import { useState } from "react";
import type { LlmCallLog as LlmCall, ShopperBrain } from "@/lib/shopperBrain";

/** What the LLM shoppers actually sent and got back, prompt and raw
 * response included — the fallback to templated is visible here rather
 * than hidden, so a missing key looks like a missing key. */
export function LlmCallLog({ calls, brain }: { calls: LlmCall[]; brain: ShopperBrain }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="flex flex-col gap-2 border border-border bg-background p-3">
      <div className="flex items-center justify-between">
        <p className="font-mono text-xs font-bold tracking-wide text-muted-foreground uppercase">
          llm calls {brain === "llm" ? "" : "(switch to LLM to see one)"}
        </p>
        {calls.length > 0 && (
          <button
            onClick={() => setOpen((s) => !s)}
            className="font-mono text-xs text-primary underline underline-offset-2"
          >
            {open ? "hide" : `show (${calls.length})`}
          </button>
        )}
      </div>
      {open && (
        <div className="flex flex-col gap-2 overflow-y-auto" style={{ maxHeight: 220 }}>
          {calls.map((call, i) => (
            <div key={i} className="animate-in fade-in slide-in-from-top-2 border-b border-border/50 pb-2 text-xs">
              <p className="font-mono font-bold text-foreground">{call.agentId}</p>
              <p className="mt-0.5 text-muted-foreground">{call.prompt}</p>
              <p className="mt-0.5 font-mono text-[10px] text-muted-foreground/70">
                {call.latencyMs}ms · raw: {call.rawResponse}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
