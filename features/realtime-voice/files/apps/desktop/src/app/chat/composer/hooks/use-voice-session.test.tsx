import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

interface Deps {
  callbacks: { onStatusChange?: (s: string) => void }
  suppressGreeting?: boolean
}

const realtime = vi.hoisted(() => {
  const fakeSessions: { close: ReturnType<typeof vi.fn>; deps: Deps }[] = []

  class FakeSession {
    deps: Deps
    close = vi.fn()
    connect = () => Promise.resolve()
    setMuted = vi.fn()
    cancelResponse = vi.fn()
    sendToolOutput = vi.fn()

    constructor(deps: Deps) {
      this.deps = deps
      fakeSessions.push(this)
    }
  }

  return { fakeSessions, FakeSession }
})

const { fakeSessions } = realtime

vi.mock('@/lib/voice/realtime-session', () => ({
  RealtimeVoiceSession: realtime.FakeSession,
  RealtimeSessionError: class extends Error {}
}))

vi.mock('@/hermes', () => ({
  mintRealtimeToken: async () => ({ ok: true, value: 'ek' }),
  getRealtimeProjectReview: async () => ({ ok: true }),
  getRealtimeVoiceConfig: async () => ({
    ok: true,
    enabled: true,
    assistant_name: 'JARVIS',
    user_name: '',
    wake_phrase: 'hey jarvis',
    auto_start: false,
    model: 'gpt-realtime-2.1',
    voice: 'marin',
    delivery: 'concise',
    greetings: [],
    review_projects_enabled: false
  })
}))

vi.mock('@/i18n', () => ({ translateNow: (k: string) => k }))
vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))
vi.mock('@/store/wake-word', () => ({ resumeWakeAfterVoice: vi.fn() }))
vi.mock('@/store/gateway', () => ({ $gateway: { get: () => null } }))

// The delegate's own pinning behavior is covered in agent-delegate.test.ts;
// here we only care about registration lifecycle, so stub the factory.
vi.mock('@/lib/voice/agent-delegate', () => ({
  createForegroundDelegate: () => ({ runTurn: () => null })
}))

import { voiceSupervisor } from '@/lib/voice/voice-supervisor'

import { useVoiceSession } from './use-voice-session'

const tick = async (n = 4) => {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve()
  }
}

const noopSubmit = () => true

describe('useVoiceSession adapter', () => {
  beforeEach(() => {
    fakeSessions.length = 0
    vi.clearAllMocks()
    voiceSupervisor.__resetForTests()
  })

  afterEach(() => {
    cleanup()
    voiceSupervisor.__resetForTests()
  })

  it('unmount + remount of a composer never closes or recreates the global session', async () => {
    await act(async () => {
      voiceSupervisor.start()
      await tick()
    })
    expect(fakeSessions).toHaveLength(1)
    const session = fakeSessions[0]!

    const view = renderHook(() => useVoiceSession({ onSubmit: noopSubmit, target: 'main' }))
    expect(view.result.current.active).toBe(true)

    // A tab switch / route change unmounts the composer — the voice session must survive.
    view.unmount()
    await tick()
    expect(session.close).not.toHaveBeenCalled()

    // Remounting the composer re-attaches to the SAME session, none created.
    const again = renderHook(() => useVoiceSession({ onSubmit: noopSubmit, target: 'main' }))
    await tick()
    expect(fakeSessions).toHaveLength(1)
    expect(again.result.current.active).toBe(true)
  })

  it('two mounted composers share the one global session (no second mic)', async () => {
    const main = renderHook(() => useVoiceSession({ onSubmit: noopSubmit, target: 'main' }))
    const tile = renderHook(() => useVoiceSession({ onSubmit: noopSubmit, target: 'tile:abc' }))

    await act(async () => {
      voiceSupervisor.start()
      await tick()
    })

    expect(fakeSessions).toHaveLength(1)
    expect(main.result.current.active).toBe(true)
    expect(tile.result.current.active).toBe(true)
  })

  it('registers the routing delegate for the MAIN composer only', async () => {
    const spy = vi.spyOn(voiceSupervisor, 'registerDelegate')

    renderHook(() => useVoiceSession({ onSubmit: noopSubmit, target: 'tile:abc' }))
    expect(spy).not.toHaveBeenCalled()

    renderHook(() => useVoiceSession({ onSubmit: noopSubmit, target: 'main' }))
    expect(spy).toHaveBeenCalledTimes(1)

    spy.mockRestore()
  })
})
