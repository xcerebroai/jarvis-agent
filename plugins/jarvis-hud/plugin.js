/**
 * JARVIS HUD — a living presence, not a widget.
 *
 * Particle sphere of electric-blue light on deep black: breathing at idle,
 * tightening when listening, accelerating with orbiting bands when thinking,
 * blooming with voice when speaking. Ringed reticle: thin rotating tick ring,
 * slow counter-rotating orbit line. All state morphs are smoothed (~380ms
 * time constant) — nothing ever snaps.
 *
 * Runtime plugin: plain ESM, imports only '@hermes/plugin-sdk' and react
 * (the loader's allowlist). Installed by the overlay's apply.sh into
 * `<hermes home>/desktop-plugins/jarvis-hud/plugin.js`.
 *
 * Amplitude contract (one `amplitudeSource` seam):
 *   - REAL feed: `voice.amplitude` events from the realtime-voice feature's
 *     analyser taps ({source:'mic'|'out', level:0..1}). Used whenever fresh.
 *   - SYNTHESIZED fallback: an envelope kicked by `message.delta` cadence and
 *     decayed per frame. Drives the same speaking bloom, so the orb is fully
 *     alive on a text-only, keyless install — and the moment real events
 *     appear the source switches without a seam.
 */
import { host, PALETTE_AREA, ROUTES_AREA, SIDEBAR_NAV_AREA, useValue } from '@hermes/plugin-sdk'
import { useEffect, useRef } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// --- amplitudeSource: the single seam between real and synthesized motion ---
const REAL_FEED_FRESH_MS = 600

function createAmplitudeSource() {
  const state = {
    envelope: 0, // synthesized: kicked by deltas, decayed per frame
    lastKickAt: 0,
    lastRealAt: { mic: 0, out: 0 },
    real: { mic: 0, out: 0 }
  }

  return {
    /** Feed one real analyser event. */
    feed(source, level) {
      state.real[source] = level
      state.lastRealAt[source] = performance.now()
    },
    /** Synthesized kick — call on each streamed delta. */
    kick() {
      const now = performance.now()
      // Cadence-shaped: rapid deltas sustain a strong envelope; a straggler
      // after a lull re-blooms gently rather than spiking.
      const sinceLast = now - state.lastKickAt
      state.lastKickAt = now
      const strength = sinceLast < 220 ? 0.85 : 0.55
      state.envelope = Math.min(1, state.envelope * 0.55 + strength)
    },
    /** Per-frame level for a direction; prefers a fresh real feed. */
    level(source, dtMs) {
      const now = performance.now()

      if (now - state.lastRealAt[source] < REAL_FEED_FRESH_MS) {
        return { level: state.real[source], real: true }
      }

      if (source === 'out') {
        // Exponential decay keeps the synthesized bloom organic between kicks.
        state.envelope *= Math.exp(-dtMs / 260)

        return { level: state.envelope, real: false }
      }

      return { level: 0, real: false }
    }
  }
}

// --- orb state machine ------------------------------------------------------
// idle | listening | thinking | speaking. Visual params live in PRESETS;
// the render loop lerps a live params object toward the active preset.
const PRESETS = {
  idle: { band: 0, breathAmp: 0.032, breathHz: 0.24, glow: 0.42, hueShift: 0, jitter: 0.014, radius: 1, spin: 0.1 },
  listening: {
    band: 0,
    breathAmp: 0.014,
    breathHz: 0.55,
    glow: 0.58,
    hueShift: 14,
    jitter: 0.02,
    radius: 0.87,
    spin: 0.16
  },
  speaking: { band: 1, breathAmp: 0.02, breathHz: 0.4, glow: 0.85, hueShift: -4, jitter: 0.02, radius: 1.06, spin: 0.22 },
  thinking: { band: 3, breathAmp: 0.02, breathHz: 0.9, glow: 0.66, hueShift: 6, jitter: 0.03, radius: 0.96, spin: 0.85 }
}

const STATE_LABEL = { idle: 'standing by', listening: 'listening', speaking: 'speaking', thinking: 'thinking' }
const LISTEN_HOLD_MS = 12_000
const SPEAK_HOLD_MS = 1400
const THINK_HOLD_MS = 30_000

// Fibonacci-sphere particle field — even coverage, no pole clustering.
function buildParticles(count) {
  const pts = []
  const golden = Math.PI * (3 - Math.sqrt(5))

  for (let i = 0; i < count; i++) {
    const y = 1 - (i / (count - 1)) * 2
    const r = Math.sqrt(1 - y * y)
    const theta = golden * i

    pts.push({
      phase: Math.random() * Math.PI * 2,
      wobble: 0.55 + Math.random() * 0.45,
      x: Math.cos(theta) * r,
      y,
      z: Math.sin(theta) * r
    })
  }

  return pts
}

function startOrb(canvas, tracker) {
  const ctx = canvas.getContext('2d')

  if (!ctx) {
    return () => undefined
  }

  const particles = buildParticles(880)
  const live = { ...PRESETS.idle }
  let rotY = 0
  let rotX = 0.35
  let reticle = 0
  let orbit = 0
  let bandStrength = 0
  let breathT = 0
  let last = performance.now()
  let raf = 0
  let disposed = false

  const lerp = (a, b, k) => a + (b - a) * k

  const frame = now => {
    if (disposed) {
      return
    }

    const dt = Math.min(64, now - last)
    last = now

    // Track CSS size × DPR every frame (cheap; handles pane resizes).
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight

    if (w < 40 || h < 40) {
      raf = window.requestAnimationFrame(frame)

      return
    }

    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
    }

    const mode = tracker.mode()
    const target = PRESETS[mode]
    // ~380ms time constant: every param glides, nothing snaps.
    const k = 1 - Math.exp(-dt / 380)

    for (const key of Object.keys(target)) {
      live[key] = lerp(live[key], target[key], k)
    }

    const out = tracker.amp.level('out', dt)
    const mic = tracker.amp.level('mic', dt)
    const voice = mode === 'speaking' ? out.level : mode === 'listening' ? mic.level : 0
    tracker.reportReal(mode === 'speaking' ? out.real : mode === 'listening' ? mic.real : false)

    breathT += (dt / 1000) * live.breathHz * Math.PI * 2
    rotY += (dt / 1000) * live.spin
    rotX = 0.35 + Math.sin(now / 9000) * 0.08
    reticle += dt / 14_000
    orbit -= dt / 23_000
    bandStrength = lerp(bandStrength, live.band > 0.5 ? 1 : 0, k)

    const cx = (w * dpr) / 2
    const cy = (h * dpr) / 2
    const base = (Math.min(w, h) / 2) * 0.52 * dpr
    const breath = 1 + Math.sin(breathT) * live.breathAmp
    const bloom = 1 + voice * 0.16
    const R = base * live.radius * breath * bloom

    ctx.setTransform(1, 0, 0, 1, 0, 0)
    ctx.clearRect(0, 0, canvas.width, canvas.height)

    // Deep-space backdrop glow.
    const glowR = R * (2.3 + voice * 0.5)
    const glow = ctx.createRadialGradient(cx, cy, R * 0.2, cx, cy, glowR)
    const glowA = live.glow * (0.5 + voice * 0.5)

    glow.addColorStop(0, `rgba(59, 130, 246, ${0.34 * glowA})`)
    glow.addColorStop(0.55, `rgba(37, 99, 235, ${0.1 * glowA})`)
    glow.addColorStop(1, 'rgba(2, 6, 16, 0)')
    ctx.fillStyle = glow
    ctx.fillRect(0, 0, canvas.width, canvas.height)

    ctx.globalCompositeOperation = 'lighter'

    // Luminous core — the light source the shell orbits.
    const core = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 0.72)

    core.addColorStop(0, `rgba(96, 165, 250, ${0.16 + live.glow * 0.14 + voice * 0.2})`)
    core.addColorStop(0.55, `rgba(59, 130, 246, ${0.07 + voice * 0.08})`)
    core.addColorStop(1, 'rgba(59, 130, 246, 0)')
    ctx.fillStyle = core
    ctx.beginPath()
    ctx.arc(cx, cy, R * 0.72, 0, Math.PI * 2)
    ctx.fill()

    // The sphere.
    const sinY = Math.sin(rotY)
    const cosY = Math.cos(rotY)
    const sinX = Math.sin(rotX)
    const cosX = Math.cos(rotX)
    const hue = 213 + live.hueShift

    for (const p of particles) {
      // Surface ripple: per-particle wobble scaled by jitter + voice.
      const ripple = 1 + Math.sin(breathT * 2 + p.phase) * (live.jitter + voice * 0.05) * p.wobble
      const x1 = p.x * cosY - p.z * sinY
      const z1 = p.x * sinY + p.z * cosY
      const y2 = p.y * cosX - z1 * sinX
      const z2 = p.y * sinX + z1 * cosX
      const persp = 1 / (1.65 - z2 * 0.62)
      const px = cx + x1 * R * ripple * persp
      const py = cy + y2 * R * ripple * persp
      const depth = (z2 + 1) / 2
      const alpha = 0.09 + depth * depth * (0.62 + voice * 0.35)
      const size = (0.7 + depth * 1.6) * dpr * (1 + voice * 0.25)

      ctx.fillStyle = `hsla(${hue}, 94%, ${60 + depth * 18 + p.wobble * 8}%, ${alpha})`
      ctx.beginPath()
      ctx.arc(px, py, size, 0, Math.PI * 2)
      ctx.fill()
    }

    // Thinking bands: tilted particle rings orbiting fast; fade via bandStrength.
    if (bandStrength > 0.02) {
      for (let b = 0; b < 3; b++) {
        const tilt = 0.5 + b * 0.62
        const speed = now / (700 - b * 140)
        const ringR = R * (1.04 + b * 0.09)
        const n = 42

        for (let i = 0; i < n; i++) {
          const a = (i / n) * Math.PI * 2 + speed
          const x = Math.cos(a) * ringR
          const z = Math.sin(a) * ringR * Math.cos(tilt)
          const y = Math.sin(a) * ringR * Math.sin(tilt) * 0.4
          const persp = 1 / (1.65 - (z / R) * 0.35)
          const depth = (z / ringR + 1) / 2
          const tail = i / n

          ctx.fillStyle = `hsla(${hue + 8}, 95%, 66%, ${bandStrength * tail * (0.12 + depth * 0.3)})`
          ctx.beginPath()
          ctx.arc(cx + x * persp, cy + y * persp, (0.6 + depth * 1.1) * dpr, 0, Math.PI * 2)
          ctx.fill()
        }
      }
    }

    ctx.globalCompositeOperation = 'source-over'

    // Reticle ring 1: thin rotating tick ring.
    const r1 = R * 1.32
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(reticle * Math.PI * 2)
    ctx.strokeStyle = `rgba(125, 180, 252, ${0.52 + voice * 0.25})`
    ctx.lineWidth = 1.1 * dpr

    for (let i = 0; i < 72; i++) {
      const a = (i / 72) * Math.PI * 2
      const long = i % 6 === 0
      const inner = r1 - (long ? 7 : 3) * dpr

      ctx.globalAlpha = long ? 0.8 : 0.4
      ctx.beginPath()
      ctx.moveTo(Math.cos(a) * inner, Math.sin(a) * inner)
      ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1)
      ctx.stroke()
    }

    ctx.restore()

    // Reticle ring 2: counter-rotating orbit line with an arc gap.
    ctx.save()
    ctx.translate(cx, cy)
    ctx.rotate(orbit * Math.PI * 2)
    ctx.strokeStyle = `rgba(59, 130, 246, ${0.28 + voice * 0.15})`
    ctx.lineWidth = 1.2 * dpr
    ctx.beginPath()
    ctx.arc(0, 0, R * 1.46, 0.35, Math.PI * 1.72)
    ctx.stroke()
    // Satellite dot riding the orbit line.
    ctx.fillStyle = 'rgba(147, 197, 253, 0.9)'
    ctx.beginPath()
    ctx.arc(Math.cos(0.35) * R * 1.46, Math.sin(0.35) * R * 1.46, 2.2 * dpr, 0, Math.PI * 2)
    ctx.fill()
    ctx.restore()

    raf = window.requestAnimationFrame(frame)
  }

  raf = window.requestAnimationFrame(frame)

  return () => {
    disposed = true
    window.cancelAnimationFrame(raf)
  }
}

// --- React shell ------------------------------------------------------------
function HudPage() {
  const canvasRef = useRef(null)
  const labelRef = useRef(null)
  const sourceRef = useRef(null)
  const busy = useValue(host.state.busy)
  const tracker = useRef({
    amp: null,
    lastDeltaAt: 0,
    listenUntil: 0,
    mode: () => 'idle',
    thinkUntil: 0,
    realFeed: false,
    reportReal: () => undefined,
    speakUntil: 0
  }).current

  tracker.busy = busy

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) {
      return undefined
    }

    tracker.amp = sourceRef.current ??= createAmplitudeSource()

    tracker.mode = () => {
      const now = performance.now()

      if (now < tracker.speakUntil) {
        return 'speaking'
      }

      if (tracker.busy || now < tracker.thinkUntil) {
        return 'thinking'
      }

      if (now < tracker.listenUntil) {
        return 'listening'
      }

      return 'idle'
    }

    // Feed-mode caption ("live waveform" vs "synthesized pulse") + state word.
    tracker.reportReal = real => {
      tracker.realFeed = real

      const el = labelRef.current

      if (el) {
        const mode = tracker.mode()
        const feed = mode === 'speaking' || mode === 'listening' ? (real ? ' · live waveform' : ' · synthesized') : ''

        el.textContent = STATE_LABEL[mode] + feed
      }
    }

    const disposers = [
      startOrb(canvas, tracker),
      host.onEvent('wake.detected', () => {
        tracker.listenUntil = performance.now() + LISTEN_HOLD_MS
      }),
      host.onEvent('message.start', () => {
        tracker.thinkUntil = performance.now() + THINK_HOLD_MS
      }),
      host.onEvent('thinking.delta', () => {
        tracker.thinkUntil = performance.now() + THINK_HOLD_MS
      }),
      host.onEvent('reasoning.delta', () => {
        tracker.thinkUntil = performance.now() + THINK_HOLD_MS
      }),
      host.onEvent('message.delta', () => {
        tracker.amp.kick()
        tracker.thinkUntil = 0
        tracker.speakUntil = performance.now() + SPEAK_HOLD_MS
      }),
      host.onEvent('message.complete', () => {
        tracker.thinkUntil = 0
        tracker.speakUntil = Math.min(tracker.speakUntil, performance.now() + SPEAK_HOLD_MS)
      }),
      host.onEvent('voice.amplitude', event => {
        const { level = 0, source = 'out' } = event.payload ?? {}

        tracker.amp.feed(source === 'mic' ? 'mic' : 'out', level)

        if (source === 'out' && level > 0.02) {
          tracker.speakUntil = performance.now() + SPEAK_HOLD_MS
        }

        if (source === 'mic' && level > 0.04) {
          tracker.listenUntil = Math.max(tracker.listenUntil, performance.now() + 1500)
        }
      })
    ]

    return () => disposers.forEach(dispose => dispose?.())
  }, [tracker])

  return jsxs('div', {
    style: {
      background: '#02040A',
      backgroundImage: 'radial-gradient(ellipse at 50% 42%, #060B14 0%, #02040A 68%, #010208 100%)',
      height: '100%',
      inset: 0,
      minHeight: '480px',
      overflow: 'hidden',
      position: 'absolute',
      width: '100%'
    },
    children: [
      jsx('canvas', {
        ref: canvasRef,
        style: { height: '100%', left: 0, position: 'absolute', top: 0, width: '100%' }
      }),
      jsxs('div', {
        style: {
          alignItems: 'center',
          bottom: '9%',
          display: 'flex',
          flexDirection: 'column',
          gap: '6px',
          left: 0,
          pointerEvents: 'none',
          position: 'absolute',
          right: 0,
          zIndex: 1
        },
        children: [
          jsx('div', {
            style: {
              color: '#D9E6F2',
              fontFamily: "'Inter', system-ui, sans-serif",
              fontSize: '15px',
              fontWeight: 600,
              letterSpacing: '0.42em',
              textIndent: '0.42em',
              textShadow: '0 0 18px rgba(59,130,246,0.55)'
            },
            children: 'JARVIS'
          }),
          jsx('div', {
            ref: labelRef,
            style: {
              color: 'rgba(122, 140, 163, 0.85)',
              fontFamily: "'Inter', system-ui, sans-serif",
              fontSize: '11px',
              letterSpacing: '0.18em',
              textIndent: '0.18em',
              textTransform: 'uppercase'
            },
            children: 'standing by'
          })
        ]
      })
    ]
  })
}

export default {
  id: 'jarvis-hud',
  name: 'JARVIS HUD',
  description: 'The living JARVIS presence — a breathing particle orb that listens, thinks, and speaks with the agent.',
  register(ctx) {
    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: '/hud' },
        render: () => jsx(HudPage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        order: 48,
        data: { codicon: 'circle-large-outline', label: 'HUD', path: '/hud' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'jarvisHud.open',
          label: 'JARVIS: Open HUD',
          keywords: ['hud', 'orb', 'jarvis', 'presence'],
          run: () => host.navigate('/hud')
        }
      }
    ])

    // "Hey Jarvis" surfaces the orb — but ONLY once the voice session is
    // provably alive. Navigating on the raw wake event unmounted the chat
    // composer that consumes the voice-start request, killing the session
    // before it began (observed live 2026-08-24: detection, then total
    // silence, then the 10s watchdog re-arm). The greeting's first output
    // amplitude is the aliveness signal: the session is active and it
    // survives route changes by design, so navigation is safe from then on.
    let wakeNavUntil = 0

    ctx.onDispose(
      host.onEvent('wake.detected', () => {
        wakeNavUntil = Date.now() + 12_000
      })
    )
    ctx.onDispose(
      host.onEvent('voice.amplitude', event => {
        if (Date.now() < wakeNavUntil && event.payload?.source === 'out' && (event.payload?.level ?? 0) > 0.02) {
          wakeNavUntil = 0
          host.navigate('/hud')
        }
      })
    )
  }
}
