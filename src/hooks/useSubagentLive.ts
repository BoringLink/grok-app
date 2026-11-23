import { useSyncExternalStore } from "react";
import { subagentLiveStore } from "@/lib/subagentLiveStore";

/** Read one parent session's process-lifetime child activity snapshot. */
export function useSubagentLive(sessionId: string | null | undefined) {
  useSyncExternalStore(
    subagentLiveStore.subscribe,
    subagentLiveStore.getSnapshot,
    subagentLiveStore.getSnapshot,
  );
  return {
    children: subagentLiveStore.list(sessionId),
    selectedChildId: subagentLiveStore.selected(sessionId),
  };
}
