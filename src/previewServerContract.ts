/**
 * HTTP client for the Standalone Preview Server's `experimental-1` control
 * plane. The browser never receives the optional bearer token: this module is
 * used only by the extension host while starting a Local Preview Container.
 */

export interface LocalPreviewSessionDescriptor {
  readonly previewSessionId: string;
  readonly courseDir: string;
}

export interface DiscoverLocalPreviewSessionOptions {
  readonly origin: string;
  /** Absolute course path as seen by the server (the extension mounts `/course`). */
  readonly courseDir: string;
  /** Optional control-plane credential; deliberately omitted from `GET /health`. */
  readonly authToken?: string;
  /** Whether the launched container is expected to advertise Preview Workspaces. */
  readonly requireWorkspaces: boolean;
}

export interface DeleteLocalPreviewSessionOptions {
  readonly origin: string;
  readonly previewSessionId: string;
  readonly authToken?: string;
}

/**
 * Verify health and metadata, then deliberately reuse a matching canonical
 * course session or create one. No session is selected before capabilities have
 * been checked, so an old proof-of-concept image fails loudly at startup.
 */
export async function discoverLocalPreviewSession({
  origin,
  courseDir,
  authToken,
  requireWorkspaces,
}: DiscoverLocalPreviewSessionOptions): Promise<LocalPreviewSessionDescriptor> {
  const health = await requestJson(origin, '/health');
  if (!isRecord(health) || health.status !== 'ok') {
    throw new Error('Local Preview Server returned an invalid health response');
  }

  const headers = controlPlaneHeaders(authToken);
  const metadata = await requestJson(origin, '/metadata', { headers });
  assertCompatibleMetadata(metadata, requireWorkspaces);

  const listed = await requestJson(origin, '/preview-sessions', { headers });
  if (!isRecord(listed) || !Array.isArray(listed.previewSessions)) {
    throw new Error('Local Preview Server returned an invalid session list');
  }
  const reusable = listed.previewSessions.find(
    (candidate): candidate is LocalPreviewSessionDescriptor =>
      isSessionDescriptor(candidate) && candidate.courseDir === courseDir,
  );
  if (reusable) return reusable;

  const created = await requestJson(origin, '/preview-sessions', {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ courseDir }),
  });
  if (!isSessionDescriptor(created)) {
    throw new Error('Local Preview Server returned an invalid created session');
  }
  return created;
}

/**
 * Delete a Local Preview Session and wait for the server's `204`, whose contract
 * guarantees that accepted requests drained and session-owned resources closed.
 */
export async function deleteLocalPreviewSession({
  origin,
  previewSessionId,
  authToken,
}: DeleteLocalPreviewSessionOptions): Promise<void> {
  if (!/^pvs_[A-Za-z0-9_-]{22}$/.test(previewSessionId)) {
    throw new Error('Refusing to delete an invalid Local Preview Session ID');
  }
  await requestJson(origin, `/preview-sessions/${previewSessionId}`, {
    method: 'DELETE',
    headers: controlPlaneHeaders(authToken),
  });
}

function assertCompatibleMetadata(value: unknown, requireWorkspaces: boolean): void {
  if (!isRecord(value) || value.apiVersion !== 'experimental-1') {
    throw new Error('Local Preview Server does not implement experimental-1');
  }
  if (value.previewSessionsEndpoint !== '/preview-sessions') {
    throw new Error('Local Preview Server did not advertise the session endpoint');
  }
  const features = value.features;
  if (
    !isRecord(features) ||
    features.defaultRenderMode !== 'full' ||
    features.grading !== true ||
    !Array.isArray(features.renderModes) ||
    !features.renderModes.includes('full')
  ) {
    throw new Error('Local Preview Server did not enable full rendering and Preview Answer Check');
  }
  if (features.workspaces !== requireWorkspaces) {
    throw new Error(
      requireWorkspaces
        ? 'Local Preview Server did not enable Preview Workspaces'
        : 'Local Preview Server unexpectedly enabled Preview Workspaces',
    );
  }
  if (
    requireWorkspaces &&
    (!Array.isArray(features.workspaceControls) ||
      !features.workspaceControls.includes('reboot') ||
      !features.workspaceControls.includes('reset'))
  ) {
    throw new Error('Local Preview Server did not advertise the required workspace controls');
  }
}

async function requestJson(
  origin: string,
  pathname: string,
  init: RequestInit = {},
): Promise<unknown> {
  const response = await fetch(`${origin}${pathname}`, init);
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const code =
      isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string'
        ? ` (${body.error.code})`
        : '';
    throw new Error(
      `Local Preview Server ${init.method ?? 'GET'} ${pathname} failed: ${response.status}${code}`,
    );
  }
  return body;
}

function controlPlaneHeaders(authToken: string | undefined): Record<string, string> {
  return authToken ? { authorization: `Bearer ${authToken}` } : {};
}

function isSessionDescriptor(value: unknown): value is LocalPreviewSessionDescriptor {
  return (
    isRecord(value) &&
    typeof value.previewSessionId === 'string' &&
    /^pvs_[A-Za-z0-9_-]{22}$/.test(value.previewSessionId) &&
    typeof value.courseDir === 'string'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
