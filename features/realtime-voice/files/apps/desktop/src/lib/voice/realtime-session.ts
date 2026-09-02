// OpenAI Realtime WebRTC transport for JARVIS Desktop.
//
// A single persistent browser speech-to-speech session: the microphone track
// stays live, the remote model audio plays straight off the peer connection,
// and semantic VAD creates turns and interrupts responses natively. No local
// silence timer, no Whisper, no ElevenLabs in this path.
//
// The class is framework-agnostic and its browser dependencies (token mint,
// getUserMedia, RTCPeerConnection, SDP fetch, audio element) are injectable so
// the whole connect / tool-bridge / teardown flow is unit-testable without a
// live WebRTC stack.

import type { RealtimeTokenResponse } from '@/types/hermes'

import {
  buildGreetingResponseEvent,
  buildSessionUpdateEvent,
  nextRealtimeGreeting,
  REALTIME_MODEL,
  type RealtimeSessionConfigOptions,
  ASK_JUDGMENT_TOOL_NAME,
  BUILD_MESSAGE_TOOL_NAME,
  BUILD_STATUS_TOOL_NAME,
  CANCEL_TASK_TOOL_NAME,
  CLEAR_DISPLAY_TOOL_NAME,
  LOOK_AT_SCREEN_TOOL_NAME,
  SET_PROJECT_FIELD_TOOL_NAME,
  START_BUILD_TOOL_NAME,
  CREATE_PROJECT_TOOL_NAME,
  DELEGATE_TASK_TOOL_NAME,
  OPEN_APP_TOOL_NAME,
  OPEN_URL_TOOL_NAME,
  SHOW_DETAIL_TOOL_NAME,
  REVIEW_PROJECTS_TOOL_NAME,
  SHOW_PROJECT_TOOL_NAME,
  SHOW_PROJECTS_TOOL_NAME,
  USE_JARVIS_TOOL_NAME
} from './realtime-config'

const DEFAULT_SDP_BASE_URL = 'https://api.openai.com/v1/realtime/calls'

/** Longest the greeting may hold the first turn before the mic opens anyway. */
const FIRST_TURN_CAP_MS = 6000

/** WebRTC / setup failure categories the hook uses to decide fallback + copy. */
export type RealtimeErrorCode =
  | 'no-token' // ephemeral mint failed / returned nothing usable
  | 'no-mic' // microphone denied or unavailable
  | 'webrtc' // RTCPeerConnection / SDP negotiation failed
  | 'endpoint' // SDP POST to OpenAI failed
  | 'unsupported' // WebRTC not available in this runtime

export class RealtimeSessionError extends Error {
  code: RealtimeErrorCode

  constructor(code: RealtimeErrorCode, message: string) {
    super(message)
    this.name = 'RealtimeSessionError'
    this.code = code
  }
}

export type RealtimeStatus = 'idle' | 'connecting' | 'listening' | 'thinking' | 'speaking'

export interface RealtimeToolCall {
  callId: string
  name: string
  arguments: Record<string, unknown>
}

export interface RealtimeSessionCallbacks {
  onStatusChange?: (status: RealtimeStatus) => void
  onError?: (error: RealtimeSessionError) => void
  /** Fired at most once per Realtime function call (deduped by call_id). */
  onToolCall?: (call: RealtimeToolCall) => void
  /** Trace line for the wake/greeting seam (the desktop log captures it). */
  onTrace?: (line: string) => void
  /** Mic input level (0..1), for the listening indicator. */
  onLevel?: (level: number) => void
  /** Assistant OUTPUT level (0..1) — the voice the user hears. */
  onOutputLevel?: (level: number) => void
  /** Completed transcription of a user utterance (stop-word enforcement). */
  onUserTranscript?: (transcript: string) => void
  /** User started speaking — used to reflect native barge-in in the UI. */
  onUserSpeechStarted?: () => void
  /** The peer connection dropped (network / session-max). `expired` is true on
   *  a clean far-side close, false on an error drop. */
  onClose?: (info: { expired: boolean }) => void
}

type BrowserAudioContext = typeof AudioContext

export interface RealtimeSessionDeps {
  /** Mint the ephemeral secret (backend-scoped). */
  mintToken: (overrides?: { model?: string; voice?: string }) => Promise<RealtimeTokenResponse>
  callbacks: RealtimeSessionCallbacks
  config?: RealtimeSessionConfigOptions
  /** Ask Electron for OS mic permission before getUserMedia (mirrors the recorder). */
  requestMicAccess?: () => Promise<boolean>
  getUserMedia?: (constraints: MediaStreamConstraints) => Promise<MediaStream>
  createPeerConnection?: () => RTCPeerConnection
  createAudioElement?: () => HTMLAudioElement
  sdpFetch?: typeof fetch
  sdpBaseUrl?: string
  /** Suppress the native launch greeting when the data channel opens. Set on a
   *  transport RENEWAL (50-minute reconnect / far-side drop recovery) so the
   *  rotating launch greeting is spoken exactly once per renderer launch and is
   *  never replayed on a reconnect the user never asked for. */
  suppressGreeting?: boolean
}

/** Coerce arbitrary function-call arguments (string JSON or object) to a record. */
function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>
  }

  if (typeof raw !== 'string' || !raw.trim()) {
    return {}
  }

  try {
    const parsed = JSON.parse(raw)

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

const DISPLAY_TOOL_NAMES = new Set<string>([SHOW_PROJECTS_TOOL_NAME, SHOW_PROJECT_TOOL_NAME, SHOW_DETAIL_TOOL_NAME, CREATE_PROJECT_TOOL_NAME, CLEAR_DISPLAY_TOOL_NAME])

const ACTION_TOOL_NAMES = new Set<string>([OPEN_APP_TOOL_NAME, OPEN_URL_TOOL_NAME, DELEGATE_TASK_TOOL_NAME, CANCEL_TASK_TOOL_NAME])
// P5.1: sight, build sessions, priority reasoning.
const P51_TOOL_NAMES = new Set<string>([LOOK_AT_SCREEN_TOOL_NAME, START_BUILD_TOOL_NAME, BUILD_STATUS_TOOL_NAME, BUILD_MESSAGE_TOOL_NAME, SET_PROJECT_FIELD_TOOL_NAME, ASK_JUDGMENT_TOOL_NAME])

export class RealtimeVoiceSession {
  private readonly deps: RealtimeSessionDeps
  private config: RealtimeSessionConfigOptions

  private pc: RTCPeerConnection | null = null
  private dc: RTCDataChannel | null = null
  private micStream: MediaStream | null = null
  private remoteAudio: HTMLAudioElement | null = null
  private transcriptAccum = ''
  private outputAudioContext: AudioContext | null = null
  private outputSink: GainNode | null = null
  private meterTrack: MediaStreamTrack | null = null
  private outputMeterFrame = 0
  private audioContext: AudioContext | null = null
  private meterRaf: number | null = null

  private status: RealtimeStatus = 'idle'
  private muted = false
  private closed = false
  private started = false
  private greetingPending = false
  private greetingSent = false
  // FIRST-TURN OWNERSHIP. The greeting owns the first turn: the mic track is
  // attached but DISABLED until the greeting's response is done (or a short
  // cap), and the input buffer is cleared right before the greeting. Without
  // this, semantic VAD (create_response: true) turns whatever was in the
  // buffer when the session went live — a repeated "hey jarvis" during a
  // slow cold connect — into a competing response that overlaps the greeting:
  // two voices at once. A renewal (suppressGreeting) has no gate.
  private firstTurnGate = false
  private greetingAwaitingId = false
  private greetingResponseId: null | string = null
  private firstTurnTimer: null | number = null
  /** call_ids already dispatched to the bridge — enforces exactly-once. */
  private readonly handledToolCalls = new Set<string>()

  constructor(deps: RealtimeSessionDeps) {
    this.deps = deps
    this.config = deps.config ?? {}
  }

  getStatus(): RealtimeStatus {
    return this.status
  }

  isMuted(): boolean {
    return this.muted
  }

  private setStatus(next: RealtimeStatus): void {
    if (this.closed || this.status === next) {
      return
    }

    this.status = next
    this.deps.callbacks.onStatusChange?.(next)
  }

  /**
   * Establish the persistent WebRTC session end-to-end: mint the ephemeral
   * secret, open the mic, negotiate SDP with OpenAI, wire the data channel, and
   * (once open) push the session config and trigger the native greeting.
   * Rejects with a {@link RealtimeSessionError} on any setup failure so the
   * caller can fall back to the chained voice path.
   */
  async connect(): Promise<void> {
    if (this.started) {
      return
    }

    this.started = true
    this.setStatus('connecting')

    const RTCPeerConnectionCtor =
      this.deps.createPeerConnection ?? (typeof RTCPeerConnection !== 'undefined' ? () => new RTCPeerConnection() : null)

    if (!RTCPeerConnectionCtor) {
      throw this.fail('unsupported', 'WebRTC is not available in this runtime.')
    }

    // 1) Ephemeral secret. Never touches the standing key.
    let token: RealtimeTokenResponse

    try {
      token = await this.deps.mintToken({ model: this.config.model, voice: this.config.voice })
    } catch (error) {
      throw this.fail('no-token', error instanceof Error ? error.message : 'Could not mint a Realtime token.')
    }

    if (this.closed) {
      return
    }

    if (!token?.value) {
      throw this.fail('no-token', 'The Realtime token response carried no ephemeral secret.')
    }

    // 2) Microphone — kept live for the whole session.
    if (this.deps.requestMicAccess) {
      const permitted = await this.deps.requestMicAccess().catch(() => true)

      if (permitted === false) {
        throw this.fail('no-mic', 'Microphone access was denied.')
      }
    }

    const getUserMedia =
      this.deps.getUserMedia ??
      (typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia
        ? (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints)
        : null)

    if (!getUserMedia) {
      throw this.fail('unsupported', 'Microphone capture is not available in this runtime.')
    }

    try {
      this.micStream = await getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } })
    } catch (error) {
      throw this.fail('no-mic', error instanceof Error ? error.message : 'Could not open the microphone.')
    }

    if (this.closed) {
      this.teardownMedia()

      return
    }

    // 3) Peer connection + tracks + data channel.
    try {
      const pc = RTCPeerConnectionCtor()
      this.pc = pc

      pc.onconnectionstatechange = () => this.handleConnectionStateChange()
      pc.ontrack = event => this.handleRemoteTrack(event)

      const [micTrack] = this.micStream.getAudioTracks()

      this.firstTurnGate = !this.deps.suppressGreeting

      if (micTrack) {
        micTrack.enabled = !this.muted && !this.firstTurnGate
        pc.addTrack(micTrack, this.micStream)
      }

      this.trace(this.firstTurnGate ? 'mic attached, gated until the greeting is done' : 'mic attached (renewal — no greeting, no gate)')

      const dc = pc.createDataChannel('oai-events')
      this.dc = dc
      dc.onopen = () => this.handleDataChannelOpen()
      dc.onmessage = event => this.handleServerEvent(event.data)

      this.startMeter()

      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)

      const answerSdp = await this.exchangeSdp(offer.sdp ?? '', token)

      if (this.closed) {
        return
      }

      await pc.setRemoteDescription({ type: 'answer', sdp: answerSdp })
    } catch (error) {
      if (error instanceof RealtimeSessionError) {
        throw error
      }

      throw this.fail('webrtc', error instanceof Error ? error.message : 'WebRTC negotiation failed.')
    }
  }

  private async exchangeSdp(offerSdp: string, token: RealtimeTokenResponse): Promise<string> {
    const doFetch = this.deps.sdpFetch ?? (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null)

    if (!doFetch) {
      throw this.fail('endpoint', 'No fetch implementation for the SDP exchange.')
    }

    const base = this.deps.sdpBaseUrl ?? DEFAULT_SDP_BASE_URL
    const url = `${base}?model=${encodeURIComponent(token.model || this.config.model || REALTIME_MODEL)}`

    let response: Response

    try {
      response = await doFetch(url, {
        method: 'POST',
        body: offerSdp,
        headers: {
          Authorization: `Bearer ${token.value}`,
          'Content-Type': 'application/sdp'
        }
      })
    } catch (error) {
      throw this.fail('endpoint', error instanceof Error ? error.message : 'The Realtime SDP request failed.')
    }

    if (!response.ok) {
      throw this.fail('endpoint', `The Realtime SDP endpoint returned HTTP ${response.status}.`)
    }

    const answerSdp = await response.text()

    if (!answerSdp) {
      throw this.fail('endpoint', 'The Realtime SDP endpoint returned an empty answer.')
    }

    return answerSdp
  }

  private handleRemoteTrack(event: RTCTrackEvent): void {
    if (this.closed) {
      return
    }

    const [stream] = event.streams

    if (!stream) {
      return
    }

    const audio = this.deps.createAudioElement?.() ?? (typeof Audio !== 'undefined' ? new Audio() : null)

    if (!audio) {
      return
    }

    this.remoteAudio = audio
    audio.autoplay = true
    audio.srcObject = stream
    this.startOutputMeter(stream)
    void audio.play?.().catch(() => undefined)
  }

  private handleDataChannelOpen(): void {
    if (this.closed) {
      return
    }

    // Push the behavioral config first. The greeting waits for the server's
    // session.updated acknowledgement so response.create cannot race the
    // instructions/voice update and get rejected or run with stale defaults.
    this.send(buildSessionUpdateEvent(this.config))
    this.greetingPending = !this.deps.suppressGreeting

    this.setStatus('listening')
  }

  private handleServerEvent(raw: unknown): void {
    if (this.closed || typeof raw !== 'string') {
      return
    }

    let event: Record<string, unknown>

    try {
      event = JSON.parse(raw)
    } catch {
      return
    }

    const type = typeof event.type === 'string' ? event.type : ''

    switch (type) {
      case 'session.updated':
        if (this.greetingPending && !this.greetingSent) {
          this.greetingPending = false
          this.greetingSent = true
          // Nothing captured before the config landed may become a turn.
          this.send({ type: 'input_audio_buffer.clear' })
          this.send(buildGreetingResponseEvent(nextRealtimeGreeting(this.config)))
          this.greetingAwaitingId = true
          this.trace('greeting response.create sent (single utterance source)')
          this.firstTurnTimer = window.setTimeout(() => this.releaseFirstTurn('cap reached'), FIRST_TURN_CAP_MS)
        }

        break

      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = String((event as { transcript?: string }).transcript ?? '')

        this.transcriptAccum = ''
        this.trace('user transcript: "' + transcript.slice(0, 60) + '"')
        this.handleTranscriptText(transcript)

        break
      }

      // Interim delta: accumulate and run stop detection on the partial text so
      // "stop" halts BEFORE the completed event (and survives if completed is
      // ever renamed away).
      case 'conversation.item.input_audio_transcription.delta': {
        const delta = String((event as { delta?: string }).delta ?? '')

        this.transcriptAccum = (this.transcriptAccum + ' ' + delta).slice(-200)
        this.trace('transcription.delta (interim): "' + this.transcriptAccum.slice(-40) + '"')
        this.handleTranscriptText(this.transcriptAccum)

        break
      }

      case 'input_audio_buffer.speech_started':
        if (this.firstTurnGate) {
          this.trace('speech_started while the greeting owns the turn (mic gated) — not a barge-in')

          break
        }

        // Native barge-in: the model auto-truncates its unplayed output. Reflect
        // the switch back to listening for the UI.
        this.deps.callbacks.onUserSpeechStarted?.()
        this.setStatus('listening')

        break

      case 'response.created': {
        const id = String((event as { response?: { id?: string } }).response?.id ?? '')

        if (this.greetingAwaitingId) {
          this.greetingAwaitingId = false
          this.greetingResponseId = id || null
          this.trace('greeting response ' + (id || '(no id)') + ' created')
        } else if (this.firstTurnGate) {
          this.trace('second response ' + (id || '(no id)') + ' created while the greeting owns the turn')
        }

        this.setStatus('thinking')

        break
      }

      case 'response.output_audio.delta':

      case 'response.audio.delta':

      case 'output_audio_buffer.started':
        this.setStatus('speaking')

        break

      case 'response.done': {
        const id = String((event as { response?: { id?: string } }).response?.id ?? '')

        if (this.firstTurnGate && (!this.greetingResponseId || id === this.greetingResponseId)) {
          this.releaseFirstTurn('greeting done')
        }

        this.handleResponseDone(event)
        this.setStatus('listening')

        break
      }

      case 'error':
        // A non-fatal server error (e.g. a rejected response.create) — surface
        // it but keep the session alive; the transport itself is still up.
        if (this.firstTurnGate) {
          this.releaseFirstTurn('server error')
        }

        this.setStatus('listening')

        break

      default:
        if (/transcription|response\.cancel|audio_buffer|speech_|interrupt/i.test(type)) {
          this.trace('event: ' + type)
        }

        // Drift shield: if upstream renames the transcription event, still run
        // stop detection on any transcription-shaped event that carries text.
        if (/transcription/i.test(type)) {
          const anyEvent = event as { transcript?: string; delta?: string }
          const text = String(anyEvent.transcript ?? anyEvent.delta ?? '')

          if (text) {
            this.handleTranscriptText(text)
          }
        }

        break
    }
  }

  /** Extract a supported function call from a response.done output, once. */
  private handleResponseDone(event: Record<string, unknown>): void {
    const response = event.response

    if (!response || typeof response !== 'object') {
      return
    }

    const output = (response as { output?: unknown }).output

    if (!Array.isArray(output)) {
      return
    }

    for (const item of output) {
      if (!item || typeof item !== 'object') {
        continue
      }

      const record = item as Record<string, unknown>

      if (
        record.type !== 'function_call' ||
        (record.name !== USE_JARVIS_TOOL_NAME &&
          record.name !== REVIEW_PROJECTS_TOOL_NAME &&
          !DISPLAY_TOOL_NAMES.has(String(record.name)) &&
          !ACTION_TOOL_NAMES.has(String(record.name)) &&
          !P51_TOOL_NAMES.has(String(record.name)))
      ) {
        continue
      }

      const callId = typeof record.call_id === 'string' ? record.call_id : ''

      if (!callId || this.handledToolCalls.has(callId)) {
        continue // exactly-once: ignore duplicates / id-less calls
      }

      this.handledToolCalls.add(callId)
      this.deps.callbacks.onToolCall?.({
        callId,
        name: String(record.name),
        arguments: parseToolArguments(record.arguments)
      })
    }
  }

  /** Refresh bounded foreground metadata without reconnecting or ending voice. */
  updateForegroundContext(context: string): void {
    const foregroundContext = context.trim()

    if ((this.config.foregroundContext ?? '').trim() === foregroundContext) {
      return
    }

    this.config = { ...this.config, foregroundContext }
    this.send(buildSessionUpdateEvent(this.config))
  }

  /**
   * Return the JARVIS agent's final result to the Realtime model as this call's
   * function_call_output, then ask it to speak the result naturally.
   */
  sendToolOutput(callId: string, output: string): void {
    if (this.closed || !callId) {
      return
    }

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output
      }
    })
    this.send({ type: 'response.create' })
  }

  /**
   * Inject an out-of-band system update (e.g. a delegated task finishing) into
   * the live conversation and ask the model to relay it aloud. No call_id —
   * this is not a tool response; it arrives on its own, mid-conversation.
   */
  speakSystemUpdate(text: string): void {
    const update = text.trim()

    if (this.closed || !update) {
      return
    }

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: update }]
      }
    })
    this.send({ type: 'response.create' })
  }

  /**
   * Put an out-of-band note into the conversation as CONTEXT the model can use
   * on its next turn, WITHOUT triggering speech (no response.create). Used to
   * keep the voice model's context in sync with whatever project is on the
   * cockpit stage, so "read me this / what's the blocker" answers from the same
   * data that is on screen.
   */
  noteContext(text: string): void {
    const note = text.trim()

    if (this.closed || !note) {
      return
    }

    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'system',
        content: [{ type: 'input_text', text: note }]
      }
    })
  }

  /** Hand the turn to the user: open the mic (unless muted). Idempotent. */
  private releaseFirstTurn(reason: string): void {
    if (!this.firstTurnGate) {
      return
    }

    this.firstTurnGate = false
    this.greetingAwaitingId = false

    if (this.firstTurnTimer !== null) {
      window.clearTimeout(this.firstTurnTimer)
      this.firstTurnTimer = null
    }

    for (const track of this.micStream?.getAudioTracks() ?? []) {
      track.enabled = !this.muted
    }

    this.trace('first turn released (' + reason + ') — mic ' + (this.muted ? 'stays muted' : 'open'))
  }

  /** True while the greeting owns the first turn (mic gated). */
  isFirstTurnGated(): boolean {
    return this.firstTurnGate
  }

  private trace(line: string): void {
    try {
      this.deps.callbacks.onTrace?.(line)
    } catch {
      // tracing must never break the voice path
    }
  }

  /** Enable/disable the live mic track without tearing the session down. The
   *  first-turn gate wins while the greeting is playing. */
  setMuted(muted: boolean): void {
    this.muted = muted

    for (const track of this.micStream?.getAudioTracks() ?? []) {
      track.enabled = !muted && !this.firstTurnGate
    }

    if (muted) {
      this.deps.callbacks.onLevel?.(0)
    }
  }

  /** Cancel the in-flight response (Stop button while the model is speaking). */
  /** One place all transcription paths (completed / delta / renamed) funnel
   *  through so stop-word enforcement can never be bypassed by an event rename. */
  private handleTranscriptText(text: string): void {
    if (text) {
      this.deps.callbacks.onUserTranscript?.(text)
    }
  }

  cancelResponse(): void {
    if (this.closed) {
      return
    }

    // Stop GENERATION and flush already-buffered output audio. On the WebRTC
    // GA surface response.cancel alone leaves buffered audio playing, so the
    // spoken "stop" felt ignored — output_audio_buffer.clear halts it now.
    this.send({ type: 'response.cancel' })
    this.send({ type: 'output_audio_buffer.clear' })
    this.trace('cancelResponse: response.cancel + output_audio_buffer.clear sent')
    this.setStatus('listening')
  }

  private send(event: unknown): void {
    if (this.dc?.readyState === 'open') {
      this.dc.send(JSON.stringify(event))
    }
  }

  private handleConnectionStateChange(): void {
    const state = this.pc?.connectionState

    if (this.closed || !state) {
      return
    }

    if (state === 'failed') {
      this.deps.callbacks.onClose?.({ expired: false })
    } else if (state === 'disconnected' || state === 'closed') {
      this.deps.callbacks.onClose?.({ expired: true })
    }
  }

  private startOutputMeter(stream: MediaStream): void {
    // P3: the orb must move when JARVIS speaks. Same RMS meter as the mic,
    // pointed at the REMOTE (assistant) stream. Fully guarded; audio is
    // untouched (analyser in parallel, element remains the audible path).
    const audioWindow = window as Window & { webkitAudioContext?: BrowserAudioContext }
    const AudioContextCtor = window.AudioContext || audioWindow.webkitAudioContext

    if (!AudioContextCtor) {
      return
    }

    try {
      const context = new AudioContextCtor()
      const analyser = context.createAnalyser()
      // Meter a CLONE of the track, never the audible one. The <audio> element
      // plays the original track; WebAudio (analyser + zero-gain pull) touches
      // only the clone. Nothing in the visual/meter layer can perturb playback.
      let meterStream = stream

      try {
        const audible = stream.getAudioTracks?.()[0]

        if (audible?.clone && typeof MediaStream !== 'undefined') {
          this.meterTrack = audible.clone()
          meterStream = new MediaStream([this.meterTrack])
        }
      } catch {
        meterStream = stream
      }

      const source = context.createMediaStreamSource(meterStream)

      analyser.fftSize = 256
      const data = new Uint8Array(analyser.fftSize)
      source.connect(analyser)
      // Chromium's analyser reads all-silence from a remote WebRTC stream
      // unless the graph is pulled to a destination. A zero-gain sink pulls it
      // WITHOUT adding audible signal (the <audio> element is the audible
      // path). Resume in case the context started suspended (no gesture here).
      const sink = context.createGain()

      sink.gain.value = 0
      analyser.connect(sink)
      sink.connect(context.destination)
      void context.resume?.().catch(() => undefined)
      this.outputAudioContext = context
      this.outputSink = sink

      const tick = () => {
        if (!this.outputAudioContext) {
          return
        }

        analyser.getByteTimeDomainData(data)

        let sum = 0

        for (const value of data) {
          const centered = value - 128
          sum += centered * centered
        }

        this.deps.callbacks.onOutputLevel?.(Math.min(1, Math.sqrt(sum / data.length) / 42))
        this.outputMeterFrame = window.requestAnimationFrame(tick)
      }

      this.outputMeterFrame = window.requestAnimationFrame(tick)
    } catch {
      // metering is optional
    }
  }

  private startMeter(): void {
    if (!this.micStream) {
      return
    }

    const audioWindow = window as Window & { webkitAudioContext?: BrowserAudioContext }
    const AudioContextCtor = window.AudioContext || audioWindow.webkitAudioContext

    if (!AudioContextCtor) {
      return
    }

    try {
      const audioContext = new AudioContextCtor()
      const analyser = audioContext.createAnalyser()
      const source = audioContext.createMediaStreamSource(this.micStream)

      analyser.fftSize = 256
      const data = new Uint8Array(analyser.fftSize)
      source.connect(analyser)
      this.audioContext = audioContext

      const tick = () => {
        if (this.closed) {
          return
        }

        analyser.getByteTimeDomainData(data)

        let sum = 0

        for (const value of data) {
          const centered = value - 128
          sum += centered * centered
        }

        const rms = Math.sqrt(sum / data.length)
        const normalized = this.muted ? 0 : Math.min(1, rms / 42)
        this.deps.callbacks.onLevel?.(normalized)
        this.meterRaf = window.requestAnimationFrame(tick)
      }

      tick()
    } catch {
      // Metering is cosmetic — a failure here must not break the session.
    }
  }

  private teardownMedia(): void {
    if (this.meterRaf !== null) {
      window.cancelAnimationFrame(this.meterRaf)
      this.meterRaf = null
    }

    window.cancelAnimationFrame(this.outputMeterFrame)
    void this.outputAudioContext?.close().catch(() => undefined)
    this.outputAudioContext = null
    this.outputSink = null

    if (this.meterTrack) {
      try { this.meterTrack.stop() } catch { /* best effort */ }
      this.meterTrack = null
    }

    void this.audioContext?.close().catch(() => undefined)
    this.audioContext = null

    for (const track of this.micStream?.getTracks() ?? []) {
      track.stop()
    }

    this.micStream = null

    if (this.firstTurnTimer !== null) {
      window.clearTimeout(this.firstTurnTimer)
      this.firstTurnTimer = null
    }

    if (this.remoteAudio) {
      try {
        this.remoteAudio.pause?.()
      } catch {
        // ignore
      }

      this.remoteAudio.srcObject = null
      this.remoteAudio = null
    }
  }

  /** Instant audible halt (<300ms): mute and pause the remote audio element
   *  synchronously, cancel the in-flight response, then close. */
  hardStop(): void {
    this.trace('hardStop: begin')

    // 1) LOCAL silence FIRST — this does NOT depend on the realtime API and
    //    cannot be defeated by an upstream drift: mute + zero-volume + pause the
    //    element, zero the output meter's gain, and stop the inbound track. The
    //    user hears silence NOW.
    this.silenceOutputNow()

    // 2) Then cancel + flush server-side to end the turn cleanly.
    try {
      this.cancelResponse()
    } catch {
      // ignore — closing anyway
    }

    this.trace('hardStop: audio silenced, closing session')
    this.close()
  }

  /** Instant, API-independent local cutoff of assistant audio. Safe to call
   *  from the stop word, the orb click, and Esc. Idempotent + fully guarded. */
  silenceOutputNow(): void {
    try {
      if (this.outputSink) {
        this.outputSink.gain.value = 0
      }
    } catch {
      // meter sink is optional
    }

    if (this.remoteAudio) {
      try {
        this.remoteAudio.muted = true
        this.remoteAudio.volume = 0
        this.remoteAudio.pause?.()
        const stream = this.remoteAudio.srcObject as MediaStream | null

        for (const track of stream?.getTracks?.() ?? []) {
          try { track.stop() } catch { /* best effort */ }
        }
      } catch {
        // best effort — close() still tears everything down
      }
    }
  }

  private fail(code: RealtimeErrorCode, message: string): RealtimeSessionError {
    const error = new RealtimeSessionError(code, message)
    this.close()
    this.deps.callbacks.onError?.(error)

    return error
  }

  /**
   * Tear the whole session down: data channel, peer connection, mic + remote
   * audio tracks, meter timer, and any pending tool bookkeeping. Idempotent.
   */
  close(): void {
    if (this.closed) {
      return
    }

    this.closed = true

    if (this.dc) {
      this.dc.onopen = null
      this.dc.onmessage = null

      try {
        this.dc.close()
      } catch {
        // ignore
      }

      this.dc = null
    }

    if (this.pc) {
      this.pc.onconnectionstatechange = null
      this.pc.ontrack = null

      try {
        this.pc.close()
      } catch {
        // ignore
      }

      this.pc = null
    }

    this.teardownMedia()
    this.handledToolCalls.clear()
    this.status = 'idle'
  }
}
