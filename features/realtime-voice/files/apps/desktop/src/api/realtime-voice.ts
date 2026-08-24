// Realtime voice API helpers — the desktop side of the feature's backend
// endpoints (hermes_cli/realtime_voice.py). Lives under src/api/ per the
// upstream barrel split: implementations in focused files, call sites import
// from '@/hermes'. No secrets ever transit these calls: the standing OpenAI
// key stays server-side; only short-lived ephemeral tokens reach the renderer.
import type {
  RealtimeProjectReviewResponse,
  RealtimeTokenResponse,
  RealtimeVoiceConfigResponse
} from '@/types/hermes'

import { hermesApi, profileScoped } from './client'

/**
 * Mint a short-lived OpenAI Realtime ephemeral client secret for the desktop's
 * production speech-to-speech transport. The standing key stays server-side;
 * this returns only the ephemeral token + non-secret session metadata the
 * WebRTC layer needs. Profile-scoped like the other audio endpoints.
 */
export function mintRealtimeToken(overrides?: {
  model?: string
  voice?: string
}): Promise<RealtimeTokenResponse> {
  return hermesApi<RealtimeTokenResponse>({
    ...profileScoped(),
    path: '/api/audio/realtime/token',
    method: 'POST',
    body: { model: overrides?.model, voice: overrides?.voice },
    // The mint blocks on an outbound OpenAI round-trip (server bounds it at
    // 15s); allow headroom over the default 15s Electron backend timeout.
    timeoutMs: 20_000
  })
}

/**
 * Resolve the configurable voice identity from config.yaml (`voice.realtime.*`).
 * No secrets — assistant name, user name, wake phrase, voice, delivery,
 * greetings, auto-start, and whether the optional review tool is configured.
 */
export function getRealtimeVoiceConfig(): Promise<RealtimeVoiceConfigResponse> {
  return hermesApi<RealtimeVoiceConfigResponse>({
    ...profileScoped(),
    path: '/api/audio/realtime/config',
    method: 'POST',
    body: {},
    timeoutMs: 5_000
  })
}

/**
 * Compact fast-path review of the operator's configured local project index
 * (`voice.realtime.review_projects.index_path`). Returns 404 when no index is
 * configured, in which case the renderer omits the `review_projects` tool.
 */
export function getRealtimeProjectReview(options: {
  detail?: boolean
  query?: string
  status?: string
  limit?: number
} = {}): Promise<RealtimeProjectReviewResponse> {
  return hermesApi<RealtimeProjectReviewResponse>({
    ...profileScoped(),
    path: '/api/audio/realtime/project-review',
    method: 'POST',
    body: options,
    timeoutMs: 5_000
  })
}

/** Voice-intake project creation: writes the durable local-additions overlay
 *  beside the synced index (the sync overwrites the index wholesale) and is
 *  merged into every read. */
export function createRealtimeProject(options: {
  name: string
  goal?: string
  tasks?: string[]
}): Promise<{ ok: boolean; project: Record<string, unknown> }> {
  return hermesApi<{ ok: boolean; project: Record<string, unknown> }>({
    ...profileScoped(),
    path: '/api/audio/realtime/project-create',
    method: 'POST',
    body: { goal: options.goal ?? '', name: options.name, tasks: options.tasks ?? [] },
    timeoutMs: 8_000
  })
}

/** Voice `open_app` instant action: launch a desktop application by name via
 *  the backend's argv-only exec path (`open -a` on macOS). Failure comes back
 *  as `{ok: false, error}` for the voice layer to relay conversationally. */
export function openRealtimeSystemApp(name: string): Promise<{ ok: boolean; error?: string }> {
  return hermesApi<{ ok: boolean; error?: string }>({
    ...profileScoped(),
    path: '/api/audio/realtime/system-open',
    method: 'POST',
    body: { name },
    timeoutMs: 20_000
  })
}
