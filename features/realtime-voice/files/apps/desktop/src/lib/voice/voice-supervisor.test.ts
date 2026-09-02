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

const getRealtimeProjectContext = vi.fn(async () => ({ ok: true, projects: [], text: 'Alpha [Blocked, High priority]', today: '2026-08-24', total_projects: 1, truncated: 0, updated: '2026-08-24' }))
const listRealtimeBuilds = vi.fn(async () => ({ builds: [], ok: true }))
const lookAtScreen = vi.fn(async (_o: unknown) => ({ answer: 'A terminal with a failing test.', analyze_ms: 2100, capture_ms: 130, cost_basis: 'list-price estimate', cost_usd: 0.0009, height: 900, latency_ms: 2300, model: 'gpt-4.1-mini', ok: true, usage: { total_tokens: 1400 }, width: 1440 }))
const setRealtimeProjectFields = vi.fn(async (_o: unknown) => ({ fields: { priority: 'High' }, key: 'P-1', name: 'Alpha', ok: true }))

vi.mock('@/hermes', () => ({
  appendVoiceTrace: () => undefined,
  mintRealtimeToken: (o: unknown) => mintRealtimeToken(o),
  getRealtimeProjectReview: (o: unknown) => getRealtimeProjectReview(o),
  getRealtimeVoiceConfig: () => getRealtimeVoiceConfig(),
  createRealtimeProject: async () => ({ ok: true, project: {} }),
  openRealtimeSystemApp: async () => ({ ok: true }),
  // P5.1 seams (sight, builds, reasoning). Each test overrides what it drives.
  getRealtimeProjectContext: () => getRealtimeProjectContext(),
  getRealtimeThumbnail: async () => ({ ok: false }),
  listRealtimeBuilds: () => listRealtimeBuilds(),
  lookAtScreen: (o: unknown) => lookAtScreen(o),
  setRealtimeProjectFields: (o: unknown) => setRealtimeProjectFields(o),
  updateRealtimeBuild: async () => ({ ok: true, build: null }),
  upsertRealtimeBuild: async (b: unknown) => ({ ok: true, build: b }),
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

import { emitGatewayEvent, onGatewayEvent } from '@/contrib/events'
import { requestVoiceConversationStart } from '@/store/composer'
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

  // ── P5.1 ──────────────────────────────────────────────────────────────────

  it('look_at_screen relays the answer with the look\'s real latency and estimated cost', async () => {
    const session = await startAndConnect()

    session.callbacks.onToolCall?.({ callId: 's1', name: 'look_at_screen', arguments: { question: 'what is on my screen' } })
    await tick(8)

    expect(lookAtScreen).toHaveBeenCalledWith({ question: 'what is on my screen' })
    expect(session.sendToolOutput).toHaveBeenCalledWith('s1', expect.stringContaining('A terminal with a failing test.'))
    expect(session.sendToolOutput).toHaveBeenCalledWith('s1', expect.stringMatching(/2\.3 seconds; about 0\.09 cents at list price via gpt-4\.1-mini/))
  })

  it('P5.2: "look at <app>" passes the app through and the answer names what was looked at', async () => {
    const session = await startAndConnect()

    lookAtScreen.mockResolvedValueOnce({ answer: 'Stripe developer keys page.', cost_usd: 0.001, latency_ms: 3000, model: 'gpt-4.1-mini', ok: true, target: { app: 'Google Chrome', kind: 'window', title: 'Stripe Dashboard', window_id: 701 } } as never)
    session.callbacks.onToolCall?.({ callId: 's3', name: 'look_at_screen', arguments: { app: 'Chrome', question: 'what page is this' } })
    await tick(8)

    expect(lookAtScreen).toHaveBeenCalledWith({ app: 'Chrome', question: 'what page is this' })
    expect(session.sendToolOutput).toHaveBeenCalledWith('s3', expect.stringContaining('Looked at Google Chrome — "Stripe Dashboard"'))
  })

  it('P5.2: a display fallback with JARVIS in the shot is reported, never hidden', async () => {
    const session = await startAndConnect()

    lookAtScreen.mockResolvedValueOnce({ answer: 'The JARVIS cockpit.', latency_ms: 2500, ok: true, target: { display_index: 1, includes_self: true, kind: 'display' } } as never)
    session.callbacks.onToolCall?.({ callId: 's4', name: 'look_at_screen', arguments: {} })
    await tick(8)

    expect(session.sendToolOutput).toHaveBeenCalledWith('s4', expect.stringContaining('JARVIS was the only window open'))
  })

  it('P5.2: a "do X in a website" delegation runs in the VISIBLE browser with narration and in-session secrets', async () => {
    const session = await startAndConnect()
    const delegate = makeDelegate(new Promise<string>(() => undefined))

    voiceSupervisor.registerDelegate(delegate)
    session.callbacks.onToolCall?.({ callId: 'd1', name: 'delegate_task', arguments: { goal: 'Walk Stripe\'s dashboard and connect the API to the agent', kind: 'browser' } })
    await tick(8)

    expect(delegate.runTurn).toHaveBeenCalledTimes(1)
    const prompt = String(delegate.runTurn.mock.calls[0][0])
    expect(prompt).toContain('Interactive browser task')
    expect(prompt).toMatch(/VISIBLE in-app browser/)
    expect(prompt).toMatch(/Narrate as you go/)
    expect(prompt).toMatch(/PASTE keys into this session/)
    expect(prompt).toMatch(/Do not claim inability/)
    expect(session.sendToolOutput).toHaveBeenCalledWith('d1', expect.stringContaining('watch the screen'))
  })

  it('look_at_screen without the Screen Recording grant explains the permission flow instead of pretending to see', async () => {
    const session = await startAndConnect()

    lookAtScreen.mockResolvedValueOnce({ error: 'Screen Recording permission is not granted', ok: false, permission: 'requested' } as never)
    session.callbacks.onToolCall?.({ callId: 's2', name: 'look_at_screen', arguments: {} })
    await tick(8)

    expect(session.sendToolOutput).toHaveBeenCalledWith('s2', expect.stringContaining('Screen Recording permission is not granted'))
    expect(session.sendToolOutput).toHaveBeenCalledWith('s2', expect.stringContaining('Privacy & Security'))
  })

  it('set_project_field persists the voice edit through the backend and confirms compactly', async () => {
    const session = await startAndConnect()

    session.callbacks.onToolCall?.({ callId: 'e1', name: 'set_project_field', arguments: { name: 'Alpha', field: 'priority', value: 'high' } })
    await tick(8)

    expect(setRealtimeProjectFields).toHaveBeenCalledWith({ fields: { priority: 'high' }, name: 'Alpha' })
    expect(session.sendToolOutput).toHaveBeenCalledWith('e1', expect.stringContaining('Saved: Alpha — priority = High'))
  })

  it('set_project_field refuses a non-editable field without touching the backend', async () => {
    const session = await startAndConnect()

    setRealtimeProjectFields.mockClear()
    session.callbacks.onToolCall?.({ callId: 'e2', name: 'set_project_field', arguments: { name: 'Alpha', field: 'secret', value: 'x' } })
    await tick(4)

    expect(setRealtimeProjectFields).not.toHaveBeenCalled()
    expect(session.sendToolOutput).toHaveBeenCalledWith('e2', expect.stringContaining('not an editable field'))
  })

  it('ask_judgment gathers the whole enriched board and, with no session to reason in, asks for one — never answers judgment from the fast path', async () => {
    const session = await startAndConnect()

    session.callbacks.onToolCall?.({ callId: 'j1', name: 'ask_judgment', arguments: { question: 'what should I focus on' } })
    await tick(12)

    expect(getRealtimeProjectContext).toHaveBeenCalled()
    expect(session.sendToolOutput).toHaveBeenCalledWith('j1', expect.stringContaining('no open session'))
  })

  it('build_status with no builds offers to start one', async () => {
    const session = await startAndConnect()

    session.callbacks.onToolCall?.({ callId: 'b1', name: 'build_status', arguments: {} })
    await tick(4)

    expect(session.sendToolOutput).toHaveBeenCalledWith('b1', expect.stringContaining('No build sessions exist yet'))
  })

  it('start_build with no gateway reports that a session could not be routed (and never fakes a build)', async () => {
    const session = await startAndConnect()

    session.callbacks.onToolCall?.({ callId: 'b2', name: 'start_build', arguments: { goal: 'attach my Stripe account to the agent via API', name: 'Stripe integration' } })
    await tick(8)

    expect(session.sendToolOutput).toHaveBeenCalledWith('b2', expect.stringContaining('no open session'))
  })

  it('P6: a pointer click on a card drives the same stage state as the voice verb ("expand it" then resolves to it)', async () => {
    const session = await startAndConnect()
    const seen: string[] = []
    const off = onGatewayEvent('*', event => { seen.push(event.type) })

    getRealtimeProjectReview.mockResolvedValueOnce({ ok: true, projects: [{ name: 'Alpha', status: 'Blocked' }], source: 'project index' } as never)
    window.dispatchEvent(new CustomEvent('jarvis:detail-request', { detail: { name: 'Alpha' } }))
    await tick(8)

    expect(getRealtimeProjectReview).toHaveBeenCalledWith({ detail: true, limit: 1, query: 'Alpha' })
    expect(seen).toContain('display.detail')

    // The voice's bare "expand it" now resolves to the clicked card.
    getRealtimeProjectReview.mockResolvedValueOnce({ ok: true, projects: [{ name: 'Alpha', status: 'Blocked' }], source: 'project index' } as never)
    session.callbacks.onToolCall?.({ callId: 'x1', name: 'show_project_detail', arguments: { name: 'it' } })
    await tick(8)
    expect(getRealtimeProjectReview).toHaveBeenLastCalledWith(expect.objectContaining({ detail: true, query: 'Alpha' }))

    window.dispatchEvent(new CustomEvent('jarvis:stage-collapse'))
    await tick(2)
    expect(seen).toContain('display.stage.clear')
    off()
  })

  it('P6: a metric-tile click filters the board through the same review pipeline', async () => {
    await startAndConnect()
    const seen: Array<{ type: string; payload?: unknown }> = []
    const off = onGatewayEvent('*', event => { seen.push({ payload: event.payload, type: event.type }) })

    getRealtimeProjectReview.mockResolvedValueOnce({ ok: true, projects: [{ name: 'Alpha', status: 'Blocked' }], source: 'project index' } as never)
    window.dispatchEvent(new CustomEvent('jarvis:board-filter', { detail: { status: 'Blocked' } }))
    await tick(8)

    expect(getRealtimeProjectReview).toHaveBeenCalledWith({ limit: 8, status: 'Blocked' })
    const projected = seen.find(e => e.type === 'display.projects')
    expect(projected).toBeTruthy()
    expect((projected!.payload as { status: string }).status).toBe('Blocked')
    off()
  })

  it('cold start: a wake, the composer start and the supervisor fallback claim open exactly ONE session', async () => {
    const before = fakeSessions.length

    // The wake window/gateway fires the detection; the app requests a start;
    // the composer consumes it (calls start) while the supervisor's fallback
    // also wakes up 350ms later — historically the seam for a second voice.
    emitGatewayEvent({ payload: {}, type: 'wake.detected' })
    requestVoiceConversationStart()
    voiceSupervisor.start()
    voiceSupervisor.start()
    await tick()
    await new Promise(resolve => setTimeout(resolve, 450))
    await tick()

    expect(fakeSessions.length - before).toBe(1)
    expect(fakeSessions.at(-1)!.deps.suppressGreeting).toBe(false)

    // Second wake after an explicit end: again exactly one session.
    voiceSupervisor.end()
    await tick()
    emitGatewayEvent({ payload: {}, type: 'wake.detected' })
    requestVoiceConversationStart()
    voiceSupervisor.start()
    await tick()
    await new Promise(resolve => setTimeout(resolve, 450))
    await tick()
    expect(fakeSessions.length - before).toBe(2)
  })

  it('P6.x drift guard: probeBackendHealth reports available when the config endpoint answers, and emits voice.backend', async () => {
    const seen: Array<{ type: string; payload?: unknown }> = []
    const off = onGatewayEvent('*', event => { seen.push({ payload: event.payload, type: event.type }) })

    getRealtimeVoiceConfig.mockResolvedValueOnce({ ok: true } as never)
    const health = await voiceSupervisor.probeBackendHealth()
    await tick()

    expect(health.available).toBe(true)
    expect(voiceSupervisor.getBackendHealth().available).toBe(true)
    const ev = seen.find(e => e.type === 'voice.backend')
    expect(ev).toBeTruthy()
    expect((ev!.payload as { available: boolean }).available).toBe(true)
    off()
  })

  it('P6.x drift guard: a missing realtime endpoint (405) is reported UNAVAILABLE with a drift reason, not swallowed', async () => {
    const seen: Array<{ type: string; payload?: unknown }> = []
    const off = onGatewayEvent('*', event => { seen.push({ payload: event.payload, type: event.type }) })

    getRealtimeVoiceConfig.mockRejectedValueOnce(new Error('Error 405 Method Not Allowed'))
    const health = await voiceSupervisor.probeBackendHealth()
    await tick()

    expect(health.available).toBe(false)
    expect(health.reason).toMatch(/endpoints missing|feature not applied|upstream API drift/i)
    const ev = seen.find(e => e.type === 'voice.backend')
    expect((ev!.payload as { available: boolean }).available).toBe(false)
    off()
  })
})
