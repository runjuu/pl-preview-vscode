/** Session-scoped Preview Workspace URL parsing and control-route construction. */

export interface PreviewWorkspaceRoute {
  readonly origin: string;
  readonly previewSessionId: string;
  readonly workspaceId: string;
}

export type PreviewWorkspaceControl = 'status' | 'reboot' | 'reset';

/**
 * Accept only a loopback `experimental-1` workspace page below a canonical Local
 * Preview Session. Removed `/workspace/*` routes deliberately return `null`.
 */
export function parsePreviewWorkspaceUrl(rawUrl: string): PreviewWorkspaceRoute | null {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) {
    return null;
  }
  const match = url.pathname.match(
    /^\/preview-sessions\/(pvs_[A-Za-z0-9_-]{22})\/workspace\/([^/?#]+)\/?$/,
  );
  if (!match) return null;
  return {
    origin: url.origin,
    previewSessionId: match[1],
    workspaceId: match[2],
  };
}

/** Build a status/reboot/reset URL without dropping the owning session capability. */
export function buildPreviewWorkspaceControlUrl(
  route: PreviewWorkspaceRoute,
  control: PreviewWorkspaceControl,
): string {
  return `${route.origin}/preview-sessions/${route.previewSessionId}/workspace/${route.workspaceId}/${control}`;
}
