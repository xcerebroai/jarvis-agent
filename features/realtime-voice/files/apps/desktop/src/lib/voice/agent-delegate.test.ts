import { describe, expect, it, vi } from 'vitest'

import type { RpcEvent } from '@/types/hermes'
import { type ChatMessage, textPart } from '@/lib/chat-messages'

import { buildForegroundContext, createForegroundDelegate } from './agent-delegate'

/** Minimal stand-in for the global gateway-event tap. */
function makeBus() {
  const listeners: ((event: RpcEvent) => void)[] = []

  const subscribe = (_type: string, cb: (event: RpcEvent) => void) => {
    listeners.push(cb)

    return () => {
      const index = listeners.indexOf(cb)

      if (index >= 0) {
        listeners.splice(index, 1)
      }
    }
  }

  const emit = (event: RpcEvent) => {
    for (const cb of [...listeners]) {
      cb(event)
    }
  }

  return { subscribe, emit, listenerCount: () => listeners.length }
}

const complete = (session_id: string, text: string): RpcEvent => ({ type: 'message.complete', session_id, payload: { text } })
const start = (session_id: string): RpcEvent => ({ type: 'message.start', session_id })

function buildDeps(bus: ReturnType<typeof makeBus>, active: string | null, stored: string | null) {
  let timeoutFn: (() => void) | null = null

  return {
    overrides: {
      subscribe: bus.subscribe,
      getActiveSessionId: () => active,
      getSelectedStoredSessionId: () => stored,
      setTimer: (fn: () => void) => {
        timeoutFn = fn

        return 1
      },
      clearTimer: vi.fn(),
      timeoutMs: 1000
    },
    fireTimeout: () => timeoutFn?.()
  }
}

describe('createForegroundDelegate', () => {
  it('includes a bounded tail of the visible foreground conversation in Realtime context', () => {
    const message = (id: string, role: ChatMessage['role'], text: string, hidden = false): ChatMessage => ({
      id,
      role,
      hidden,
      parts: [textPart(text)]
    })
    const messages: ChatMessage[] = [
      message('u0', 'user', 'oldest omitted'),
      message('a0', 'assistant', 'also omitted'),
      message('hidden', 'user', 'private hidden message', true),
      message('u1', 'user', 'I want full duplex voice.'),
      message('a1', 'assistant', 'Realtime is connected.'),
      message('u2', 'user', 'Use the open project context.'),
      message('a2', 'assistant', 'The active project is Voice Debugging.'),
      message('u3', 'user', 'Do not start another chat.'),
      message('a3', 'assistant', 'Wake remains in this session.')
    ]

    const context = buildForegroundContext({
      messages,
      project: 'JARVIS Realtime Voice',
      sessionTitle: 'Plan the quarterly review',
      workspace: '/Users/operator'
    })

    expect(context).toContain('Active desktop session: Plan the quarterly review')
    expect(context).toContain('Active project: JARVIS Realtime Voice')
    expect(context).toContain('Recent visible conversation:')
    expect(context).toContain('User: I want full duplex voice.')
    expect(context).toContain('JARVIS: Wake remains in this session.')
    expect(context).not.toContain('oldest omitted')
    expect(context).not.toContain('private hidden message')
    expect(context.length).toBeLessThanOrEqual(4000)
  })

  it('pins the submit to the foreground session and resolves the turn from message.complete', async () => {
    const bus = makeBus()
    const submit = vi.fn(() => Promise.resolve(true))
    const { overrides } = buildDeps(bus, 'runtime-A', 'stored-A')
    const delegate = createForegroundDelegate(submit, overrides)

    const turn = delegate.runTurn('add two and two')!
    expect(submit).toHaveBeenCalledWith('add two and two', { sessionId: 'runtime-A', storedSessionId: 'stored-A' })

    bus.emit(start('runtime-A'))
    bus.emit(complete('runtime-A', 'The answer is four.'))

    await expect(turn.result).resolves.toBe('The answer is four.')
    // Unsubscribed after settling.
    expect(bus.listenerCount()).toBe(0)
  })

  it('stays pinned to the original session and ignores a different session completing', async () => {
    const bus = makeBus()
    const { overrides } = buildDeps(bus, 'runtime-A', null)
    const delegate = createForegroundDelegate(() => Promise.resolve(true), overrides)

    const turn = delegate.runTurn('long task')!

    bus.emit(start('runtime-A'))
    // The user switched to session B, which finishes its OWN turn first.
    bus.emit(complete('runtime-B', 'B unrelated reply'))
    // A's turn finishes later — that is the one we must return.
    bus.emit(complete('runtime-A', 'the original answer'))

    await expect(turn.result).resolves.toBe('the original answer')
  })

  it('ignores a stale prior-turn completion that lands before this turn begins', async () => {
    const bus = makeBus()
    const { overrides } = buildDeps(bus, 'runtime-A', null)
    const delegate = createForegroundDelegate(() => Promise.resolve(true), overrides)

    const turn = delegate.runTurn('x')!

    // A completion with no preceding (post-submit) start for our session is stale.
    bus.emit(complete('runtime-A', 'stale prior reply'))
    // The real turn begins and completes.
    bus.emit(start('runtime-A'))
    bus.emit(complete('runtime-A', 'fresh reply'))

    await expect(turn.result).resolves.toBe('fresh reply')
  })

  it('adopts a fresh new-chat session id from the first start when none is pinned', async () => {
    const bus = makeBus()
    const submit = vi.fn(() => Promise.resolve(true))
    const { overrides } = buildDeps(bus, null, null)
    const delegate = createForegroundDelegate(submit, overrides)

    const turn = delegate.runTurn('start a new chat task')!
    // No pinned id → submit targets the foreground default (no explicit ids).
    expect(submit).toHaveBeenCalledWith('start a new chat task', {})

    bus.emit(start('runtime-new'))
    bus.emit(complete('runtime-new', 'created and answered'))

    await expect(turn.result).resolves.toBe('created and answered')
  })

  it('hands back an empty result on timeout', async () => {
    const bus = makeBus()
    const { overrides, fireTimeout } = buildDeps(bus, 'runtime-A', null)
    const delegate = createForegroundDelegate(() => Promise.resolve(true), overrides)

    const turn = delegate.runTurn('x')!
    fireTimeout()

    await expect(turn.result).resolves.toBe('')
    expect(bus.listenerCount()).toBe(0)
  })

  it('settles empty when cancelled (teardown / voice session end)', async () => {
    const bus = makeBus()
    const { overrides } = buildDeps(bus, 'runtime-A', null)
    const delegate = createForegroundDelegate(() => Promise.resolve(true), overrides)

    const turn = delegate.runTurn('x')!
    turn.cancel()

    await expect(turn.result).resolves.toBe('')
    expect(bus.listenerCount()).toBe(0)
  })
})
