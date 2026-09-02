import { beforeEach, describe, expect, it, vi } from 'vitest'

import type { RealtimeTokenResponse } from '@/types/hermes'

import { RealtimeSessionError, type RealtimeStatus, RealtimeVoiceSession } from './realtime-session'

class FakeDataChannel {
  readyState: RTCDataChannelState = 'connecting'
  onopen: (() => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  sent: string[] = []
  closed = false

  send(data: string) {
    this.sent.push(data)
  }

  close() {
    this.readyState = 'closed'
    this.closed = true
  }

  open() {
    this.readyState = 'open'
    this.onopen?.()
  }

  emit(event: unknown) {
    this.onmessage?.({ data: JSON.stringify(event) })
  }

  parsedSent() {
    return this.sent.map(raw => JSON.parse(raw))
  }
}

class FakePeerConnection {
  onconnectionstatechange: (() => void) | null = null
  ontrack: ((event: unknown) => void) | null = null
  connectionState: RTCPeerConnectionState = 'new'
  dc: FakeDataChannel | null = null
  addedTracks: MediaStreamTrack[] = []
  remoteDescription: { type: string; sdp: string } | null = null
  closed = false

  createDataChannel() {
    this.dc = new FakeDataChannel()

    return this.dc as unknown as RTCDataChannel
  }

  addTrack(track: MediaStreamTrack) {
    this.addedTracks.push(track)
  }

  async createOffer() {
    return { type: 'offer', sdp: 'OFFER_SDP' } as RTCSessionDescriptionInit
  }

  async setLocalDescription() {
    // no-op
  }

  async setRemoteDescription(desc: RTCSessionDescriptionInit) {
    this.remoteDescription = { type: String(desc.type), sdp: desc.sdp ?? '' }
  }

  close() {
    this.closed = true
    this.connectionState = 'closed'
  }
}

function fakeMicStream() {
  const track = { enabled: true, stop: vi.fn(), kind: 'audio' } as unknown as MediaStreamTrack

  return {
    stream: {
      getAudioTracks: () => [track],
      getTracks: () => [track]
    } as unknown as MediaStream,
    track
  }
}

const TOKEN: RealtimeTokenResponse = {
  ok: true,
  value: 'ek_ephemeral_test',
  expires_at: 1_900_000_000,
  model: 'gpt-realtime-2.1',
  voice: 'marin',
  session_id: 'sess_1'
}

interface Harness {
  session: RealtimeVoiceSession
  pc: FakePeerConnection
  mic: ReturnType<typeof fakeMicStream>
  audio: { autoplay: boolean; muted: boolean; srcObject: unknown; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }
  sdpFetch: ReturnType<typeof vi.fn>
  statuses: RealtimeStatus[]
  toolCalls: { callId: string; name: string; arguments: Record<string, unknown> }[]
  errors: RealtimeSessionError[]
  outputLevels: number[]
  userSpeechStarts: number
}

function makeHarness(overrides: {
  mintToken?: () => Promise<RealtimeTokenResponse>
  getUserMedia?: () => Promise<MediaStream>
  sdpResponse?: Partial<Response>
  suppressGreeting?: boolean
} = {}): Harness {
  const pc = new FakePeerConnection()
  const mic = fakeMicStream()
  const audio = { autoplay: false, muted: false, srcObject: null as unknown, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
  const statuses: RealtimeStatus[] = []
  const toolCalls: Harness['toolCalls'] = []
  const errors: RealtimeSessionError[] = []
  const outputLevels: number[] = []
  let userSpeechStarts = 0

  const sdpFetch = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    text: async () => 'ANSWER_SDP',
    ...overrides.sdpResponse
  } as Response)

  const session = new RealtimeVoiceSession({
    mintToken: overrides.mintToken ?? (() => Promise.resolve(TOKEN)),
    getUserMedia: overrides.getUserMedia ?? (() => Promise.resolve(mic.stream)),
    createPeerConnection: () => pc as unknown as RTCPeerConnection,
    createAudioElement: () => audio as unknown as HTMLAudioElement,
    sdpFetch: sdpFetch as unknown as typeof fetch,
    // Enable the optional review tool and a user name so this harness exercises
    // both tools and a named greeting; the public defaults (no name, review off)
    // are covered in realtime-config.test.ts.
    config: { reviewProjectsEnabled: true, userName: 'Ada' },
    suppressGreeting: overrides.suppressGreeting ?? false,
    callbacks: {
      onStatusChange: s => statuses.push(s),
      onToolCall: c => toolCalls.push(c),
      onError: e => errors.push(e),
      onUserSpeechStarted: () => {
        userSpeechStarts += 1
      },
      onOutputLevel: (level: number) => {
        outputLevels.push(level)
      }
    }
  })

  return {
    session,
    pc,
    mic,
    audio,
    sdpFetch,
    statuses,
    toolCalls,
    errors,
    outputLevels,
    get userSpeechStarts() {
      return userSpeechStarts
    }
  } as Harness
}

describe('RealtimeVoiceSession', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('negotiates the WebRTC SDP exchange with the ephemeral bearer and application/sdp', async () => {
    const h = makeHarness()
    await h.session.connect()

    expect(h.sdpFetch).toHaveBeenCalledTimes(1)
    const [url, init] = h.sdpFetch.mock.calls[0]
    expect(url).toContain('https://api.openai.com/v1/realtime/calls')
    expect(url).toContain('model=gpt-realtime-2.1')
    expect((init as RequestInit).method).toBe('POST')
    expect((init as RequestInit).body).toBe('OFFER_SDP')
    const headers = (init as RequestInit).headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer ek_ephemeral_test')
    expect(headers['Content-Type']).toBe('application/sdp')

    // The live mic track was added and the answer SDP applied.
    expect(h.pc.addedTracks).toContain(h.mic.track)
    expect(h.pc.remoteDescription).toEqual({ type: 'answer', sdp: 'ANSWER_SDP' })
  })

  it('waits for session.updated before sending the native greeting exactly once', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()

    let sent = h.pc.dc!.parsedSent()
    expect(sent[0].type).toBe('session.update')
    expect(sent[0].session.model).toBe('gpt-realtime-2.1')
    expect(sent[0].session.audio.output.voice).toBe('marin')
    expect(sent[0].session.reasoning).toEqual({ effort: 'minimal' })
    expect(sent[0].session.audio.input.turn_detection.type).toBe('semantic_vad')
    const toolNames = sent[0].session.tools.map((tool: { name: string }) => tool.name)
    expect(toolNames[0]).toBe('review_projects')
    expect(toolNames).toContain('show_projects')
    expect(toolNames).toContain('delegate_task')
    expect(toolNames[toolNames.length - 1]).toBe('use_jarvis')

    expect(sent).toHaveLength(1)

    h.pc.dc!.emit({ type: 'session.updated' })
    sent = h.pc.dc!.parsedSent()
    // The input buffer is cleared right before the greeting: nothing captured
    // during the connect can become a competing turn.
    expect(sent[1].type).toBe('input_audio_buffer.clear')
    expect(sent[2].type).toBe('response.create')
    expect(sent[2].response.instructions).toContain('Ada')
    expect(sent[2].response.instructions.toLowerCase()).not.toContain('hey jarvis')

    // A duplicate acknowledgement must not replay the greeting.
    h.pc.dc!.emit({ type: 'session.updated' })

    // Exactly one greeting response.create.
    const greetings = sent.filter(
      e => e.type === 'response.create' && String(e.response?.instructions ?? '').includes('Ada')
    )

    expect(greetings).toHaveLength(1)
    expect(h.statuses).toContain('listening')
  })

  it('emits a use_jarvis tool call from response.done exactly once (dedupes duplicates)', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()

    const doneEvent = {
      type: 'response.done',
      response: {
        output: [
          {
            type: 'function_call',
            name: 'use_jarvis',
            call_id: 'call_1',
            arguments: JSON.stringify({ request: 'what is 2+2' })
          }
        ]
      }
    }

    h.pc.dc!.emit(doneEvent)
    // A retransmitted/duplicate response.done for the same call_id must not fire twice.
    h.pc.dc!.emit(doneEvent)

    expect(h.toolCalls).toHaveLength(1)
    expect(h.toolCalls[0]).toEqual({
      callId: 'call_1',
      name: 'use_jarvis',
      arguments: { request: 'what is 2+2' }
    })
  })

  it('dispatches the compact review_projects tool without rewriting it as use_jarvis', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()

    h.pc.dc!.emit({
      type: 'response.done',
      response: {
        output: [
          {
            type: 'function_call',
            name: 'review_projects',
            call_id: 'review_1',
            arguments: JSON.stringify({ status: 'Blocked', limit: 3 })
          }
        ]
      }
    })

    expect(h.toolCalls).toContainEqual({
      callId: 'review_1',
      name: 'review_projects',
      arguments: { status: 'Blocked', limit: 3 }
    })
  })

  it('returns tool output then asks the model to respond', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()
    h.pc.dc!.sent = []

    h.session.sendToolOutput('call_1', 'The answer is 4.')

    const sent = h.pc.dc!.parsedSent()
    expect(sent[0]).toEqual({
      type: 'conversation.item.create',
      item: { type: 'function_call_output', call_id: 'call_1', output: 'The answer is 4.' }
    })
    expect(sent[1]).toEqual({ type: 'response.create' })
  })

  it('pushes changed foreground session and project context into the live session', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()
    h.pc.dc!.sent = []

    h.session.updateForegroundContext(
      'Active desktop session: Release verification\nActive project: JARVIS Realtime Voice'
    )

    const [update] = h.pc.dc!.parsedSent()
    expect(update.type).toBe('session.update')
    expect(update.session.instructions).toContain('Active desktop session: Release verification')
    expect(update.session.instructions).toContain('Active project: JARVIS Realtime Voice')
  })

  it('reflects native barge-in: user speech flips status back to listening', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()

    // The greeting owns the first turn; barge-in is a user-turn behaviour.
    h.pc.dc!.emit({ type: 'session.updated' })
    h.pc.dc!.emit({ type: 'response.created', response: { id: 'resp_greeting' } })
    h.pc.dc!.emit({ type: 'response.done', response: { id: 'resp_greeting', output: [] } })

    h.pc.dc!.emit({ type: 'response.created' })
    h.pc.dc!.emit({ type: 'response.output_audio.delta', delta: 'x' })
    expect(h.session.getStatus()).toBe('speaking')

    h.pc.dc!.emit({ type: 'input_audio_buffer.speech_started' })
    expect(h.userSpeechStarts).toBe(1)
    expect(h.session.getStatus()).toBe('listening')
  })

  it('mutes by disabling the live mic track without tearing down', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()

    // Let the greeting finish so the first-turn gate is not what we measure.
    h.pc.dc!.emit({ type: 'session.updated' })
    h.pc.dc!.emit({ type: 'response.created', response: { id: 'resp_g' } })
    h.pc.dc!.emit({ type: 'response.done', response: { id: 'resp_g', output: [] } })
    expect(h.mic.track.enabled).toBe(true)

    h.session.setMuted(true)
    expect(h.mic.track.enabled).toBe(false)
    expect(h.session.isMuted()).toBe(true)
    expect(h.pc.closed).toBe(false)

    h.session.setMuted(false)
    expect(h.mic.track.enabled).toBe(true)
  })

  // ── first-wake: exactly ONE utterance source ────────────────────────────
  it('cold start: the greeting owns the first turn — mic gated until its response is done, one response.create', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()

    // Mic is attached but silent to the server while the greeting is pending.
    expect(h.pc.addedTracks).toHaveLength(1)
    expect(h.mic.track.enabled).toBe(false)
    expect(h.session.isFirstTurnGated()).toBe(true)

    h.pc.dc!.emit({ type: 'session.updated' })
    h.pc.dc!.emit({ type: 'session.updated' }) // duplicate ack: still one greeting
    const utterances = h.pc.dc!.parsedSent().filter(e => e.type === 'response.create')
    expect(utterances).toHaveLength(1)
    expect(h.mic.track.enabled).toBe(false)

    // A VAD speech_started during the greeting is not a barge-in (mic is gated).
    h.pc.dc!.emit({ type: 'input_audio_buffer.speech_started' })
    expect(h.userSpeechStarts).toBe(0)

    // The greeting's response completes → the turn is handed to the user.
    h.pc.dc!.emit({ type: 'response.created', response: { id: 'resp_greeting' } })
    h.pc.dc!.emit({ type: 'response.done', response: { id: 'resp_greeting', output: [] } })
    expect(h.mic.track.enabled).toBe(true)
    expect(h.session.isFirstTurnGated()).toBe(false)
    // Only the greeting was ever requested by the client.
    expect(h.pc.dc!.parsedSent().filter(e => e.type === 'response.create')).toHaveLength(1)
  })

  it('second wake (a fresh session) behaves identically: one greeting, mic gated, then released', async () => {
    for (const round of [1, 2]) {
      const h = makeHarness()
      await h.session.connect()
      h.pc.dc!.open()
      h.pc.dc!.emit({ type: 'session.updated' })
      expect(h.pc.dc!.parsedSent().filter(e => e.type === 'response.create')).toHaveLength(1)
      expect(h.mic.track.enabled).toBe(false)
      h.pc.dc!.emit({ type: 'response.created', response: { id: 'resp_' + round } })
      h.pc.dc!.emit({ type: 'response.done', response: { id: 'resp_' + round, output: [] } })
      expect(h.mic.track.enabled).toBe(true)
      h.session.close()
    }
  })

  it('a renewal (suppressGreeting) has no gate: mic open at once, no response.create', async () => {
    const h = makeHarness({ suppressGreeting: true })
    await h.session.connect()
    h.pc.dc!.open()
    h.pc.dc!.emit({ type: 'session.updated' })
    expect(h.mic.track.enabled).toBe(true)
    expect(h.session.isFirstTurnGated()).toBe(false)
    expect(h.pc.dc!.parsedSent().filter(e => e.type === 'response.create')).toHaveLength(0)
  })

  it('the gate never wedges: a server error during the greeting releases the mic', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()
    h.pc.dc!.emit({ type: 'session.updated' })
    h.pc.dc!.emit({ type: 'error', error: { message: 'rejected' } })
    expect(h.mic.track.enabled).toBe(true)
  })

  it('user mute during the greeting stays muted after the turn is released', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()
    h.pc.dc!.emit({ type: 'session.updated' })
    h.session.setMuted(true)
    h.pc.dc!.emit({ type: 'response.created', response: { id: 'r' } })
    h.pc.dc!.emit({ type: 'response.done', response: { id: 'r', output: [] } })
    expect(h.mic.track.enabled).toBe(false)
    expect(h.session.isMuted()).toBe(true)
  })

  it('closes the peer connection, data channel, mic tracks, and remote audio on end', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()

    h.session.close()

    expect(h.pc.closed).toBe(true)
    expect(h.pc.dc!.closed).toBe(true)
    expect(h.mic.track.stop).toHaveBeenCalled()
    expect(h.audio.srcObject).toBeNull()
    expect(h.session.getStatus()).toBe('idle')

    // Post-close sends are inert.
    h.session.sendToolOutput('call_x', 'ignored')
    expect(h.pc.dc!.sent.some(s => s.includes('call_x'))).toBe(false)
  })

  it('fails with a no-token error when the mint yields no ephemeral value', async () => {
    const h = makeHarness({ mintToken: () => Promise.resolve({ ...TOKEN, value: '' }) })

    await expect(h.session.connect()).rejects.toBeInstanceOf(RealtimeSessionError)
    expect(h.errors[0].code).toBe('no-token')
  })

  it('fails with a no-mic error when getUserMedia rejects', async () => {
    const h = makeHarness({ getUserMedia: () => Promise.reject(new Error('denied')) })

    await expect(h.session.connect()).rejects.toMatchObject({ code: 'no-mic' })
  })

  it('fails with an endpoint error when the SDP POST is not ok', async () => {
    const h = makeHarness({ sdpResponse: { ok: false, status: 500 } })

    await expect(h.session.connect()).rejects.toMatchObject({ code: 'endpoint' })
    // A failed setup tears the session down.
    expect(h.pc.closed).toBe(true)
  })

  // ── P1-restore: interruption re-ported to the WebRTC GA surface ──────────
  it('cancelResponse flushes buffered audio (response.cancel + output_audio_buffer.clear), not just cancel', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()
    h.pc.dc!.emit({ type: 'session.updated' })

    h.session.cancelResponse()
    const sent = h.pc.dc!.parsedSent().map(e => e.type)
    expect(sent).toContain('response.cancel')
    expect(sent).toContain('output_audio_buffer.clear')
    expect(sent.indexOf('response.cancel')).toBeLessThan(sent.indexOf('output_audio_buffer.clear'))
  })

  it('hardStop instantly silences: cancel+flush, mute the element, STOP the inbound track, then close', async () => {
    const stopped: string[] = []
    const track = { enabled: true, kind: 'audio', stop: () => stopped.push('remote') } as unknown as MediaStreamTrack
    const remoteStream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()
    h.pc.dc!.emit({ type: 'session.updated' })
    // simulate a remote audio track arriving (sets session.remoteAudio + srcObject)
    h.pc.ontrack?.({ streams: [remoteStream] } as unknown as RTCTrackEvent)

    h.session.hardStop()

    const sent = h.pc.dc!.parsedSent().map(e => e.type)
    expect(sent).toContain('response.cancel')
    expect(sent).toContain('output_audio_buffer.clear')
    expect(h.audio.pause).toHaveBeenCalled()
    expect(h.audio.muted).toBe(true)
    expect(stopped).toContain('remote')
    expect(h.pc.closed).toBe(true)
  })

  it('bug 4: the orb SPEAKS on JARVIS output — the remote-stream meter pulls the graph to a destination, resumes, and yields a non-zero level (not silence)', async () => {
    // Chromium's analyser reads all-silence from a remote WebRTC stream unless
    // the graph is pulled to a destination. This guards that the output meter
    // builds analyser -> zero-gain sink -> destination, resumes the context,
    // and actually produces a level — the exact wiring that keeps regressing to
    // a silent stream tap (orb then only moves on mic).
    const connects: string[] = []
    const gainNode = { gain: { value: 1 }, connect: vi.fn(() => connects.push('gain->dest')) }
    const analyserNode = {
      fftSize: 0,
      connect: vi.fn(() => connects.push('analyser->gain')),
      // non-flat waveform => non-zero RMS
      getByteTimeDomainData: (a: Uint8Array) => { for (let i = 0; i < a.length; i++) a[i] = i % 2 ? 210 : 46 }
    }
    const sourceNode = { connect: vi.fn(() => connects.push('source->analyser')) }
    const resume = vi.fn().mockResolvedValue(undefined)
    class FakeAudioContext {
      destination = { kind: 'destination' }
      createAnalyser = () => analyserNode
      createMediaStreamSource = () => sourceNode
      createGain = () => gainNode
      resume = resume
      close = vi.fn().mockResolvedValue(undefined)
    }
    // Deferred rAF queue: real rAF is async, so the mic meter and the output
    // meter interleave one frame at a time. (A synchronous stub lets the mic
    // meter recurse and monopolize the budget before the output meter starts.)
    const rafQueue: FrameRequestCallback[] = []
    const pump = (times: number) => { for (let i = 0; i < times; i++) { rafQueue.splice(0).forEach(cb => cb(0)) } }
    vi.stubGlobal('AudioContext', FakeAudioContext)
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => rafQueue.push(cb))
    vi.stubGlobal('cancelAnimationFrame', () => undefined)

    try {
      const track = { enabled: true, kind: 'audio', stop: vi.fn() } as unknown as MediaStreamTrack
      const remoteStream = { getTracks: () => [track], getAudioTracks: () => [track] } as unknown as MediaStream
      const h = makeHarness()
      await h.session.connect()
      h.pc.dc!.open()
      h.pc.dc!.emit({ type: 'session.updated' })

      h.pc.ontrack?.({ streams: [remoteStream] } as unknown as RTCTrackEvent)
      pump(3)

      // graph pulled to a destination (else Chromium yields silence)
      expect(connects).toContain('analyser->gain')
      expect(connects).toContain('gain->dest')
      expect(gainNode.gain.value).toBe(0)
      // context resumed (it can start suspended with no user gesture here)
      expect(resume).toHaveBeenCalled()
      // and it actually produced a non-zero output level (orb speak-bloom fuel)
      expect(h.outputLevels.length).toBeGreaterThan(0)
      expect(Math.max(...h.outputLevels)).toBeGreaterThan(0)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
