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
  audio: { autoplay: boolean; srcObject: unknown; play: ReturnType<typeof vi.fn>; pause: ReturnType<typeof vi.fn> }
  sdpFetch: ReturnType<typeof vi.fn>
  statuses: RealtimeStatus[]
  toolCalls: { callId: string; name: string; arguments: Record<string, unknown> }[]
  errors: RealtimeSessionError[]
  userSpeechStarts: number
}

function makeHarness(overrides: {
  mintToken?: () => Promise<RealtimeTokenResponse>
  getUserMedia?: () => Promise<MediaStream>
  sdpResponse?: Partial<Response>
} = {}): Harness {
  const pc = new FakePeerConnection()
  const mic = fakeMicStream()
  const audio = { autoplay: false, srcObject: null as unknown, play: vi.fn().mockResolvedValue(undefined), pause: vi.fn() }
  const statuses: RealtimeStatus[] = []
  const toolCalls: Harness['toolCalls'] = []
  const errors: RealtimeSessionError[] = []
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
    callbacks: {
      onStatusChange: s => statuses.push(s),
      onToolCall: c => toolCalls.push(c),
      onError: e => errors.push(e),
      onUserSpeechStarted: () => {
        userSpeechStarts += 1
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

  it('pushes session config then the native greeting exactly once on data-channel open', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()

    const sent = h.pc.dc!.parsedSent()
    expect(sent[0].type).toBe('session.update')
    expect(sent[0].session.model).toBe('gpt-realtime-2.1')
    expect(sent[0].session.audio.output.voice).toBe('marin')
    expect(sent[0].session.reasoning).toEqual({ effort: 'minimal' })
    expect(sent[0].session.audio.input.turn_detection.type).toBe('semantic_vad')
    expect(sent[0].session.tools[0].name).toBe('review_projects')
    expect(sent[0].session.tools[1].name).toBe('use_jarvis')

    expect(sent[1].type).toBe('response.create')
    expect(sent[1].response.instructions).toContain('Ada')
    expect(sent[1].response.instructions.toLowerCase()).not.toContain('hey jarvis')

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

  it('reflects native barge-in: user speech flips status back to listening', async () => {
    const h = makeHarness()
    await h.session.connect()
    h.pc.dc!.open()

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

    h.session.setMuted(true)
    expect(h.mic.track.enabled).toBe(false)
    expect(h.session.isMuted()).toBe(true)
    expect(h.pc.closed).toBe(false)

    h.session.setMuted(false)
    expect(h.mic.track.enabled).toBe(true)
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
})
