import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { api } from "../lib/api";
import { Star } from "lucide-react";

export default function MarkInline({ path, idx }: { path: string; idx: number }) {
  const qc = useQueryClient();
  const { data } = useQuery({
    queryKey: ["mark", path, idx],
    queryFn: () => api.getMark(path, idx),
  });
  const [tags, setTags] = useState("");
  const [note, setNote] = useState("");
  const [open, setOpen] = useState(false);

  useEffect(() => {
    setTags((data?.tags ?? []).join(", "));
    setNote(data?.note ?? "");
  }, [data]);

  const upsert = useMutation({
    mutationFn: (body: { tags: string[]; note: string }) => api.upsertMark(path, idx, body),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mark", path, idx] }),
  });
  const del = useMutation({
    mutationFn: () => api.deleteMark(path, idx),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["mark", path, idx] }),
  });

  const marked = !!data;

  return (
    <div className="relative">
      <button
        onClick={() => setOpen(!open)}
        className={"flex items-center gap-1 px-2 py-1 rounded text-xs border " +
          (marked
            ? "bg-amber-900/30 border-amber-700 text-amber-200"
            : "bg-white dark:bg-zinc-900 border-zinc-200 dark:border-zinc-800 text-zinc-600 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-zinc-800")}
        title={marked ? `${data!.tags.join(", ")} · ${data!.note}` : "mark row (m)"}
      >
        <Star size={12} fill={marked ? "currentColor" : "none"} />
        {marked ? data!.tags.join(", ") || "marked" : "mark"}
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-1 z-20 w-72 bg-white dark:bg-zinc-900 border border-zinc-300 dark:border-zinc-700 rounded p-2 shadow-xl text-xs">
          <label className="block mb-1 text-zinc-500">tags (comma-separated)</label>
          <input
            value={tags}
            onChange={(e) => setTags(e.target.value)}
            className="w-full px-1.5 py-1 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded outline-none focus:border-emerald-600"
          />
          <label className="block mt-2 mb-1 text-zinc-500">note</label>
          <textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            className="w-full px-1.5 py-1 bg-zinc-50 dark:bg-zinc-950 border border-zinc-200 dark:border-zinc-800 rounded outline-none focus:border-emerald-600 resize-none"
          />
          <div className="flex gap-1 mt-2">
            <button
              onClick={() => {
                const t = tags.split(",").map((s) => s.trim()).filter(Boolean);
                upsert.mutate({ tags: t, note });
                setOpen(false);
              }}
              className="px-2 py-0.5 bg-emerald-700 hover:bg-emerald-600 rounded"
            >save</button>
            {marked && (
              <button onClick={() => { del.mutate(); setOpen(false); }} className="px-2 py-0.5 bg-red-900/50 hover:bg-red-900 text-red-200 rounded">delete</button>
            )}
            <button onClick={() => setOpen(false)} className="ml-auto text-zinc-500 hover:text-zinc-700 dark:text-zinc-300">cancel</button>
          </div>
        </div>
      )}
    </div>
  );
}
