// Voice amplitude events — the analyser tap the JARVIS HUD orb consumes.
//
// Two directions, one event shape, emitted on the plugin event surface
// (`emitGatewayEvent` → `host.onEvent`), so a plugin subscribes with
// `host.onEvent('voice.amplitude', cb)` and needs no imports from app
// internals:
//
//   { type: 'voice.amplitude', payload: { source: 'mic' | 'out', level } }
//
// `level` is 0..1 RMS-normalized. Emission is throttled per source (~30Hz):
// enough for fluid motion, cheap enough to never matter. When nothing taps
// audio (voice idle, no mic), no events flow — consumers degrade to their
// own synthesized animation, by contract.
import { emitGatewayEvent } from '@/contrib/events'

const EMIT_INTERVAL_MS = 33

const lastEmit: Record<string, number> = {}

/** Throttled amplitude emit. Safe to call at any rate from rAF/tick loops. */
export function emitAmplitude(source: 'mic' | 'out', level: number): void {
  const now = Date.now()

  if (now - (lastEmit[source] ?? 0) < EMIT_INTERVAL_MS) {
    return
  }

  lastEmit[source] = now
  emitGatewayEvent({
    payload: { level: Math.max(0, Math.min(1, level)), source },
    type: 'voice.amplitude'
  })
}

/**
 * Attach an output-amplitude analyser to a playback `<audio>` element.
 * Samples while the element plays, emits `source: 'out'`, and tears the
 * WebAudio graph down when playback ends or errors. Fully guarded — any
 * failure (no AudioContext, CSP, detached element) leaves playback itself
 * untouched; the orb just falls back to its synthesized pulse.
 */
export function attachElementAmplitude(audio: HTMLAudioElement): void {
  try {
    const Ctor =
      window.AudioContext || (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext

    if (!Ctor) {
      return
    }

    const context = new Ctor()
    const analyser = context.createAnalyser()

    analyser.fftSize = 256
    const data = new Uint8Array(analyser.fftSize)
    const source = context.createMediaElementSource(audio)

    // Analyser sits in PARALLEL with the destination — audible path unchanged.
    source.connect(analyser)
    source.connect(context.destination)

    let raf = 0

    const sample = () => {
      analyser.getByteTimeDomainData(data)

      let sum = 0

      for (const value of data) {
        const centered = value - 128
        sum += centered * centered
      }

      emitAmplitude('out', Math.min(1, Math.sqrt(sum / data.length) / 42))
      raf = window.requestAnimationFrame(sample)
    }

    const stop = () => {
      window.cancelAnimationFrame(raf)
      emitAmplitude('out', 0)
      void context.close().catch(() => undefined)
    }

    audio.addEventListener('ended', stop, { once: true })
    audio.addEventListener('error', stop, { once: true })
    raf = window.requestAnimationFrame(sample)
  } catch {
    // Tap is optional by design; playback must never pay for it.
  }
}
