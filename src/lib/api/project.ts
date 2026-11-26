/** API domain: project */

import {
  invoke,
} from "./host";

export type ProjectRecord = {
  id: string;
  name: string;
  path: string;
  trusted: boolean;
  pathOk: boolean;
  pinned?: boolean;
  system?: boolean;
  sshAlias?: string | null;
  color?: string | null;
};

export async function projectsList() {
  return invoke<ProjectRecord[]>("projects_list");
}

/** On-disk default cwd for orphan chats (`{app_data}/workspaces/general`). */
export async function generalWorkspacePath() {
  return invoke<string>("general_workspace_path");
}

export async function projectAdd(path: string, trust: boolean) {
  return invoke("project_add", { path, trust });
}

export async function projectAddSsh(alias: string, path: string, trust: boolean) {
  return invoke<{
    id: string;
    name: string;
    path: string;
    trusted: boolean;
    pathOk: boolean;
    pinned?: boolean;
    sshAlias?: string | null;
  }>("project_add_ssh", { alias, path, trust });
}

/**
 * Persist sidebar project order. Host pin-partitions so unpinned items
 * cannot sit above pinned ones. Returns the final ordered list.
 */
export async function projectsReorder(orderedIds: string[]) {
  return invoke<ProjectRecord[]>("projects_reorder", { orderedIds });
}
