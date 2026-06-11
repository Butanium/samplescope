/**
 * Highlights drawer — define + reorder + edit named highlight rules.
 *
 * Shape mirrors `JudgePanel` (PanelHeader + scrollable rule list + inline
 * expand-to-edit), with a paint-palette swatch grid in place of model
 * dropdowns. Each rule row collapses to a one-liner: reorder arrows, a color
 * dab, an inline-editable name, the pattern preview, and edit/delete affordances.
 * Expanding reveals the full editor (pattern textarea, regex/case toggles, role
 * + column scopes, JS condition expression).
 *
 * Conditions are pure JS strings eval'd via `new Function` in the renderer —
 * single-user local app, no security boundary.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown, ArrowUp, Pencil, Plus, Trash2, X,
} from "lucide-react";
import { useState } from "react";
import { api } from "../lib/api";
import { cn } from "../lib/utils";
import type { HighlightRule } from "../lib/types";
import { PanelHeader } from "./MarkPanel";

/** Curated paint-marker palette. Bright, slightly saturated, easy to tell apart. */
const PALETTE: string[] = [
  "#fde047", // canary
  "#fbbf24", // amber
  "#fb923c", // tangerine
  "#f87171", // coral
  "#f472b6", // bubblegum
  "#e879f9", // fuchsia
  "#a78bfa", // violet
  "#60a5fa", // sky
  "#22d3ee", // cyan
  "#2dd4bf", // teal
  "#34d399", // mint
  "#a3e635", // lime
];

type Draft = Omit<HighlightRule, "sort_order"> & { sort_order?: number };

const ROLES = ["", "user", "assistant", "system", "tool"] as const;

function shortId(): string {
  /** URL-safe random id for a fresh rule. Not security-sensitive. */
  const arr = new Uint8Array(8);
  crypto.getRandomValues(arr);
  return Array.from(arr).map((b) => b.toString(36).padStart(2, "0")).join("").slice(0, 12);
}

function emptyDraft(): Draft {
  return {
    id: shortId(),
    name: "untitled",
    enabled: true,
    pattern: "",
    is_regex: false,
    case_sensitive: false,
    color: PALETTE[0],
    scope_role: null,
    scope_column: null,
    condition: null,
  };
}

export default function HighlightsPanel({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: rules } = useQuery({
    queryKey: ["highlights"],
    queryFn: () => api.listHighlights(),
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);

  const upsert = useMutation({
    mutationFn: (d: Draft) => {
      const { id, ...body } = d;
      return api.upsertHighlight(id, body as Omit<HighlightRule, "id">);
    },
    onSuccess: (saved) => {
      qc.invalidateQueries({ queryKey: ["highlights"] });
      setEditingId(null);
      setDraft(null);
      // Keep focus on the just-edited row by leaving editingId null (collapse).
      void saved;
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.deleteHighlight(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["highlights"] }),
  });
  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.reorderHighlights(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["highlights"] }),
  });

  /** Persist a partial change immediately (toggle, color tweak, rename). */
  function patch(rule: HighlightRule, change: Partial<HighlightRule>) {
    const merged = { ...rule, ...change };
    upsert.mutate(merged);
  }

  function move(id: string, delta: -1 | 1) {
    if (!rules) return;
    const idx = rules.findIndex((r) => r.id === id);
    if (idx < 0) return;
    const target = idx + delta;
    if (target < 0 || target >= rules.length) return;
    const ids = rules.map((r) => r.id);
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    reorder.mutate(ids);
  }

  function startNew() {
    const d = emptyDraft();
    setDraft(d);
    setEditingId(d.id);
  }

  function startEdit(rule: HighlightRule) {
    setDraft({ ...rule });
    setEditingId(rule.id);
  }

  return (
    <>
      <PanelHeader title="highlights" onClose={onClose}>
        <button
          onClick={startNew}
          className="text-[10px] flex items-center gap-1 px-2 py-0.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded"
        ><Plus size={10} /> new</button>
      </PanelHeader>

      <div className="flex-1 overflow-y-auto text-xs">
        {(!rules || rules.length === 0) && !draft && (
          <div className="px-4 py-12 text-center text-zinc-500">
            <div className="mx-auto mb-3 flex flex-wrap justify-center gap-1.5 max-w-[140px] opacity-60">
              {PALETTE.slice(0, 6).map((c) => (
                <span
                  key={c}
                  className="w-5 h-5 rounded-md"
                  style={{ background: c }}
                />
              ))}
            </div>
            <div className="italic">no rules yet</div>
            <div className="mt-1 text-[10px] text-zinc-400 dark:text-zinc-600">
              click <span className="font-mono">+ new</span> to define a pattern
            </div>
          </div>
        )}

        {rules?.map((rule, i) => {
          const isEditing = editingId === rule.id;
          return (
            <div
              key={rule.id}
              className="border-b border-zinc-100 dark:border-zinc-900 group"
            >
              <RuleRow
                rule={rule}
                isFirst={i === 0}
                isLast={i === rules.length - 1}
                isEditing={isEditing}
                onMoveUp={() => move(rule.id, -1)}
                onMoveDown={() => move(rule.id, +1)}
                onToggle={() => patch(rule, { enabled: !rule.enabled })}
                onPickColor={(c) => patch(rule, { color: c })}
                onRename={(name) => name !== rule.name && patch(rule, { name })}
                onEdit={() => (isEditing ? (setEditingId(null), setDraft(null)) : startEdit(rule))}
                onDelete={() => del.mutate(rule.id)}
              />
              {isEditing && draft && (
                <RuleEditor
                  draft={draft}
                  setDraft={setDraft}
                  onSave={() => upsert.mutate(draft)}
                  onCancel={() => {
                    setEditingId(null);
                    setDraft(null);
                  }}
                  saving={upsert.isPending}
                  error={upsert.error ? String(upsert.error) : null}
                />
              )}
            </div>
          );
        })}

        {/* New-rule editor (no row to attach to). */}
        {draft && rules && !rules.some((r) => r.id === draft.id) && (
          <div className="border-b-2 border-emerald-500/50 dark:border-emerald-700/50 bg-emerald-50/30 dark:bg-emerald-950/20">
            <div className="px-3 py-2 text-[10px] uppercase tracking-wider text-emerald-700 dark:text-emerald-400 flex items-center gap-2">
              <Plus size={10} /> new rule
            </div>
            <RuleEditor
              draft={draft}
              setDraft={setDraft}
              onSave={() => upsert.mutate(draft)}
              onCancel={() => {
                setEditingId(null);
                setDraft(null);
              }}
              saving={upsert.isPending}
              error={upsert.error ? String(upsert.error) : null}
            />
          </div>
        )}
      </div>
    </>
  );
}

// ------------------------------------------------------------------ rule row

function RuleRow(props: {
  rule: HighlightRule;
  isFirst: boolean;
  isLast: boolean;
  isEditing: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onToggle: () => void;
  onPickColor: (c: string) => void;
  onRename: (name: string) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { rule, isFirst, isLast, isEditing, onMoveUp, onMoveDown, onToggle,
    onPickColor, onRename, onEdit, onDelete } = props;
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(rule.name);
  const [paletteOpen, setPaletteOpen] = useState(false);

  function commitRename() {
    setRenaming(false);
    if (name.trim()) onRename(name.trim());
    else setName(rule.name);
  }

  return (
    <div
      className={cn(
        "px-3 py-2 flex items-center gap-2 hover:bg-zinc-50 dark:hover:bg-zinc-950/50 relative",
        isEditing && "bg-zinc-50 dark:bg-zinc-950/50",
      )}
    >
      {/* Reorder column — discrete arrows in a single tight stack. */}
      <div className="flex flex-col -space-y-px shrink-0 opacity-40 group-hover:opacity-100 transition-opacity">
        <button
          onClick={onMoveUp}
          disabled={isFirst}
          className="p-px hover:text-emerald-500 disabled:opacity-30 disabled:hover:text-inherit"
          title="move up"
        ><ArrowUp size={10} /></button>
        <button
          onClick={onMoveDown}
          disabled={isLast}
          className="p-px hover:text-emerald-500 disabled:opacity-30 disabled:hover:text-inherit"
          title="move down"
        ><ArrowDown size={10} /></button>
      </div>

      {/* Color dab — click to open the palette popover; long-press metaphor. */}
      <div className="relative shrink-0">
        <button
          onClick={() => setPaletteOpen((o) => !o)}
          title={`color · click to change · ${rule.enabled ? "enabled" : "disabled"}`}
          className={cn(
            "w-6 h-6 rounded-md transition-all",
            rule.enabled
              ? "shadow-sm ring-1 ring-black/5 dark:ring-white/10"
              : "opacity-30 ring-1 ring-zinc-400 dark:ring-zinc-600",
          )}
          style={{
            background: rule.enabled ? rule.color : "transparent",
            borderColor: rule.color,
          }}
        />
        {paletteOpen && (
          <ColorPalettePopover
            current={rule.color}
            onPick={(c) => {
              setPaletteOpen(false);
              onPickColor(c);
            }}
            onClose={() => setPaletteOpen(false)}
          />
        )}
      </div>

      {/* Enabled toggle — a tiny pill. The color dab carries the visual story; this is just the affordance. */}
      <button
        onClick={onToggle}
        title={rule.enabled ? "disable rule" : "enable rule"}
        className={cn(
          "shrink-0 text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded",
          rule.enabled
            ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
            : "bg-zinc-200 dark:bg-zinc-800 text-zinc-500",
        )}
      >
        {rule.enabled ? "on" : "off"}
      </button>

      {/* Name — inline editable. */}
      <div className="min-w-0 flex-1">
        {renaming ? (
          <input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onBlur={commitRename}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") { setName(rule.name); setRenaming(false); }
            }}
            className="w-full bg-transparent outline-none border-b border-emerald-500 text-[12px] font-mono"
          />
        ) : (
          <button
            onClick={() => setRenaming(true)}
            className="text-left w-full truncate text-[12px] font-mono text-zinc-800 dark:text-zinc-200 hover:text-emerald-600 dark:hover:text-emerald-400"
            title="click to rename"
          >
            {rule.name}
          </button>
        )}
        <div className="text-[10px] font-mono text-zinc-500 truncate">
          {rule.is_regex && <span className="text-violet-500 mr-1">/re/</span>}
          {rule.case_sensitive && <span className="text-amber-500 mr-1">Aa</span>}
          {rule.scope_role && <span className="text-cyan-600 dark:text-cyan-400 mr-1">@{rule.scope_role}</span>}
          {rule.scope_column && <span className="text-pink-500 mr-1">[{rule.scope_column}]</span>}
          {rule.condition && <span className="text-zinc-400 mr-1" title={rule.condition}>ƒ</span>}
          <span className="text-zinc-600 dark:text-zinc-400">{rule.pattern || "(empty)"}</span>
        </div>
      </div>

      <button
        onClick={onEdit}
        className={cn(
          "shrink-0 p-1 rounded text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200 hover:bg-zinc-200/60 dark:hover:bg-zinc-800/60",
          isEditing && "bg-zinc-200 dark:bg-zinc-800 text-zinc-900 dark:text-zinc-100",
        )}
        title={isEditing ? "close editor" : "edit details"}
      >
        <Pencil size={11} />
      </button>
      <button
        onClick={onDelete}
        className="shrink-0 p-1 rounded text-zinc-400 hover:text-rose-500 hover:bg-rose-50 dark:hover:bg-rose-950/30"
        title="delete rule"
      >
        <Trash2 size={11} />
      </button>
    </div>
  );
}

// --------------------------------------------------------- color palette UI

function ColorPalettePopover(props: {
  current: string;
  onPick: (c: string) => void;
  onClose: () => void;
}) {
  const { current, onPick, onClose } = props;
  const [hex, setHex] = useState(current);
  return (
    <>
      <div className="fixed inset-0 z-30" onClick={onClose} />
      <div
        className="absolute left-0 top-full mt-1.5 z-40 p-2.5 rounded-lg bg-white dark:bg-zinc-900 shadow-lg ring-1 ring-black/5 dark:ring-white/10 w-[156px]"
      >
        <div className="grid grid-cols-4 gap-1.5">
          {PALETTE.map((c) => {
            const selected = c.toLowerCase() === current.toLowerCase();
            return (
              <button
                key={c}
                onClick={() => onPick(c)}
                className={cn(
                  "h-7 rounded-md transition-transform shadow-sm ring-1 ring-black/5 dark:ring-white/10 hover:scale-105",
                  selected && "scale-105 ring-2 ring-zinc-900 dark:ring-zinc-100",
                )}
                style={{ background: c }}
                title={c}
              />
            );
          })}
        </div>
        <div className="flex items-center gap-1.5 mt-2">
          <span
            className="w-4 h-4 rounded-sm shadow-sm ring-1 ring-black/5 dark:ring-white/10 shrink-0"
            style={{ background: hex }}
          />
          <input
            value={hex}
            onChange={(e) => setHex(e.target.value)}
            placeholder="#hex"
            className="flex-1 min-w-0 px-1.5 py-0.5 bg-transparent border-b border-zinc-200 dark:border-zinc-800 outline-none text-[10px] font-mono focus:border-emerald-500"
          />
          <button
            onClick={() => /^#[0-9a-f]{3,8}$/i.test(hex) && onPick(hex)}
            className="text-[10px] uppercase tracking-wider text-emerald-600 dark:text-emerald-400 hover:underline"
          >set</button>
        </div>
      </div>
    </>
  );
}

// ------------------------------------------------------------------ editor

function RuleEditor(props: {
  draft: Draft;
  setDraft: (d: Draft) => void;
  onSave: () => void;
  onCancel: () => void;
  saving: boolean;
  error: string | null;
}) {
  const { draft, setDraft, onSave, onCancel, saving, error } = props;

  return (
    <div className="px-3 py-3 space-y-2.5 text-xs bg-zinc-50/70 dark:bg-zinc-950/70">
      <Labeled label="pattern">
        <textarea
          value={draft.pattern}
          onChange={(e) => setDraft({ ...draft, pattern: e.target.value })}
          rows={2}
          placeholder={draft.is_regex ? "regex source, e.g. \\bfish(es)?\\b" : "literal substring"}
          className="w-full px-2 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono text-[11px] outline-none focus:border-emerald-500 resize-y"
        />
      </Labeled>

      <div className="flex items-center gap-3 text-[10px]">
        <Toggle
          on={draft.is_regex}
          onClick={() => setDraft({ ...draft, is_regex: !draft.is_regex })}
          label="regex"
          tone="violet"
        />
        <Toggle
          on={draft.case_sensitive}
          onClick={() => setDraft({ ...draft, case_sensitive: !draft.case_sensitive })}
          label="case-sensitive"
          tone="amber"
        />
        <span className="ml-auto text-zinc-400 dark:text-zinc-600 font-mono">
          {draft.is_regex ? "//" : "lit"}{draft.case_sensitive ? "" : "/i"}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <Labeled label="role scope">
          <select
            value={draft.scope_role ?? ""}
            onChange={(e) => setDraft({ ...draft, scope_role: e.target.value || null })}
            className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono outline-none focus:border-emerald-500"
          >
            {ROLES.map((r) => (
              <option key={r || "any"} value={r}>{r || "any"}</option>
            ))}
          </select>
        </Labeled>
        <Labeled label="column scope">
          <input
            value={draft.scope_column ?? ""}
            onChange={(e) => setDraft({ ...draft, scope_column: e.target.value || null })}
            placeholder="(any)"
            className="w-full px-2 py-1 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono outline-none focus:border-emerald-500"
          />
        </Labeled>
      </div>

      <Labeled label="condition (optional · JS expression)">
        <textarea
          value={draft.condition ?? ""}
          onChange={(e) => setDraft({ ...draft, condition: e.target.value || null })}
          rows={2}
          placeholder="row.metadata?.score > 0.5"
          className="w-full px-2 py-1.5 bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 rounded font-mono text-[11px] outline-none focus:border-emerald-500 resize-y"
        />
        <div className="text-[10px] text-zinc-500 mt-1 font-mono">
          eval'd as <span className="text-zinc-700 dark:text-zinc-300">(row, msg) =&gt; …</span>
        </div>
      </Labeled>

      {error && (
        <div className="text-[10px] text-rose-500 px-2 py-1 bg-rose-50 dark:bg-rose-950/30 rounded">
          {error}
        </div>
      )}

      <div className="flex gap-2 pt-1">
        <button
          onClick={onSave}
          disabled={saving || !draft.name || !draft.pattern}
          className="px-3 py-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded disabled:opacity-50 text-[11px]"
        >{saving ? "saving…" : "save"}</button>
        <button
          onClick={onCancel}
          className="px-3 py-1 bg-zinc-200 dark:bg-zinc-800 rounded hover:bg-zinc-300 dark:hover:bg-zinc-700 text-[11px] flex items-center gap-1"
        ><X size={10} /> cancel</button>
      </div>
    </div>
  );
}

function Toggle(props: { on: boolean; onClick: () => void; label: string; tone: "violet" | "amber" }) {
  const { on, onClick, label, tone } = props;
  const onCls =
    tone === "violet"
      ? "bg-violet-500/15 text-violet-700 dark:text-violet-300"
      : "bg-amber-500/15 text-amber-700 dark:text-amber-300";
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-2 py-0.5 rounded uppercase tracking-wider",
        on ? onCls : "bg-zinc-200 dark:bg-zinc-800 text-zinc-500",
      )}
    >
      {label}
    </button>
  );
}

function Labeled({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-0.5">{label}</div>
      {children}
    </label>
  );
}
