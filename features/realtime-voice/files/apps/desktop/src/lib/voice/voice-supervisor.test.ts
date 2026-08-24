import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { AgentDelegate } from './agent-delegate'

interface Callbacks {
  onStatusChange?: (s: string) => void
  onLevel?: (n: number) => void
  onToolCall?: (c: { callId: string; name: string; arguments: Record<string, unknown> }) => void
  onClose?: (info: { expired: boolean }) => void
}

interface Deps {
  callbacks: Callbacks
  config?: { foregroundContext?: string }
  suppressGreeting?: boolean
}

// Fake WebRTC transport + registry (hoisted so the vi.mock factory can see it).
const realtime = vi.hoisted(() => {
  const fakeSessions: FakeSession[] = []
  const state: { nextConnectImpl: (() => Promise<void>) | null } = { nextConnectImpl: null }

  class FakeSession {
    deps: Deps
    connectImpl: () => Promise<void>
    sendToolOutput = vi.fn()
    updateForegroundContext = vi.fn()
    setMuted = vi.fn()
    cancelResponse = vi.fn()
    close = vi.fn()

    constructor(deps: Deps) {
      this.deps = deps
      this.connectImpl = state.nextConnectImpl ?? (() => Promise.resolve())
      fakeSessions.push(this)
    }

    connect() {
      return this.connectImpl()
    }

    get callbacks() {
      return this.deps.callbacks
    }
  }

  class FakeRealtimeError extends Error {
    code: string

    constructor(code: string, message: string) {
      super(message)
      this.code = code
    }
  }

  return { fakeSessions, state, FakeSession, FakeRealtimeError }
})

const { fakeSessions, state, FakeRealtimeError } = realtime
type FakeSession = InstanceType<typeof realtime.FakeSession>

vi.mock('./realtime-session', () => ({
  RealtimeVoiceSession: realtime.FakeSession,
  RealtimeSessionError: realtime.FakeRealtimeError
}))

const getRealtimeProjectReview = vi.fn(async (_options?: unknown) => ({ ok: true, source: 'project index', projects: [] }))

const mintRealtimeToken = vi.fn(async (_overrides?: unknown) => ({
  ok: true,
  value: 'ek',
  model: 'gpt-realtime-2.1',
  voice: 'marin'
}))

const getRealtimeVoiceConfig = vi.fn(async () => ({
  ok: true,
  enabled: true,
  assistant_name: 'JARVIS',
  user_name: '',
  wake_phrase: 'hey jarvis',
  auto_start: false,
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  delivery: 'concise',
  greetings: [] as string[],
  review_projects_enabled: true
}))

vi.mock('@/hermes', () => ({
  mintRealtimeToken: (o: unknown) => mintRealtimeToken(o),
  getRealtimeProjectReview: (o: unknown) => getRealtimeProjectReview(o),
  getRealtimeVoiceConfig: () => getRealtimeVoiceConfig(),
  createRealtimeProject: async () => ({ ok: true, project: {} }),
  openRealtimeSystemApp: async () => ({ ok: true }),
  // pulled in transitively via @/store/layout -> @/store/profile
  setApiRequestProfile: () => undefined
}))

vi.mock('@/i18n', () => ({ translateNow: (key: string) => key }))

const notify = vi.fn()
const notifyError = vi.fn()
vi.mock('@/store/notifications', () => ({
  notify: (...a: unknown[]) => notify(...a),
  notifyError: (...a: unknown[]) => notifyError(...a)
}))

const resumeWakeAfterVoice = vi.fn()
vi.mock('@/store/wake-word', () => ({ resumeWakeAfterVoice: () => resumeWakeAfterVoice() }))

// $gateway.get() returns null → wake.pause is a no-op await in tests.
vi.mock('@/store/gateway', () => ({ $gateway: { get: () => null } }))

// The gateway-fallback delegate path pulls the full session-store graph in;
// keep this suite hermetic — its tests drive REGISTERED delegates directly.
vi.mock('@/store/session', () => ({
  $activeSessionId: { get: () => null },
  $selectedStoredSessionId: { get: () => null }
}))
vi.mock('./agent-delegate', () => ({
  createForegroundDelegate: () => ({
    getContext: () => '',
    runTurn: () => null,
    subscribeContext: () => () => undefined
  })
}))

import { $voiceState, voiceSupervisor } from './voice-supervisor'

const tick = async (n = 4) => {
  for (let i = 0; i < n; i += 1) {
    await Promise.resolve()
  }
}

function makeDelegate(result: Promise<string>): AgentDelegate & { cancel: () => void; runTurn: ReturnType<typeof vi.fn> } {
  const cancel = vi.fn()
  const runTurn = vi.fn(() => ({ cancel, result, sessionId: () => 'sess-live' }))

  return { cancel, getContext: () => '', runTurn, subscribeContext: () => () => undefined }
}

/** Start the voice session and return the connected fake session. */
async function startAndConnect(): Promise<FakeSession> {
  voiceSupervisor.start()
  await tick()

  return fakeSessions.at(-1)!
}

describe('voiceSupervisor', () => {
  beforeEach(() => {
    fakeSessions.length = 0
    state.nextConnectImpl = null
    vi.clearAllMocks()
    voiceSupervisor.__resetForTests()
  })

  afterEach(() => {
    voiceSupervisor.__resetForTests()
  })

  it('is idempotent: repeated start() (multiple composers) never creates a second session', async () => {
    await startAndConnect()
    expect(fakeSessions).toHaveLength(1)
    expect($voiceState.get().active).toBe(true)

    voiceSupervisor.start()
    voiceSupervisor.start()
    await tick()

    expect(fakeSessions).toHaveLength(1)
  })

  it('explicit end() closes the session exactly once and clears state + re-arms wake', async () => {
    const session = await startAndConnect()

    voiceSupervisor.end()
    await tick()

    expect(session.close).toHaveBeenCalledTimes(1)
    expect($voiceState.get().active).toBe(false)
    expect(resumeWakeAfterVoice).toHaveBeenCalledTimes(1)

    // A second end() is a no-op — nothing left to close.
    voiceSupervisor.end()
    expect(session.close).toHaveBeenCalledTimes(1)
  })

  it('mute + status survive across the persistent session (state lives in the store)', async () => {
    const session = await startAndConnect()

    voiceSupervisor.toggleMute()
    expect(session.setMuted).toHaveBeenCalledWith(true)
    expect($voiceState.get().muted).toBe(true)

    session.callbacks.onStatusChange?.('speaking')
    expect($voiceState.get().status).toBe('speaking')

    // The store is the source of truth a remounted composer reads back.
    expect($voiceState.get()).toMatchObject({ active: true, muted: true, status: 'speaking' })
  })

  it('reconnect (far-side drop) renews the transport in place and suppresses the launch greeting', async () => {
    const first = await startAndConnect()
    expect(first.deps.suppressGreeting).toBe(false)

    first.callbacks.onClose?.({ expired: true })
    await tick()

    expect(fakeSessions).toHaveLength(2)
    const second = fakeSessions[1]!
    expect(second.deps.suppressGreeting).toBe(true)
    // The renewal closed the old session but voice stayed on — never ended.
    expect(first.close).toHaveBeenCalled()
    expect($voiceState.get().active).toBe(true)
    // No wake churn on a reconnect.
    expect(resumeWakeAfterVoice).not.toHaveBeenCalled()
  })

  it('greets again after an explicit end followed by a new voice start', async () => {
    const first = await startAndConnect()
    expect(first.deps.suppressGreeting).toBe(false)

    voiceSupervisor.end()
    await tick()
    const second = await startAndConnect()

    expect(second.deps.suppressGreeting).toBe(false)
  })

  it('answers project reviews through the compact project-index endpoint with no delegate registered', async () => {
    const session = await startAndConnect()

    session.callbacks.onToolCall?.({ callId: 'r1', name: 'review_projects', arguments: { status: 'Blocked', limit: 3 } })
    await tick()

    expect(getRealtimeProjectReview).toHaveBeenCalledWith({ query: undefined, status: 'Blocked', limit: 3 })
    expect(session.sendToolOutput).toHaveBeenCalledWith('r1', expect.stringContaining('"source":"project index"'))
  })

  it('injects the foreground session and project context before Realtime connects', async () => {
    const delegate = {
      getContext: () => 'Active desktop session: Voice debugging\nActive project: JARVIS Realtime Voice',
      runTurn: vi.fn(() => null),
      subscribeContext: vi.fn(() => () => undefined)
    } as AgentDelegate & { getContext: () => string; subscribeContext: (listener: () => void) => () => void }

    voiceSupervisor.registerDelegate(delegate)
    const session = await startAndConnect()

    expect(session.deps.config?.foregroundContext).toContain('Active project: JARVIS Realtime Voice')
  })

  it('updates the live Realtime context when the foreground session or project changes', async () => {
    let context = 'Active desktop session: Voice debugging'
    let contextListener: () => void = () => undefined
    const delegate = {
      getContext: () => context,
      runTurn: vi.fn(() => null),
      subscribeContext: vi.fn((listener: () => void) => {
        contextListener = listener

        return () => undefined
      })
    } as AgentDelegate

    voiceSupervisor.registerDelegate(delegate)
    const session = await startAndConnect()
    context = 'Active desktop session: Release verification\nActive project: JARVIS Realtime Voice'
    contextListener()

    expect(session.updateForegroundContext).toHaveBeenCalledWith(context)
  })

  it('with no routable session, use_jarvis asks the user to open one and does NOT end the voice session', async () => {
    const session = await startAndConnect()

    session.callbacks.onToolCall?.({ callId: 'c1', name: 'use_jarvis', arguments: { request: 'do a thing' } })
    await tick()

    expect(session.sendToolOutput).toHaveBeenCalledWith('c1', expect.stringContaining('no open session'))
    expect(session.close).not.toHaveBeenCalled()
    expect($voiceState.get().active).toBe(true)
  })

  it('routes future use_jarvis calls to the CURRENT active delegate', async () => {
    const session = await startAndConnect()
    const a = makeDelegate(Promise.resolve('from A'))
    const b = makeDelegate(Promise.resolve('from B'))

    voiceSupervisor.registerDelegate(a)
    voiceSupervisor.registerDelegate(b)

    session.callbacks.onToolCall?.({ callId: 'c1', name: 'use_jarvis', arguments: { request: 'x' } })
    await tick()

    expect(b.runTurn).toHaveBeenCalledWith('x')
    expect(a.runTurn).not.toHaveBeenCalled()
  })

  it('keeps an in-flight tool result pinned to the ORIGINAL delegate across a session switch', async () => {
    const session = await startAndConnect()
    let resolveA: (text: string) => void = () => undefined
    const a = makeDelegate(new Promise<string>(res => (resolveA = res)))

    voiceSupervisor.registerDelegate(a)
    session.callbacks.onToolCall?.({ callId: 'c1', name: 'use_jarvis', arguments: { request: 'long task' } })
    await tick()
    expect(a.runTurn).toHaveBeenCalledWith('long task')

    // The user switches sessions mid-task — a new delegate takes over routing.
    const b = makeDelegate(Promise.resolve('from B'))
    voiceSupervisor.registerDelegate(b)

    // The original turn finally resolves — its result must go back, pinned to A.
    resolveA('the original answer')
    await tick()

    expect(session.sendToolOutput).toHaveBeenCalledWith('c1', 'the original answer')
    expect(b.runTurn).not.toHaveBeenCalled()
  })

  it('renderer shutdown closes the session and clears state', async () => {
    const session = await startAndConnect()

    voiceSupervisor.__handleShutdownForTests()

    expect(session.close).toHaveBeenCalledTimes(1)
    expect($voiceState.get().active).toBe(false)
  })

  it('falls back on INITIAL Realtime setup failure without ending the voice session', async () => {
    state.nextConnectImpl = () => Promise.reject(new FakeRealtimeError('no-token', 'no key'))

    voiceSupervisor.start()
    await tick()

    expect($voiceState.get().active).toBe(true)
    expect($voiceState.get().fallback).toBe(true)
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', message: 'no key' }))
  })

  it('with Realtime disabled in config, hands straight to the chained fallback (no session)', async () => {
    getRealtimeVoiceConfig.mockResolvedValueOnce({
      ok: true,
      enabled: false,
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

    voiceSupervisor.start()
    await tick()

    expect(fakeSessions).toHaveLength(0)
    expect($voiceState.get().active).toBe(true)
    expect($voiceState.get().fallback).toBe(true)
  })

  it('maybeAutoStart starts only when auto_start is configured', async () => {
    // Default config has auto_start: false → no session.
    await voiceSupervisor.maybeAutoStart()
    await tick()
    expect(fakeSessions).toHaveLength(0)

    // A second call is latched (once per launch), but with auto_start on it starts.
    voiceSupervisor.__resetForTests()
    getRealtimeVoiceConfig.mockResolvedValueOnce({
      ok: true,
      enabled: true,
      assistant_name: 'JARVIS',
      user_name: '',
      wake_phrase: 'hey jarvis',
      auto_start: true,
      model: 'gpt-realtime-2.1',
      voice: 'marin',
      delivery: 'concise',
      greetings: [],
      review_projects_enabled: false
    })
    await voiceSupervisor.maybeAutoStart()
    await tick()
    expect(fakeSessions).toHaveLength(1)
    expect($voiceState.get().active).toBe(true)
  })
})
