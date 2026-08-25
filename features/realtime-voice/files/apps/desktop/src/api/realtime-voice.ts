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
  /** P5.1: link the board entry to a persistent build session. */
  build_id?: string
  source?: string
  status?: string
}): Promise<{ ok: boolean; project: Record<string, unknown> }> {
  return hermesApi<{ ok: boolean; project: Record<string, unknown> }>({
    ...profileScoped(),
    path: '/api/audio/realtime/project-create',
    method: 'POST',
    body: {
      goal: options.goal ?? '',
      name: options.name,
      tasks: options.tasks ?? [],
      ...(options.build_id ? { build_id: options.build_id } : {}),
      ...(options.source ? { source: options.source } : {}),
      ...(options.status ? { status: options.status } : {})
    },
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

// ── P5.1 ─────────────────────────────────────────────────────────────────────

/** The enriched schema every board row carries (P5.1). Voice-editable fields
 *  are persisted beside the synced index and merged on read. */
export interface RealtimeEnrichedProject {
  name: string
  status: string
  priority: string
  deadline: string
  days_to_deadline: null | number
  staleness_days: null | number
  revenue_relevance: string
  revenue_outstanding: number
  tasks: string
  blocker: string
  next_action: string
  client: string
}

export interface RealtimeProjectContextResponse {
  ok: boolean
  updated: string
  today: string
  total_projects: number
  truncated: number
  projects: RealtimeEnrichedProject[]
  /** One compact line per project — the judgment bridge's context block. */
  text: string
}

/** The whole enriched board, compact, for the judgment bridge to the full agent. */
export function getRealtimeProjectContext(): Promise<RealtimeProjectContextResponse> {
  return hermesApi<RealtimeProjectContextResponse>({
    ...profileScoped(),
    path: '/api/audio/realtime/project-context',
    method: 'POST',
    body: {},
    timeoutMs: 8_000
  })
}

/** Voice edit of one project's enriched fields ("mark X high priority"). The
 *  backend resolves the spoken reference; an ambiguous one comes back as a
 *  400 the voice layer turns into a question, never a guess. */
export function setRealtimeProjectFields(options: {
  name: string
  fields: Record<string, string>
}): Promise<{ ok: boolean; key?: string; name?: string; fields?: Record<string, string>; error?: string }> {
  return hermesApi<{ ok: boolean; key?: string; name?: string; fields?: Record<string, string>; error?: string }>({
    ...profileScoped(),
    path: '/api/audio/realtime/project-set',
    method: 'POST',
    body: options,
    timeoutMs: 8_000
  })
}

/** One look at the screen: capture → vision model → answer, with the look's
 *  real latency, token usage and a list-price cost estimate. `permission`
 *  is set when macOS Screen Recording is not granted (the grant was requested
 *  and the Settings pane opened). */
export interface RealtimeLookResponse {
  ok: boolean
  answer?: string
  error?: null | string
  permission?: 'requested'
  question?: string
  model?: string
  usage?: null | { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
  cost_usd?: null | number
  cost_basis?: string
  latency_ms?: number
  capture_ms?: number
  analyze_ms?: number
  width?: number
  height?: number
  bytes?: number
  image_path?: string
  thumbnail?: string
  at?: string
}

export function lookAtScreen(options: { question?: string } = {}): Promise<RealtimeLookResponse> {
  return hermesApi<RealtimeLookResponse>({
    ...profileScoped(),
    path: '/api/audio/realtime/look',
    method: 'POST',
    body: { question: options.question ?? '' },
    // capture (~0.2s) + one vision round-trip; the server bounds the model
    // call at 60s.
    timeoutMs: 75_000
  })
}

/** Cockpit thumbnail of an agent-produced screenshot (confined to the Hermes
 *  home). Used to show the research plate what the browser actually saw. */
export function getRealtimeThumbnail(path: string): Promise<{ ok: boolean; thumbnail?: string; path?: string }> {
  return hermesApi<{ ok: boolean; thumbnail?: string; path?: string }>({
    ...profileScoped(),
    path: '/api/audio/realtime/thumbnail',
    method: 'POST',
    body: { path },
    timeoutMs: 8_000
  })
}

/** A persistent build session's durable record (survives app restarts). */
export interface RealtimeBuildRecord {
  id: string
  name: string
  goal: string
  state: 'done' | 'failed' | 'idle' | 'planning' | 'waiting' | 'working'
  session_id?: null | string
  stored_session_id?: null | string
  project_id?: null | string
  last_summary?: string
  created_at?: string
  updated_at?: string
}

export function listRealtimeBuilds(): Promise<{ ok: boolean; builds: RealtimeBuildRecord[] }> {
  return hermesApi<{ ok: boolean; builds: RealtimeBuildRecord[] }>({
    ...profileScoped(),
    path: '/api/audio/realtime/builds',
    method: 'POST',
    body: { action: 'list' },
    timeoutMs: 8_000
  })
}

export function upsertRealtimeBuild(build: Partial<RealtimeBuildRecord> & { id: string; name: string; goal: string }): Promise<{ ok: boolean; build: RealtimeBuildRecord }> {
  return hermesApi<{ ok: boolean; build: RealtimeBuildRecord }>({
    ...profileScoped(),
    path: '/api/audio/realtime/builds',
    method: 'POST',
    body: { action: 'upsert', build },
    timeoutMs: 8_000
  })
}

export function updateRealtimeBuild(id: string, patch: Partial<RealtimeBuildRecord>): Promise<{ ok: boolean; build: null | RealtimeBuildRecord }> {
  return hermesApi<{ ok: boolean; build: null | RealtimeBuildRecord }>({
    ...profileScoped(),
    path: '/api/audio/realtime/builds',
    method: 'POST',
    body: { action: 'update', id, patch },
    timeoutMs: 8_000
  })
}
