import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";
import PreOrMarkdown from "../PreOrMarkdown";

/**
 * Render a `.md`/`.markdown` file as prose. These files have no rows, so they
 * bypass the DuckDB sample pipeline entirely — we just fetch the raw bytes
 * from `/api/datasets/file` and hand them to `PreOrMarkdown` in markdown mode.
 */
export default function MarkdownView() {
  const v = useViewerState();
  const path = v.dataset_path;
  const { data, isLoading, error } = useQuery({
    queryKey: ["markdown", path],
    queryFn: async () => {
      const res = await fetch(api.fileUrl(path!));
      if (!res.ok) throw new Error(`failed to load (${res.status})`);
      return res.text();
    },
    enabled: !!path,
  });

  if (isLoading) return <div className="p-6 text-zinc-500 text-sm">loading…</div>;
  if (error) return <div className="p-6 text-red-400 text-sm">{String(error)}</div>;

  return (
    <div className="h-full overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-6">
        <PreOrMarkdown text={data ?? ""} mode="markdown" />
      </div>
    </div>
  );
}
