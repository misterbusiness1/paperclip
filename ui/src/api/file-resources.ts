import type {
  ResolvedWorkspaceResource,
  WorkspaceFileContent,
  WorkspaceFileListMode,
  WorkspaceFileListResponse,
  WorkspaceFileSelector,
} from "@paperclipai/shared";
import { api, type RequestOptions } from "./client";

export interface FileResourceQuery {
  path: string;
  workspace?: WorkspaceFileSelector;
  projectId?: string | null;
  workspaceId?: string | null;
}

export interface FileResourceListQuery {
  workspace?: WorkspaceFileSelector;
  projectId?: string | null;
  workspaceId?: string | null;
  path?: string | null;
  mode?: WorkspaceFileListMode;
  q?: string | null;
  limit?: number;
  offset?: number;
}

function buildQuery(query: FileResourceQuery | FileResourceListQuery): string {
  const params = new URLSearchParams();
  if (query.projectId && query.workspaceId) {
    params.set("projectId", query.projectId);
    params.set("workspaceId", query.workspaceId);
  }
  if ("path" in query && query.path) params.set("path", query.path);
  if (query.workspace && query.workspace !== "auto") {
    params.set("workspace", query.workspace);
  }
  if ("mode" in query && query.mode && query.mode !== "all") params.set("mode", query.mode);
  if ("q" in query && query.q) params.set("q", query.q);
  if ("limit" in query && query.limit) params.set("limit", String(query.limit));
  if ("offset" in query && query.offset) params.set("offset", String(query.offset));
  return params.toString();
}

export function buildFileResourceDownloadUrl(issueId: string, query: FileResourceQuery): string {
  const params = new URLSearchParams(buildQuery(query));
  params.set("download", "1");
  return `/api/issues/${encodeURIComponent(issueId)}/file-resources/content?${params.toString()}`;
}

export const fileResourcesApi = {
  list(
    issueId: string,
    query: FileResourceListQuery = {},
    options?: RequestOptions,
  ): Promise<WorkspaceFileListResponse> {
    const search = buildQuery(query);
    const suffix = search ? `?${search}` : "";
    return api.get<WorkspaceFileListResponse>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/list${suffix}`,
      options,
    );
  },

  resolve(issueId: string, query: FileResourceQuery): Promise<ResolvedWorkspaceResource> {
    return api.get<ResolvedWorkspaceResource>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/resolve?${buildQuery(query)}`,
    );
  },

  content(issueId: string, query: FileResourceQuery): Promise<WorkspaceFileContent> {
    return api.get<WorkspaceFileContent>(
      `/issues/${encodeURIComponent(issueId)}/file-resources/content?${buildQuery(query)}`,
    );
  },

  downloadUrl: buildFileResourceDownloadUrl,
};
