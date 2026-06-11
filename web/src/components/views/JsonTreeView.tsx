import { useQuery } from "@tanstack/react-query";
import { api } from "../../lib/api";
import { useViewerState } from "../../lib/state";

export default function JsonTreeView() {
  const v = useViewerState();
  const { data } = useQuery({
    queryKey: ["row-json", v.dataset_path, v.row_idx],
    queryFn: () => api.row(v.dataset_path!, v.row_idx),
    enabled: !!v.dataset_path,
  });
  if (!data) return <div className="p-6 text-zinc-500 text-sm">loading…</div>;
  return (
    <div className="h-full overflow-y-auto p-4">
      <pre className="text-xs font-mono bg-white dark:bg-zinc-900 border border-zinc-200 dark:border-zinc-800 p-3 rounded">
        {JSON.stringify(data, null, 2)}
      </pre>
    </div>
  );
}
