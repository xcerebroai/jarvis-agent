// The foreground routing delegate for the voice assistant's `use_jarvis` bridge.
//
// The main composer registers one of these with the supervisor. A `use_jarvis`
// call captures the delegate and calls `runTurn`, which:
//   1. pins the target to the CURRENT foreground session (runtime + stored id),
//   2. submits the request through the composer's normal submit seam, pinned to
//      that session so a mid-flight tab switch cannot re-home it,
//   3. observes THAT session's turn completion via the global gateway-event tap
//      (`onGatewayEvent`) — keyed on the session id, NOT the foreground-only
//      `$messages` atom — so the original turn's final answer is returned/announced
//      even after the user switches to a different session.
//
// This is the durable, socket-agnostic authority: `message.complete` events fire
// for every session (foreground and background) and carry the final assistant
// text in `payload.text`/`payload.rendered`.

import { onGatewayEvent } from '@/contrib/events'
import type { GatewayEventPayload } from '@/lib/chat-messages'
import { $activeSessionId, $selectedStoredSessionId } from '@/store/session'
import type { RpcEvent } from '@/types/hermes'

/** How long a bridged turn may run before the model is handed a graceful
 *  fallback so it is never left hanging. */
const TURN_TIMEOUT_MS = 120_000

export interface AgentTurn {
  /** Resolves the pinned session's final assistant text (or '' on timeout/cancel). */
  result: Promise<string>
  /** Settle the turn early with '' (teardown / voice session end). */
  cancel: () => void
}

export interface AgentDelegate {
  /** Route `request` into the foreground session and observe its result. Returns
   *  null when there is no session to route to (handled as "open a session"). */
  runTurn(request: string): AgentTurn | null
}

/** The composer submit seam. Accepts an explicit target so the turn pins to the
 *  session that was foreground when it started. */
export interface AgentSubmit {
  (text: string, options?: { sessionId?: string; storedSessionId?: string }): unknown
}

interface DelegateDeps {
  subscribe: typeof onGatewayEvent
  getActiveSessionId: () => string | null
  getSelectedStoredSessionId: () => string | null
  setTimer: (fn: () => void, ms: number) => number
  clearTimer: (handle: number) => void
  timeoutMs: number
}

const DEFAULT_DEPS: DelegateDeps = {
  subscribe: onGatewayEvent,
  getActiveSessionId: () => $activeSessionId.get(),
  getSelectedStoredSessionId: () => $selectedStoredSessionId.get(),
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: handle => window.clearTimeout(handle),
  timeoutMs: TURN_TIMEOUT_MS
}

function finalTextFrom(event: RpcEvent): string {
  const payload = event.payload as GatewayEventPayload | undefined
  const text = typeof payload?.text === 'string' ? payload.text : ''

  if (text.trim()) {
    return text
  }

  return typeof payload?.rendered === 'string' ? payload.rendered : ''
}

/**
 * Build a foreground delegate over the composer submit seam.
 *
 * `deps` is injectable for tests; production reads the live session atoms and the
 * real gateway-event tap.
 */
export function createForegroundDelegate(submit: AgentSubmit, overrides: Partial<DelegateDeps> = {}): AgentDelegate {
  const deps = { ...DEFAULT_DEPS, ...overrides }

  return {
    runTurn(request: string): AgentTurn | null {
      // Pin the target at the instant the turn starts — the foreground may change
      // while it runs, but this turn belongs to the session it started in.
      const pinnedRuntimeId = deps.getActiveSessionId()
      const storedSessionId = deps.getSelectedStoredSessionId()

      let settled = false
      let armed = false
      // The session this turn is bound to. Known upfront for an existing session;
      // adopted from the first post-submit `message.start` for a fresh new-chat
      // draft (whose runtime id is minted during submit).
      let targetRuntimeId = pinnedRuntimeId
      let resolveResult: (text: string) => void = () => undefined
      let timer: number | null = null

      const finish = (text: string) => {
        if (settled) {
          return
        }

        settled = true
        unsubscribe()

        if (timer !== null) {
          deps.clearTimer(timer)
        }

        resolveResult(text)
      }

      const unsubscribe = deps.subscribe('*', (event: RpcEvent) => {
        if (settled) {
          return
        }

        const sid = event.session_id

        if (!sid) {
          return
        }

        if (event.type === 'message.start') {
          if (targetRuntimeId === null) {
            targetRuntimeId = sid
          }

          if (sid === targetRuntimeId) {
            armed = true
          }

          return
        }

        // Only settle on the pinned session's completion, and only after its turn
        // has begun (guards against a stale prior-turn completion racing in).
        if (event.type === 'message.complete' && armed && sid === targetRuntimeId) {
          finish(finalTextFrom(event))
        }
      })

      const result = new Promise<string>(resolve => {
        resolveResult = resolve
        timer = deps.setTimer(() => finish(''), deps.timeoutMs)
      })

      // Route the request, pinned to the captured session. A submit rejection
      // hands the model a graceful empty result rather than hanging.
      Promise.resolve(
        submit(request, {
          ...(pinnedRuntimeId ? { sessionId: pinnedRuntimeId } : {}),
          ...(storedSessionId ? { storedSessionId } : {})
        })
      ).catch(() => finish(''))

      return { result, cancel: () => finish('') }
    }
  }
}
