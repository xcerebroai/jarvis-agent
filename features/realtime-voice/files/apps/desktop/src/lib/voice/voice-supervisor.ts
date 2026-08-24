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

import { emitAmplitude } from '@/lib/voice/amplitude-events'
import { emitGatewayEvent, onGatewayEvent } from '@/contrib/events'
import { $voiceConversationStartRequest, takeVoiceConversationStart } from '@/store/composer'
import { atom } from 'nanostores'

import { createRealtimeProject, getRealtimeProjectReview, getRealtimeVoiceConfig, mintRealtimeToken, openRealtimeSystemApp } from '@/hermes'
import { translateNow } from '@/i18n'
import { $gateway } from '@/store/gateway'
import { notify, notifyError } from '@/store/notifications'
import { $sidebarOpen, setSidebarOpen } from '@/store/layout'
import { isVoiceStopCommand } from '@/lib/voice-stop-word'
import { armWakeWord, resumeWakeAfterVoice } from '@/store/wake-word'

import type { AgentDelegate, AgentTurn } from './agent-delegate'
import {
  CANCEL_TASK_TOOL_NAME,
  CLEAR_DISPLAY_TOOL_NAME,
  CREATE_PROJECT_TOOL_NAME,
  DELEGATE_TASK_TOOL_NAME,
  OPEN_APP_TOOL_NAME,
  OPEN_URL_TOOL_NAME,
  SHOW_DETAIL_TOOL_NAME,
  type RealtimeSessionConfigOptions,
  REVIEW_PROJECTS_TOOL_NAME,
  SHOW_PROJECT_TOOL_NAME,
  SHOW_PROJECTS_TOOL_NAME
} from './realtime-config'
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

// Wake word: paused ONCE when the live mic opens, resumed ONCE when the session
// explicitly ends or fails. Session switches / reconnects never touch it — the
// guard makes pause idempotent, so a renewal keeps the ear paused throughout.
let wakePaused = false

let activeDelegate: AgentDelegate | null = null
let contextUnsubscribe: (() => void) | null = null

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
    try {
      // One retry: a transient failure here silently costs the operator
      // their identity, greetings, AND the project-review tool for the
      // whole session — too much to lose to one dropped request.
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

/** P4 display verbs: fetch the same compact index reads, emit display.*
 *  events for the HUD panels + orb action grammar, confirm compactly so the
 *  voice narrates what it is showing. */
// Conversational display context: what is on the stage right now. Natural
// speech references ("it", "that one", a bare "expand") resolve against this
// before anything is asked aloud — an error toast is never the answer.
const displayContext: { focused: null | string; lastRows: Array<{ name: string; status: string }> } = {
  focused: null,
  lastRows: []
}

function resolveProjectReference(raw: string | undefined): { ask?: string; name?: string } {
  const explicit = (raw ?? '').trim()
  const pronoun = /^(it|that|that one|this|this one|the project)$/i.test(explicit)

  if (explicit && !pronoun) {
    return { name: explicit }
  }

  if (displayContext.focused) {
    return { name: displayContext.focused }
  }

  const blocked = displayContext.lastRows.filter(row => row.status.toLowerCase() === 'blocked')

  if (blocked.length === 1) {
    return { name: blocked[0].name }
  }

  if (displayContext.lastRows.length === 1) {
    return { name: displayContext.lastRows[0].name }
  }

  return {
    ask: displayContext.lastRows.length
      ? 'Ambiguous reference: ask the user aloud which project they mean, then call the tool again with that name.'
      : 'Nothing is on the stage: ask the user aloud which project they mean, then call the tool again with that name.'
  }
}

function runDisplayTool(session: RealtimeVoiceSession, name: string, callId: string, args: Record<string, unknown>): void {
  if (name === CLEAR_DISPLAY_TOOL_NAME) {
    displayContext.focused = null
    emitGatewayEvent({ payload: {}, type: 'display.clear' })
    session.sendToolOutput(callId, 'Display cleared.')

    return
  }

  if (name === CREATE_PROJECT_TOOL_NAME) {
    const projectName = typeof args.name === 'string' ? args.name.trim() : ''
    const goal = typeof args.goal === 'string' ? args.goal : ''
    const tasks = Array.isArray(args.tasks) ? args.tasks.map(String) : []

    if (!projectName) {
      // Conversational self-correction, not an error toast: the model asked
      // to create without a confirmed name — send it back to the intake.
      session.sendToolOutput(callId, 'No project was created: the name is missing. Ask the user for the project name, confirm it aloud, then call create_project again.')

      return
    }

    emitGatewayEvent({ payload: { focus: false }, type: 'display.retrieving' })
    void createRealtimeProject({ goal, name: projectName, tasks })
      .then(created =>
        getRealtimeProjectReview({ limit: 8 }).then(result => {
          emitGatewayEvent({ payload: { created: created.project, focus: false, result }, type: 'display.projects' })
          session.sendToolOutput(callId, `Created project "${projectName}" (${tasks.length} tasks). It is now on the board; confirm aloud.`)
        })
      )
      .catch(error => {
        notifyError(error, realtimeToolNoResult())
        session.sendToolOutput(callId, realtimeToolNoResult())
      })

    return
  }

  const rawRef = typeof args.query === 'string' ? args.query.trim() : typeof args.name === 'string' ? args.name.trim() : undefined
  const statusFilter = typeof args.status === 'string' ? args.status.trim() : undefined
  const detail = name === SHOW_DETAIL_TOOL_NAME
  const focus = name === SHOW_PROJECT_TOOL_NAME || detail

  let query = rawRef

  if (focus) {
    const resolved = resolveProjectReference(rawRef)

    if (resolved.ask) {
      session.sendToolOutput(callId, resolved.ask)

      return
    }

    query = resolved.name
  }

  emitGatewayEvent({ payload: { focus }, type: 'display.retrieving' })
  void getRealtimeProjectReview({ detail, limit: focus ? 1 : 8, query, status: statusFilter })
    .then(result => {
      const rows = Array.isArray(result.projects) ? result.projects : []

      if (focus && rows[0]?.name) {
        displayContext.focused = String(rows[0].name)
      } else if (!focus) {
        displayContext.focused = null
        displayContext.lastRows = rows.map(row => ({ name: String(row.name ?? ''), status: String(row.status ?? '') }))
      }

      emitGatewayEvent({
        payload: { focus, query: query ?? null, result, status: statusFilter ?? null },
        type: detail ? 'display.detail' : focus ? 'display.focus' : 'display.projects'
      })
      const counts = Object.entries(result.status_counts ?? {})
        .map(([status, count]) => `${count} ${status}`)
        .join(', ')

      session.sendToolOutput(
        callId,
        focus
          ? `Focused on screen: ${result.projects?.[0]?.name ?? query ?? 'project'}. ${JSON.stringify(result.projects?.[0] ?? {})}`
          : `Displayed ${result.matches ?? 0} of ${result.total_projects ?? 0} projects (${counts}). Panels are on screen; summarize aloud briefly.`
      )
    })
    .catch(error => {
      emitGatewayEvent({ payload: {}, type: 'display.clear' })
      notifyError(error, realtimeToolNoResult())
      session.sendToolOutput(callId, realtimeToolNoResult())
    })
}

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

// ── P5 reach: instant actions + the delegated-work bridge ────────────────────

/** The one delegated task allowed at a time. Kept module-scope so it survives
 *  voice session renewals and even a spoken "stop" (which only detaches the
 *  narration — the work keeps running until it finishes or is cancelled). */
let activeTask: {
  id: number
  goal: string
  kind: 'research' | 'task'
  turn: AgentTurn
  sessionProbe: number | null
} | null = null
let taskCounter = 0

function emitTaskEvent(type: string, payload: Record<string, unknown>): void {
  emitGatewayEvent({ payload, type })
}

function clearTaskProbe(task: NonNullable<typeof activeTask>): void {
  if (task.sessionProbe !== null) {
    window.clearInterval(task.sessionProbe)
    task.sessionProbe = null
  }
}

/** How long a delegated job may run before it is handed back as timed out.
 *  Deliberately far beyond the bridged-Q&A default: research and multi-step
 *  work legitimately take minutes. */
const DELEGATED_TASK_TIMEOUT_MS = 10 * 60 * 1000

function buildTaskPrompt(goal: string, kind: 'research' | 'task'): string {
  if (kind === 'research') {
    return [
      `Research task delegated from the voice assistant: ${goal}`,
      '',
      'Use your browser and web tools to actually investigate — prefer opening pages so the work is visible, not just recalling from memory. Work step by step.',
      'End your reply with a compact plain-text briefing of what you found: the 3-5 most important points, spoken-summary style, no markdown headers or tables.'
    ].join('\n')
  }

  return [
    `Task delegated from the voice assistant: ${goal}`,
    '',
    'When finished, end your reply with a 1-3 sentence plain-text summary of the outcome — it will be read aloud.'
  ].join('\n')
}

/** Speak a completed/cancelled task's outcome through whatever voice session is
 *  live NOW — the one that started the task may have been renewed or ended. */
function narrateTaskOutcome(text: string): void {
  activeSession?.speakSystemUpdate(text)
}

function normalizeUrl(raw: string): null | string {
  const trimmed = raw.trim()

  if (!trimmed || /\s/.test(trimmed)) {
    return null
  }

  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed
  }

  // Bare domain ("example.com", "example.com/path") — everything else refused.
  return /^[\w-]+(\.[\w-]+)+([/?#]\S*)?$/.test(trimmed) ? `https://${trimmed}` : null
}

function startDelegatedTask(session: RealtimeVoiceSession, callId: string, goal: string, kind: 'research' | 'task'): void {
  if (activeTask) {
    session.sendToolOutput(
      callId,
      `A task is already running: "${activeTask.goal}". Only one runs at a time — ask the user whether to cancel it first (cancel_task) or wait.`
    )

    return
  }

  const delegate = activeDelegate
  const turn = delegate?.runTurn(buildTaskPrompt(goal, kind), { timeoutMs: DELEGATED_TASK_TIMEOUT_MS })

  if (!turn) {
    session.sendToolOutput(callId, NO_ROUTABLE_SESSION_OUTPUT)

    return
  }

  const id = ++taskCounter
  const task = { goal, id, kind, sessionProbe: null as number | null, turn }
  activeTask = task
  emitTaskEvent('voice.task.started', { goal, id, kind, sessionId: turn.sessionId() })

  // The pinned session id may only be known after the first message.start (a
  // fresh new-chat draft mints it during submit) — probe briefly so the HUD
  // panel can attach to the right event stream.
  if (!turn.sessionId()) {
    task.sessionProbe = window.setInterval(() => {
      const sid = turn.sessionId()

      if (sid) {
        clearTaskProbe(task)
        emitTaskEvent('voice.task.session', { id, sessionId: sid })
      }
    }, 300)
    window.setTimeout(() => clearTaskProbe(task), 15_000)
  }

  void turn.result.then(text => {
    clearTaskProbe(task)

    if (activeTask?.id !== id) {
      return // cancelled (or superseded) — its outcome was already narrated
    }

    activeTask = null
    const summary = text.trim()
    emitTaskEvent('voice.task.done', { goal, id, kind, summary })
    narrateTaskOutcome(
      summary
        ? `[TASK COMPLETE] The delegated ${kind} finished. Relay the outcome to the user conversationally — lead with the key findings, a few sentences at most. Result:\n${summary}`
        : `[TASK ENDED] The delegated ${kind} ("${goal}") ended without returning a result — it may have timed out or been interrupted on the desktop. Tell the user briefly and offer to retry.`
    )
  })

  session.sendToolOutput(
    callId,
    `Task ${id} started (${kind}): ${goal}. It is running in the open desktop session — announce that in one short line and stay available. A completion update will arrive here when it finishes.`
  )
}

function cancelDelegatedTask(session: RealtimeVoiceSession, callId: string): void {
  const task = activeTask

  if (!task) {
    session.sendToolOutput(callId, 'No delegated task is running. Nothing to cancel.')

    return
  }

  activeTask = null
  clearTaskProbe(task)

  // Interrupt the agent for real — the observation detach alone would leave it
  // working. Best-effort: a gateway hiccup still detaches the voice side.
  const sessionId = task.turn.sessionId()

  if (sessionId) {
    const gateway = $gateway.get() as null | { request?: (method: string, params?: Record<string, unknown>) => Promise<unknown> }
    const interrupt = gateway?.request?.('session.interrupt', { session_id: sessionId })

    if (interrupt) {
      interrupt.then(undefined, () => undefined)
    }
  }

  task.turn.cancel()
  emitTaskEvent('voice.task.cancelled', { goal: task.goal, id: task.id, kind: task.kind })
  session.sendToolOutput(callId, `Cancelled the ${task.kind}: "${task.goal}". Confirm to the user in a few words.`)
}

function runActionTool(session: RealtimeVoiceSession, name: string, callId: string, args: Record<string, unknown>): void {
  if (name === OPEN_APP_TOOL_NAME) {
    const app = typeof args.name === 'string' ? args.name.trim() : ''

    if (!app) {
      session.sendToolOutput(callId, 'No app name was given. Ask the user which application to open.')

      return
    }

    void openRealtimeSystemApp(app)
      .then(result => {
        session.sendToolOutput(
          callId,
          result.ok
            ? `Opened ${app}. Confirm in a couple of words.`
            : `Could not open "${app}" (${result.error || 'not found'}). Tell the user conversationally and ask if they meant a different app.`
        )
      })
      .catch(() => {
        session.sendToolOutput(callId, `Could not reach the launcher for "${app}". Tell the user it failed and to try again.`)
      })

    return
  }

  if (name === OPEN_URL_TOOL_NAME) {
    const url = normalizeUrl(typeof args.url === 'string' ? args.url : '')

    if (!url) {
      session.sendToolOutput(callId, 'That did not look like a web address. Ask the user to repeat the site.')

      return
    }

    void window.hermesDesktop?.openExternal?.(url)
    session.sendToolOutput(callId, `Opened ${url} in the browser. Confirm in a couple of words.`)

    return
  }

  if (name === DELEGATE_TASK_TOOL_NAME) {
    const goal = typeof args.goal === 'string' ? args.goal.trim() : ''

    if (!goal) {
      session.sendToolOutput(callId, 'No goal was given. Ask the user what exactly to do, then call delegate_task again with a complete goal.')

      return
    }

    startDelegatedTask(session, callId, goal, args.kind === 'research' ? 'research' : 'task')

    return
  }

  cancelDelegatedTask(session, callId)
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
    config = { ...config, foregroundContext: activeDelegate?.getContext?.() ?? '' }

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

  // Every explicit voice start (including a wake) gets one greeting. Only an
  // in-place transport renewal suppresses it, because the user never started a
  // new conversation in that path.
  const suppressGreeting = renewal

  const session = new RealtimeVoiceSession({
    mintToken: overrides => mintRealtimeToken(overrides),
    requestMicAccess: () => window.hermesDesktop?.requestMicrophoneAccess?.() ?? Promise.resolve(true),
    config,
    suppressGreeting,
    callbacks: {
      onStatusChange: next => patchState({ status: toConversationStatus(next) }),
      onLevel: level => {
        patchState({ level })
        emitAmplitude('mic', level)
      },
      onOutputLevel: level => {
        emitAmplitude('out', level)
      },
      onUserTranscript: transcript => {
        // P1: the stop word must stop — even while the assistant is mid-
        // sentence. Local enforcement; never trusts model barge-in.
        if (isVoiceStopCommand(transcript)) {
          killVoice()
        }
      },
      onToolCall: call => {
        if (call.name === SHOW_PROJECTS_TOOL_NAME || call.name === SHOW_PROJECT_TOOL_NAME || call.name === SHOW_DETAIL_TOOL_NAME || call.name === CREATE_PROJECT_TOOL_NAME || call.name === CLEAR_DISPLAY_TOOL_NAME) {
          runDisplayTool(session, call.name, call.callId, call.arguments)

          return
        }

        if (call.name === OPEN_APP_TOOL_NAME || call.name === OPEN_URL_TOOL_NAME || call.name === DELEGATE_TASK_TOOL_NAME || call.name === CANCEL_TASK_TOOL_NAME) {
          runActionTool(session, call.name, call.callId, call.arguments)

          return
        }

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
/** Hard kill: instant audio halt, session over, wake re-armed. Used by the
 *  spoken stop word and by the manual kills (orb click / Esc in the HUD,
 *  which dispatch the DOM event below from plugin code). */
function killVoice(): void {
  try {
    activeSession?.hardStop()
  } catch {
    // teardown below still runs
  }

  teardown('idle')
  void resumeWakeAfterVoice().catch(() => undefined)
}

// --- Command-mode chrome bridge ---------------------------------------------
// The cockpit owns the window edge-to-edge: the HUD dispatches these DOM
// events on mount/unmount and the feature layer drives the host chrome
// (setSidebarOpen is not SDK-exported — fidelity-wins ruling applies).
// Prior state is remembered and restored when command mode ends.
let chromeWasOpen: boolean | null = null

// --- Data requests from the cockpit (dense-by-default zones) ----------------
// Same truthful path as the voice verbs: fetch the compact read, emit the
// same display.* events. Voice and cockpit share one pipeline.
if (typeof window !== 'undefined') {
  window.addEventListener('jarvis:voice-kill', () => killVoice())

  window.addEventListener('jarvis:chrome', event => {
    const hide = Boolean((event as CustomEvent).detail?.hide)

    try {
      if (hide) {
        chromeWasOpen ??= $sidebarOpen.get()
        setSidebarOpen(false)
      } else {
        setSidebarOpen(chromeWasOpen ?? true)
        chromeWasOpen = null
      }
    } catch {
      // chrome control is best-effort; the cockpit renders regardless
    }
  })

  window.addEventListener('jarvis:display-request', () => {
    void getRealtimeProjectReview({ limit: 8 })
      .then(result => {
        emitGatewayEvent({ payload: { focus: false, result, silent: true }, type: 'display.projects' })
      })
      .catch(() => undefined)
  })
}

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
  contextUnsubscribe?.()
  activeDelegate = delegate

  const publishContext = () => {
    if (activeDelegate !== delegate) {
      return
    }

    const foregroundContext = delegate.getContext?.() ?? ''
    config = { ...config, foregroundContext }
    activeSession?.updateForegroundContext?.(foregroundContext)
  }

  contextUnsubscribe = delegate.subscribeContext?.(publishContext) ?? null
  publishContext()

  return () => {
    if (activeDelegate === delegate) {
      contextUnsubscribe?.()
      contextUnsubscribe = null
      activeDelegate = null
    }
  }
}

// --- Wake keeper heartbeat --------------------------------------------------
// Wake ownership is bound to the websocket that armed it: when that socket
// dies (renderer reconnects, transient connections — observed live
// 2026-08-24 14:40: resume issued by a dying peer, listener released 176ms
// later), the gateway releases the listener and nothing re-arms until app
// restart. armWakeWord() is idempotent (wake.status first, wake.start only
// when needed), so a slow heartbeat while no voice conversation is active
// closes every silent-death variant at once.
const WAKE_KEEPER_INTERVAL_MS = 60_000

setInterval(() => {
  if (!$voiceState.get().active) {
    void armWakeWord().catch(() => undefined)
  }
}, WAKE_KEEPER_INTERVAL_MS)

// --- Route-independent voice-start fallback ---------------------------------
// takeVoiceConversationStart has exactly ONE consumer in the app: the chat
// composer's voice hook. On any route without a mounted composer (the HUD is
// the obvious one — where the user watches the orb), a wake parks a start
// request that nobody consumes and voice never begins (observed live
// 2026-08-24: chime + orb listening, zero supervisor activity). The composer
// keeps first claim: we wait a beat, and only if the request is still
// unhandled does the supervisor start the conversation itself. The take()
// counter guarantees single consumption — no double-start race.
const FALLBACK_CLAIM_DELAY_MS = 350

$voiceConversationStartRequest.subscribe(requestId => {
  if (!requestId) {
    return
  }

  setTimeout(() => {
    if (takeVoiceConversationStart(requestId)) {
      voiceSupervisor.start()
    }
  }, FALLBACK_CLAIM_DELAY_MS)
})

// --- Wake re-arm watchdog ---------------------------------------------------
// The gateway's wake detector is one-shot: on detection it closes the mic and
// owes its re-arm to the voice flow calling wake.resume when the conversation
// ends. Observed live 2026-08-24 13:46: the post-detection flow died between
// detection and voice start, no resume ever came, and the machine stayed deaf
// until a restart. This watchdog makes deafness self-healing: 10s after any
// wake.detected, if no voice conversation is active (any transport), resume
// the detector. Best-effort; never throws into the event path.
const WAKE_REARM_MS = 10_000
let wakeWatchdog: null | ReturnType<typeof setTimeout> = null

onGatewayEvent('wake.detected', () => {
  if (wakeWatchdog) {
    clearTimeout(wakeWatchdog)
  }

  wakeWatchdog = setTimeout(() => {
    wakeWatchdog = null

    if (!$voiceState.get().active) {
      void resumeWakeAfterVoice().catch(() => undefined)
    }
  }, WAKE_REARM_MS)
})

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

    wakePaused = false
    autoStartAttempted = false
    realtimeEnabled = true
    contextUnsubscribe?.()
    contextUnsubscribe = null
    activeDelegate = null
    bridgeChain = Promise.resolve()
    config = {}
    $voiceState.set(IDLE_STATE)
  },
  /** @internal test seam — drive the renderer-shutdown path directly. */
  __handleShutdownForTests: handleRendererShutdown
}
