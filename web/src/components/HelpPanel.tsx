import { PanelHeader } from "./MarkPanel";

const SECTIONS: { title: string; keys: [string, string][] }[] = [
  {
    title: "navigate",
    keys: [
      ["j  ↓  →", "next row (next group when grouped)"],
      ["k  ↑  ←", "previous row (prev group when grouped)"],
      ["]", "next sample in group"],
      ["[", "prev sample in group"],
      ["s", "shuffle"],
      ["/", "focus regex filter"],
    ],
  },
  {
    title: "drawers",
    keys: [
      ["c", "chat"],
      ["m", "marks"],
      ["g", "judges"],
      ["h", "highlights"],
      ["\\", "SQL pad"],
      ["?", "this help"],
    ],
  },
  {
    title: "chat",
    keys: [
      ["⇧⇥", "cycle permission mode"],
      ["⏎", "send message"],
      ["⇧⏎", "newline"],
    ],
  },
  {
    title: "general",
    keys: [
      ["click text", "expand / collapse"],
      ["click row #", "set active"],
      ["click ⭐", "mark with tags + note"],
      ["⇧ + click", "pin to active chat tab"],
    ],
  },
];

export default function HelpPanel({ onClose }: { onClose: () => void }) {
  return (
    <>
      <PanelHeader title="keyboard" onClose={onClose} />
      <div className="flex-1 overflow-y-auto px-3 py-3 text-xs space-y-5">
        {SECTIONS.map((s) => (
          <section key={s.title}>
            <div className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 mb-2">
              {s.title}
            </div>
            <dl className="space-y-1">
              {s.keys.map(([k, v]) => (
                <div key={k} className="grid grid-cols-[5.5rem_1fr] items-baseline gap-3">
                  <dt className="font-mono text-zinc-700 dark:text-zinc-300 tracking-wider">
                    {k}
                  </dt>
                  <dd className="text-zinc-500">{v}</dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
        <p className="text-[10px] text-zinc-500 pt-2 border-t border-zinc-200/60 dark:border-zinc-800/70">
          shortcuts ignore keypresses inside text inputs.
        </p>
      </div>
    </>
  );
}
