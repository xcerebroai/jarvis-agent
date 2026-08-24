// The desktop-level voice supervisor.
//
// ONE renderer-process singleton owns the persistent OpenAI Realtime
// speech-to-speech session, the microphone, the tool bridge into the full
// agent, the 50-minute transport renewal, and the wake-word hand-off. It is
// deliberately NOT owned by any composer/ChatBar/session route: a component
// unmount (tab switch, route change, settings, window minimize) must never end
// the voice session. React hooks only VIEW this state (via `$voiceState`) and
// DRIVE it (start/end/stopTurn/toggleMute) — they do not hold the session.
//
// The session closes on exactly four events: explicit end, renderer shutdown,
// an unrecoverable mid-session connection failure, or the normal 50-minute
// reconnect (which renews the transport in place and never ends it).
//
// Routing: the FOREGROUND composer registers a delegate (see agent-delegate);
// a `use_jarvis` call captures the delegate that started it, so the turn stays
// pinned to its original session even if the user switches tabs while it runs.
//
// Identity (assistant name, user name, wake phrase, voice, delivery, greetings,
// and whether the optional review tool is configured) is resolved server-side
// from config.yaml (`voice.realtime.*`) and fetched once per session start; the
// public defaults are JARVIS / no user name / "hey jarvis" / Marin / concise.

import { atom } from 'nanostores'

import { getRealtimeProjectReview, getRealtimeVoiceConfig, mintRealtimeToken } from '@/hermes'
import { translateNow } from '@/i18n'
import { $gateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { resumeWakeAfterVoice } from '@/store/wake-word'

import type { AgentDelegate } from './agent-delegate'
import { type RealtimeSessionConfigOptions, REVIEW_PROJECTS_TOOL_NAME } from './realtime-config'
import { emitAmplitude } from '@/lib/voice/amplitude-events'
import { RealtimeSessionError, type RealtimeStatus, RealtimeVoiceSession } from './realtime-session'

/** The on-screen conversation status the composer controls render. The Realtime
 *  transport only ever surfaces these four; the chained fallback additionally
 *  uses 'transcribing', which the composer sources from its own hook. */
export type VoiceStatus = 'idle' | 'listening' | 'thinking' | 'speaking'

/** OpenAI Realtime sessions cap at 60 minutes; renew a little early so the
 *  conversation never hard-drops mid-sentence. */
const REALTIME_SESSION_MAX_MS = 50 * 60 * 1000

/** Model-facing tool output when a `use_jarvis` request arrives but no chat
 *  surface is mounted to route it to (settings open, no session). The assistant
 *  rephrases this in its own voice; it is never shown verbatim. */
const NO_ROUTABLE_SESSION_OUTPUT =
  'There is no open session to route that to right now. Ask the user to open or start a session, then try again.'

/** The single global voice state every composer control reads. `active` is the
 *  user's INTENT (voice is on), independent of the transport health; `fallback`
 *  flips when initial Realtime setup failed and the composer-bound chained path
 *  should drive instead. */
export interface VoiceState {
  active: boolean
  fallback: boolean
  status: VoiceStatus
  muted: boolean
  level: number
}

const IDLE_STATE: VoiceState = {
  active: false,
  fallback: false,
  status: 'idle',
  muted: false,
  level: 0
}

export const $voiceState = atom<VoiceState>(IDLE_STATE)

/** Map the transport's status to the on-screen conversation status. */
function toConversationStatus(status: RealtimeStatus): VoiceStatus {
  return status === 'connecting' ? 'thinking' : status
}

function patchState(patch: Partial<VoiceState>): void {
  $voiceState.set({ ...$voiceState.get(), ...patch })
}

// ── Supervisor state (renderer-process scoped, survives every remount) ───────

let config: RealtimeSessionConfigOptions = {}
let realtimeEnabled = true
let activeSession: RealtimeVoiceSession | null = null
let intentActive = false
let renewalTimer: number | null = null
let lifecycleInstalled = false
let autoStartAttempted = false

// The launch greeting is spoken exactly once per renderer launch — on the very
// first connect. Every later connect (a 50-minute renewal, a far-side-drop
// recovery, or a manual restart in the same launch) suppresses it, so a tab
// switch or reconnect never replays it.
let greetedThisLaunch = false

// Wake word: paused ONCE when the live mic opens, resumed ONCE when the session
// explicitly ends or fails. Session switches / reconnects never touch it — the
// guard makes pause idempotent, so a renewal keeps the ear paused throughout.
let wakePaused = false

let activeDelegate: AgentDelegate | null = null

// Serialize tool bridges: the agent is one session, so overlapping requests must
// not interleave. Each waits for the previous to finish.
let bridgeChain: Promise<void> = Promise.resolve()
// In-flight turn cancels, so end()/close() can settle them with a fallback.
const pendingTurnCancels = new Set<() => void>()

function realtimeToolNoResult(): string {
  return translateNow('notifications.voice.realtimeToolNoResult')
}

function syncThrottleSignal(): void {
  // Keep chat windows unthrottled (WebRTC/audio/timers at full cadence) while
  // the voice session is live, even minimized — see electron/stream-throttle.ts.
  window.hermesDesktop?.setVoiceActive?.(intentActive)
}

function clearRenewalTimer(): void {
  if (renewalTimer !== null) {
    window.clearTimeout(renewalTimer)
    renewalTimer = null
  }
}

function scheduleRenewal(session: RealtimeVoiceSession): void {
  clearRenewalTimer()
  renewalTimer = window.setTimeout(() => {
    if (intentActive && activeSession === session) {
      void connect(true)
    }
  }, REALTIME_SESSION_MAX_MS)
}

function cancelPendingTurns(): void {
  for (const cancel of pendingTurnCancels) {
    cancel()
  }

  pendingTurnCancels.clear()
}

/** Resolve the configurable voice identity from the backend (config.yaml). Best
 *  effort: any failure falls back to the public JARVIS defaults with Realtime
 *  enabled, so a config-read hiccup never dead-ends voice. */
async function loadSessionConfig(): Promise<void> {
  try {
    const resolved = await getRealtimeVoiceConfig()
    realtimeEnabled = resolved.enabled !== false
    config = {
      assistantName: resolved.assistant_name,
      userName: resolved.user_name,
      wakePhrase: resolved.wake_phrase,
      delivery: resolved.delivery,
      greetings: Array.isArray(resolved.greetings) ? resolved.greetings : [],
      reviewProjectsEnabled: Boolean(resolved.review_projects_enabled),
      model: resolved.model,
      voice: resolved.voice
    }
  } catch {
    // Defaults: JARVIS, no user name, "hey jarvis", Marin, review off.
    realtimeEnabled = true
    config = {}
  }
}

/** Pause the wake-word listener once and wait for it to release the capture
 *  device before we open our own mic (they must never contend). Idempotent
 *  across reconnects so a renewal never re-toggles the ear. */
async function pauseWakeForVoiceSession(): Promise<void> {
  if (wakePaused) {
    return
  }

  wakePaused = true

  try {
    await $gateway.get()?.request('wake.pause', {})
  } catch {
    // No wake listener / older backend — nothing held the mic.
  }
}

/** Reconcile the wake listener back to config once the voice session truly stops. */
function resumeWakeForVoiceSession(): void {
  if (!wakePaused) {
    return
  }

  wakePaused = false
  void resumeWakeAfterVoice()
}

// ── Tool bridge ──────────────────────────────────────────────────────────────

function runProjectReview(session: RealtimeVoiceSession, callId: string, args: Record<string, unknown>): void {
  const query = typeof args.query === 'string' ? args.query.trim() : undefined
  const statusFilter = typeof args.status === 'string' ? args.status.trim() : undefined
  const requestedLimit = typeof args.limit === 'number' ? args.limit : Number(args.limit)
  const limit = Number.isFinite(requestedLimit) ? Math.max(1, Math.min(requestedLimit, 8)) : 5

  void getRealtimeProjectReview({ query, status: statusFilter, limit })
    .then(result => session.sendToolOutput(callId, JSON.stringify(result)))
    .catch(error => {
      notifyError(error, realtimeToolNoResult())
      session.sendToolOutput(callId, realtimeToolNoResult())
    })
}

function runUseJarvis(session: RealtimeVoiceSession, callId: string, request: string): void {
  bridgeChain = bridgeChain.then(async () => {
    // The session may have been replaced (renewal) or closed while this bridge
    // waited its turn in the chain — drop it silently in that case.
    if (activeSession !== session) {
      return
    }

    const trimmed = request.trim()

    if (!trimmed) {
      session.sendToolOutput(callId, '')

      return
    }

    // Capture the delegate that owns the CURRENT foreground session. It pins the
    // turn to that session, so a later tab switch cannot re-home the result.
    const delegate = activeDelegate
    const turn = delegate?.runTurn(trimmed)

    if (!turn) {
      session.sendToolOutput(callId, NO_ROUTABLE_SESSION_OUTPUT)

      return
    }

    pendingTurnCancels.add(turn.cancel)

    try {
      const result = await turn.result
      session.sendToolOutput(callId, result || realtimeToolNoResult())
    } catch (error) {
      notifyError(error, translateNow('notifications.voice.couldNotStartSession'))
      session.sendToolOutput(callId, realtimeToolNoResult())
    } finally {
      pendingTurnCancels.delete(turn.cancel)
    }
  })
}

// ── Connection lifecycle ─────────────────────────────────────────────────────

async function connect(renewal: boolean): Promise<void> {
  // Replace any prior session (renewal) atomically.
  activeSession?.close()

  // Resolve identity once per session start (not on in-place renewals, which
  // keep the same identity). A disabled Realtime config hands straight to the
  // composer-bound chained fallback.
  if (!renewal) {
    await loadSessionConfig()

    if (!intentActive) {
      return
    }

    if (!realtimeEnabled) {
      enterFallback()

      return
    }
  }

  // Release the wake mic before getUserMedia. Idempotent — a renewal keeps the
  // ear paused rather than re-toggling it.
  await pauseWakeForVoiceSession()

  if (!intentActive) {
    return
  }

  // The launch greeting plays on the first connect of the renderer launch only.
  const suppressGreeting = greetedThisLaunch || renewal
  greetedThisLaunch = true

  const session = new RealtimeVoiceSession({
    mintToken: overrides => mintRealtimeToken(overrides),
    requestMicAccess: () => window.hermesDesktop?.requestMicrophoneAccess?.() ?? Promise.resolve(true),
    config,
    suppressGreeting,
    callbacks: {
      onStatusChange: next => patchState({ status: toConversationStatus(next) }),
      onLevel: level => {
        patchState({ level })
        emitAmplitude('out', level)
      },
      onToolCall: call => {
        if (call.name === REVIEW_PROJECTS_TOOL_NAME) {
          runProjectReview(session, call.callId, call.arguments)
        } else {
          runUseJarvis(session, call.callId, String(call.arguments.request ?? ''))
        }
      },
      onClose: ({ expired }) => {
        // A far-side drop (network / session-max) while still wanted → renew
        // gracefully. An error drop is an unrecoverable failure → end.
        if (!intentActive || activeSession !== session) {
          return
        }

        if (expired) {
          void connect(true)
        } else {
          notify({
            kind: 'error',
            icon: 'mic',
            title: translateNow('notifications.voice.realtimeUnavailable'),
            message: translateNow('notifications.voice.realtimeUnavailable')
          })
          teardown('idle')
        }
      }
    }
  })

  activeSession = session

  try {
    await session.connect()

    if (activeSession !== session || !intentActive) {
      session.close()

      return
    }

    scheduleRenewal(session)
  } catch (error) {
    if (activeSession === session) {
      activeSession = null
    }

    const message = error instanceof RealtimeSessionError ? error.message : String(error)
    notify({
      kind: 'error',
      icon: 'mic',
      title: translateNow('notifications.voice.realtimeUnavailable'),
      message,
      detail: translateNow('notifications.voice.realtimeFellBack')
    })

    // INITIAL setup failure only: hand off to the composer-bound chained voice
    // path so voice is never left dead. Intent stays "active" — the chained
    // transport takes over the on-screen controls.
    enterFallback()
  }
}

/** Close the session, release the mic + wake lease, clear the on intent, and
 *  settle the voice state. The single teardown path for every close reason
 *  (explicit end, renderer shutdown, unrecoverable mid-session failure). */
function teardown(status: VoiceStatus): void {
  clearRenewalTimer()
  cancelPendingTurns()
  activeSession?.close()
  activeSession = null
  intentActive = false
  resumeWakeForVoiceSession()
  syncThrottleSignal()
  patchState({ active: false, fallback: false, status, muted: false, level: 0 })
}

/** Initial-setup-failure hand-off: keep voice on but mark the transport as
 *  fallen back so the composer's chained path drives. */
function enterFallback(): void {
  clearRenewalTimer()
  cancelPendingTurns()
  activeSession?.close()
  activeSession = null
  // The chained fallback opens its own mic and manages wake itself, so release
  // the wake pause the Realtime attempt took.
  resumeWakeForVoiceSession()
  patchState({ active: intentActive, fallback: true, status: 'idle', muted: false, level: 0 })
}

// ── Public API (driven by React hooks; safe to call from anywhere) ───────────

function installLifecycle(): void {
  if (lifecycleInstalled || typeof window === 'undefined') {
    return
  }

  lifecycleInstalled = true
  window.addEventListener('pagehide', handleRendererShutdown)
  window.addEventListener('beforeunload', handleRendererShutdown)
}

function handleRendererShutdown(): void {
  if (!intentActive && !activeSession) {
    return
  }

  teardown('idle')
}

/** Start the voice session (idempotent). Multiple mounted composers all funnel
 *  here, so two composers — or a remount — never create a second session/mic. */
function start(): void {
  installLifecycle()

  if (intentActive) {
    return
  }

  intentActive = true
  patchState({ active: true, fallback: false, status: 'idle', muted: false, level: 0 })
  syncThrottleSignal()
  void connect(false)
}

/** Launch auto-start: start the session once per renderer launch, but only when
 *  `voice.realtime.auto_start` is configured. Default config leaves it off, so
 *  the public default preserves the current no-auto-start launch behavior. */
async function maybeAutoStart(): Promise<void> {
  if (autoStartAttempted) {
    return
  }

  autoStartAttempted = true

  try {
    const resolved = await getRealtimeVoiceConfig()

    if (resolved.auto_start && resolved.enabled !== false && !intentActive) {
      start()
    }
  } catch {
    // No config / backend not ready — never auto-start on error.
  }
}

/** Explicit end. Closes everything exactly once and re-arms wake. */
function end(): void {
  teardown('idle')
}

function stopTurn(): void {
  activeSession?.cancelResponse()
}

function toggleMute(): void {
  const next = !$voiceState.get().muted
  activeSession?.setMuted(next)
  patchState({ muted: next })
}

/** Register the FOREGROUND session's routing delegate. Returns an unregister
 *  disposer; unregistering only clears the registry if this delegate is still
 *  the active one (a later foreground never clobbers an earlier unmount). */
function registerDelegate(delegate: AgentDelegate): () => void {
  activeDelegate = delegate

  return () => {
    if (activeDelegate === delegate) {
      activeDelegate = null
    }
  }
}

export const voiceSupervisor = {
  start,
  maybeAutoStart,
  end,
  stopTurn,
  toggleMute,
  registerDelegate,
  isActive: () => intentActive,
  /** @internal test seam — reset all module state between tests. */
  __resetForTests(): void {
    clearRenewalTimer()
    pendingTurnCancels.clear()
    activeSession?.close()
    activeSession = null
    intentActive = false
    greetedThisLaunch = false
    wakePaused = false
    autoStartAttempted = false
    realtimeEnabled = true
    activeDelegate = null
    bridgeChain = Promise.resolve()
    config = {}
    $voiceState.set(IDLE_STATE)
  },
  /** @internal test seam — drive the renderer-shutdown path directly. */
  __handleShutdownForTests: handleRendererShutdown
}
