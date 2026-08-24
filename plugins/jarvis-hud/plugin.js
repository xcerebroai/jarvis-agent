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
import { Component, useEffect, useRef, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// --- Cockpit type system: system instrument faces (webfonts are outside the
// sandbox — SDK+react only, offline-safe). Condensed technical sans for
// labels, tabular numerals for data.
const T = {
  data: "'SF Mono', ui-monospace, 'Cascadia Mono', Consolas, Menlo, monospace",
  label: "'Avenir Next Condensed', 'Bahnschrift', 'Arial Narrow', 'Inter', sans-serif"
}

const LABEL = {
  color: 'rgba(122, 150, 183, 0.85)',
  fontFamily: T.label,
  fontSize: '10px',
  fontWeight: 600,
  letterSpacing: '0.32em',
  textTransform: 'uppercase'
}

// --- UI sound family: synthesized kin of the wake chime. Soft ticks on
// materialize/dissolve, a low bloom on boot. One switch kills everything;
// persisted via plugin storage. Default volume is deliberately timid.
let audioCtx = null
let hudSoundOn = true

function uiSound(kind) {
  if (!hudSoundOn) {
    return
  }

  try {
    audioCtx ??= new (window.AudioContext || window.webkitAudioContext)()
    const ctx = audioCtx

    if (ctx.state === 'suspended') {
      void ctx.resume().catch(() => undefined)
    }

    const t0 = ctx.currentTime
    const gain = ctx.createGain()

    gain.connect(ctx.destination)

    const tone = (freq, start, dur, peak, type = 'sine') => {
      const osc = ctx.createOscillator()

      osc.type = type
      osc.frequency.setValueAtTime(freq, t0 + start)
      const g = ctx.createGain()

      g.gain.setValueAtTime(0, t0 + start)
      g.gain.linearRampToValueAtTime(peak, t0 + start + 0.012)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + start + dur)
      osc.connect(g)
      g.connect(gain)
      osc.start(t0 + start)
      osc.stop(t0 + start + dur + 0.05)
    }

    if (kind === 'materialize') {
      tone(1560, 0, 0.09, 0.05)
      tone(2340, 0.045, 0.07, 0.03)
    } else if (kind === 'dissolve') {
      tone(1170, 0, 0.1, 0.04)
      tone(780, 0.05, 0.12, 0.03)
    } else if (kind === 'boot') {
      tone(392, 0, 0.5, 0.045, 'triangle')
      tone(587.3, 0.18, 0.5, 0.04, 'triangle')
      tone(1568, 0.42, 0.35, 0.03)
    } else if (kind === 'tick') {
      tone(2100, 0, 0.035, 0.025)
    }
  } catch {
    // sound is garnish; never let it throw
  }
}

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
  idle: {
    baseGlow: 0.55, breathAmp: 0.022, breathHz: 0.22, coreIntensity: 0.9, dim: 1,
    energyGain: 1.6, glow: 1, pulseFloor: 0, pulseRate: 0.05, radius: 1,
    shellSpeed: 1, shimmer: 0.9, spin: 0.1
  },
  listening: {
    baseGlow: 0.42, breathAmp: 0.01, breathHz: 0.5, coreIntensity: 1.15, dim: 0.82,
    energyGain: 0.9, glow: 0.8, pulseFloor: 0, pulseRate: 0.04, radius: 0.88,
    shellSpeed: 0.7, shimmer: 0.25, spin: 0.13
  },
  speaking: {
    baseGlow: 0.7, breathAmp: 0.015, breathHz: 0.35, coreIntensity: 1.5, dim: 1,
    energyGain: 2.2, glow: 1.25, pulseFloor: 0.12, pulseRate: 0.3, radius: 1.03,
    shellSpeed: 1.3, shimmer: 0.3, spin: 0.16
  },
  thinking: {
    baseGlow: 0.6, breathAmp: 0.015, breathHz: 0.8, coreIntensity: 1.25, dim: 1,
    energyGain: 1.2, glow: 1.1, pulseFloor: 0.5, pulseRate: 0.5, radius: 0.96,
    shellSpeed: 2.6, shimmer: 0.35, spin: 0.5
  }
}

const STATE_LABEL = { idle: 'standing by', listening: 'listening', speaking: 'speaking', thinking: 'thinking' }
const LISTEN_HOLD_MS = 12_000
const SPEAK_HOLD_MS = 1400
const THINK_HOLD_MS = 30_000

// --- The engine: a holographic construction sphere, hand-rolled WebGL2 ------
// Reference DNA (owner's film stills, rendered in the JARVIS blues):
//   filaments over dots · fragmented counter-rotating shells · a small intense
//   blue-white core vortex · depth + bloom · voice as energy coursing through
//   the lattice (enveloped — swells, never jitter).
// No three.js: the runtime plugin import allowlist is SDK + react, so the
// renderer below is raw WebGL2. Canvas 2D could not hold layered depth,
// per-filament pulses and bloom at 60fps; GL does it without breaking a sweat.

const COLORS = {
  core: [147 / 255, 197 / 255, 253 / 255], // #93C5FD hot blue-white
  mid: [96 / 255, 165 / 255, 250 / 255], // #60A5FA
  primary: [59 / 255, 130 / 255, 246 / 255], // #3B82F6
  rim: [30 / 255, 78 / 255, 134 / 255] // #1E4E86 deep rim
}

// Voice envelope: fast attack (~100ms), slow decay (~400ms) — speech reads as
// swells and blooms of light, never positional shiver.
function createEnvelope() {
  let value = 0

  return {
    get: () => value,
    step(target, dtMs) {
      const tau = target > value ? 100 : 400
      value += (target - value) * (1 - Math.exp(-dtMs / tau))

      return value
    }
  }
}

const LINE_VS = `#version 300 es
precision highp float;
layout(location=0) in vec3 aPos;
layout(location=1) in float aArcT;
layout(location=2) in float aSeed;
layout(location=3) in float aKind; // 0 filament, 1 particle
uniform mat3 uRot;
uniform float uAspect, uScale, uRadius, uTime, uEnergy, uPulseRate, uShimmer, uBaseGlow;
out float vBright;
out float vDepth;
out float vKind;

void main() {
  vec3 p = uRot * (aPos * uRadius);
  float persp = 1.0 / (1.85 - p.z * 0.55);
  vec2 xy = p.xy * persp * uScale;
  gl_Position = vec4(xy.x / uAspect, xy.y, 0.0, 1.0);
  vDepth = (p.z + 1.0) * 0.5;
  vKind = aKind;

  // Idle shimmer: slow per-arc waves so a few filaments breathe at a time.
  float shimmer = pow(0.5 + 0.5 * sin(uTime * 0.45 + aSeed * 37.0), 6.0) * uShimmer;

  // Voice energy: a bright head travels along each arc; amplitude gates it.
  float head = fract(uTime * uPulseRate * (0.35 + fract(aSeed * 7.31) * 0.85) + aSeed);
  float d = abs(aArcT - head);
  d = min(d, 1.0 - d);
  float pulse = exp(-d * d * 140.0) * uEnergy;

  vBright = uBaseGlow + shimmer + pulse * 1.6;
  gl_PointSize = (1.5 + vDepth * 2.5 + pulse * 3.0) * persp;
}`

const LINE_FS = `#version 300 es
precision highp float;
in float vBright;
in float vDepth;
in float vKind;
uniform vec3 uRim, uPrimary, uMid, uCore;
uniform float uDim;
out vec4 frag;

void main() {
  if (vKind > 0.5) {
    vec2 c = gl_PointCoord - 0.5;
    if (dot(c, c) > 0.25) discard;
  }

  // Depth-graded blue: deep rim far, hot blue-white near/bright.
  vec3 col = mix(uRim, uPrimary, smoothstep(0.0, 0.6, vDepth));
  col = mix(col, uMid, smoothstep(0.45, 0.9, vDepth));
  col = mix(col, uCore, clamp(vBright - 0.9, 0.0, 1.0) * 0.6);
  float a = (0.10 + vDepth * vDepth * 0.55) * vBright * uDim;
  frag = vec4(col * a, a);
}`

const GLOW_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
uniform float uAspect, uSize;
out vec2 vUv;

void main() {
  vUv = aPos;
  gl_Position = vec4(aPos.x * uSize / uAspect, aPos.y * uSize, 0.0, 1.0);
}`

// The core vortex: radial falloff × a slow two-octave swirl. Brightest thing
// on screen; voice flares it.
const GLOW_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform float uTime, uIntensity, uSwirl, uSweep;
uniform vec3 uCore, uMid;
out vec4 frag;

float noise(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}

float fbm(vec2 p) {
  float a = noise(floor(p)) * 0.6 + noise(floor(p * 2.3 + 7.7)) * 0.4;
  return a;
}

void main() {
  float r = length(vUv);
  float ang = atan(vUv.y, vUv.x);
  float swirl = fbm(vec2(ang * 2.2 + uTime * 0.25 + r * 3.0 * uSwirl, r * 5.0 - uTime * 0.35));
  float body = exp(-r * r * 7.0) * (0.75 + swirl * 0.5);
  float hot = exp(-r * r * 40.0) * 1.4;
  vec3 col = uMid * body + uCore * (body * 0.6 + hot);
  float a = clamp((body + hot) * uIntensity, 0.0, 1.6);

  // CLEARING sweep: one expanding wavefront ring; panels dissolve on it.
  if (uSweep > 0.0 && uSweep < 1.0) {
    float ring = exp(-pow((r - uSweep * 1.35) * 22.0, 2.0)) * (1.0 - uSweep);
    col += uCore * ring;
    a += ring * 0.9;
  }
  frag = vec4(col * a, a * 0.8);
}`

const BLUR_VS = `#version 300 es
precision highp float;
layout(location=0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.0, 1.0); }`

const BLUR_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 frag;

void main() {
  vec4 sum = texture(uTex, vUv) * 0.227;
  sum += texture(uTex, vUv + uDir * 1.384) * 0.316;
  sum += texture(uTex, vUv - uDir * 1.384) * 0.316;
  sum += texture(uTex, vUv + uDir * 3.230) * 0.070;
  sum += texture(uTex, vUv - uDir * 3.230) * 0.070;
  frag = sum;
}`

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform float uAmount;
out vec4 frag;
void main() { frag = texture(uTex, vUv) * uAmount; }`

function compile(gl, type, src) {
  const sh = gl.createShader(type)

  gl.shaderSource(sh, src)
  gl.compileShader(sh)

  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || 'shader compile failed')
  }

  return sh
}

function program(gl, vs, fs) {
  const prog = gl.createProgram()

  gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, vs))
  gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(prog)

  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(prog) || 'link failed')
  }

  return prog
}

// Filament lattice: great-circle and latitude arcs with circuit-like gaps.
function buildFilaments() {
  const verts = []
  const rand = (() => {
    let s = 1234567

    return () => {
      s = (s * 1103515245 + 12345) & 0x7fffffff

      return s / 0x7fffffff
    }
  })()

  const arcCount = 150

  for (let i = 0; i < arcCount; i++) {
    // Random circle: axis n, plane basis (u, v); small circles hug latitude.
    const az = rand() * Math.PI * 2
    const el = Math.acos(2 * rand() - 1)
    const n = [Math.sin(el) * Math.cos(az), Math.cos(el), Math.sin(el) * Math.sin(az)]
    let u = [-n[1], n[0], 0]
    const ul = Math.hypot(u[0], u[1], u[2]) || 1

    u = u.map(x => x / ul)
    const v = [
      n[1] * u[2] - n[2] * u[1],
      n[2] * u[0] - n[0] * u[2],
      n[0] * u[1] - n[1] * u[0]
    ]
    const lat = rand() < 0.4 ? (rand() - 0.5) * 0.9 : 0
    const rr = Math.sqrt(1 - lat * lat)
    const start = rand() * Math.PI * 2
    const span = (0.25 + rand() * 1.1) * (rand() < 0.15 ? 2.2 : 1)
    const steps = Math.max(6, Math.floor(span * 22))
    const seed = rand()
    const radius = 0.82 + rand() * 0.2

    for (let sIdx = 0; sIdx < steps; sIdx++) {
      for (const off of [0, 1]) {
        const t = (sIdx + off) / steps
        const th = start + t * span
        const c = Math.cos(th) * rr
        const s2 = Math.sin(th) * rr
        const p = [
          (c * u[0] + s2 * v[0] + lat * n[0]) * radius,
          (c * u[1] + s2 * v[1] + lat * n[1]) * radius,
          (c * u[2] + s2 * v[2] + lat * n[2]) * radius
        ]

        verts.push(p[0], p[1], p[2], t, seed, 0)
      }
    }
  }

  // Sparse structural particles at lattice depth.
  for (let i = 0; i < 260; i++) {
    const az = rand() * Math.PI * 2
    const el = Math.acos(2 * rand() - 1)
    const r = 0.7 + rand() * 0.3

    verts.push(
      r * Math.sin(el) * Math.cos(az),
      r * Math.cos(el),
      r * Math.sin(el) * Math.sin(az),
      rand(),
      rand(),
      1
    )
  }

  return new Float32Array(verts)
}

// Fragmented shells: partial ring plates on tilted axes — a machine of light
// mid-assembly. Each shell rotates independently (counter-rotation CPU-side).
function buildShellSegments() {
  const verts = []
  const ranges = []
  let seed = 424242
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff

    return seed / 0x7fffffff
  }

  const radii = [1.12, 1.26, 1.42]

  radii.forEach((radius, shell) => {
    const startVert = verts.length / 6
    const plates = 7 + shell * 2

    for (let plateIdx = 0; plateIdx < plates; plateIdx++) {
      const start = rand() * Math.PI * 2
      const span = 0.18 + rand() * 0.55
      const width = 0.014 + rand() * 0.03
      const steps = Math.max(4, Math.floor(span * 16))
      const pseed = rand()
      const inner = radius - width
      const outer = radius + width
      const at = (th, r) => [Math.cos(th) * r, Math.sin(th) * r, 0]

      for (let sIdx = 0; sIdx < steps; sIdx++) {
        const t0 = start + (sIdx / steps) * span
        const t1 = start + ((sIdx + 1) / steps) * span
        const tt = sIdx / steps

        // plate edges: two concentric arc strokes
        verts.push(...at(t0, inner), tt, pseed, 0, ...at(t1, inner), tt, pseed, 0)
        verts.push(...at(t0, outer), tt, pseed, 0, ...at(t1, outer), tt, pseed, 0)

        // sparse rungs give the plates their machined look
        if (sIdx % 3 === 0) {
          verts.push(...at(t0, inner), tt, pseed, 0, ...at(t0, outer), tt, pseed, 0)
        }
      }
    }

    ranges.push({ count: verts.length / 6 - startVert, start: startVert })
  })

  return { data: new Float32Array(verts), ranges }
}

function startOrb(canvas, tracker) {
  const gl = canvas.getContext('webgl2', { alpha: true, antialias: true, premultipliedAlpha: true })

  if (!gl) {
    return () => undefined
  }

  let disposed = false
  let raf = 0

  try {
    const lineProg = program(gl, LINE_VS, LINE_FS)
    const glowProg = program(gl, GLOW_VS, GLOW_FS)
    const blurProg = program(gl, BLUR_VS, BLUR_FS)
    const compProg = program(gl, BLUR_VS, COMPOSITE_FS)

    const filaments = buildFilaments()
    const filamentCount = filaments.length / 6
    const shellMesh = buildShellSegments()

    const makeVao = data => {
      const vao = gl.createVertexArray()
      const vbo = gl.createBuffer()

      gl.bindVertexArray(vao)
      gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW)
      gl.enableVertexAttribArray(0)
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0)
      gl.enableVertexAttribArray(1)
      gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 24, 12)
      gl.enableVertexAttribArray(2)
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 24, 16)
      gl.enableVertexAttribArray(3)
      gl.vertexAttribPointer(3, 1, gl.FLOAT, false, 24, 20)

      return vao
    }

    const filamentVao = makeVao(filaments)
    const shellVao = makeVao(shellMesh.data)

    const quad = new Float32Array([-1, -1, 1, -1, -1, 1, 1, -1, 1, 1, -1, 1])
    const quadVao = gl.createVertexArray()
    const quadVbo = gl.createBuffer()

    gl.bindVertexArray(quadVao)
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo)
    gl.bufferData(gl.ARRAY_BUFFER, quad, gl.STATIC_DRAW)
    gl.enableVertexAttribArray(0)
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0)

    // Bloom chain: scene → half-res A → blur H → B → blur V → A → composite.
    const fbo = { a: null, b: null, ta: null, tb: null, w: 0, h: 0 }

    const makeTarget = (w, h) => {
      const tex = gl.createTexture()

      gl.bindTexture(gl.TEXTURE_2D, tex)
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE)
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE)
      const fb = gl.createFramebuffer()

      gl.bindFramebuffer(gl.FRAMEBUFFER, fb)
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0)

      return { fb, tex }
    }

    const env = createEnvelope()
    const live = { ...PRESETS.idle }
    let rotY = 0
    let last = performance.now()
    const lerp = (a, b, k) => a + (b - a) * k

    const frame = now => {
      if (disposed) {
        return
      }

      const dt = Math.min(64, now - last)

      last = now
      const dpr = window.devicePixelRatio || 1
      const w = canvas.clientWidth
      const h = canvas.clientHeight

      if (w < 40 || h < 40) {
        raf = window.requestAnimationFrame(frame)

        return
      }

      const W = Math.round(w * dpr)
      const H = Math.round(h * dpr)

      if (canvas.width !== W || canvas.height !== H) {
        canvas.width = W
        canvas.height = H
      }

      if (fbo.w !== W || fbo.h !== H) {
        fbo.w = W
        fbo.h = H
        const bw = Math.max(2, W >> 2)
        const bh = Math.max(2, H >> 2)

        Object.assign(fbo, { a: makeTarget(bw, bh), b: makeTarget(bw, bh), bh, bw, scene: makeTarget(W, H) })
      }

      const mode = tracker.mode()
      const target = PRESETS[mode]
      const k = 1 - Math.exp(-dt / 380)

      for (const key of Object.keys(target)) {
        live[key] = lerp(live[key], target[key], k)
      }

      const out = tracker.amp.level('out', dt)
      const mic = tracker.amp.level('mic', dt)
      const rawVoice = mode === 'speaking' ? out.level : mode === 'listening' ? mic.level * 0.5 : 0

      tracker.reportReal(mode === 'speaking' ? out.real : mode === 'listening' ? mic.real : false)
      const boot = tracker.bootAt ? Math.min(1, (now - tracker.bootAt) / 1400) : 1
      const ignite = boot < 1 ? boot * boot * (3 - 2 * boot) : 1
      const energy = env.step(rawVoice, dt) * ignite

      // Action grammar: brief legible gestures (300-800ms), enveloped like
      // voice — they compose with speech on the same lattice.
      const g = tracker.gesture
      const gAge = g ? now - g.at : Infinity
      const gEnv = g ? Math.min(1, gAge / 120) * Math.exp(-Math.max(0, gAge - 300) / 350) : 0
      const gather = g?.kind === 'gather' ? gEnv : 0
      const project = g?.kind === 'project' ? gEnv : 0
      const sweep = g?.kind === 'sweep' ? Math.min(1, gAge / 650) : 0

      if (g && (gAge > 1400 || (g.kind === 'sweep' && sweep >= 1))) {
        tracker.gesture = null
      }

      rotY += (dt / 1000) * live.spin * (1 + energy * 0.5)
      const rotX = 0.42 + Math.sin(now / 11_000) * 0.07

      const cy = Math.cos(rotY)
      const sy = Math.sin(rotY)
      const cx = Math.cos(rotX)
      const sx = Math.sin(rotX)
      // column-major mat3: rotY then rotX
      const rot = new Float32Array([
        cy, sx * sy, -cx * sy,
        0, cx, sx,
        sy, -sx * cy, cx * cy
      ])

      const aspect = W / H
      const scale = 0.62 * live.radius
      const breath = 1 + Math.sin((now / 1000) * live.breathHz * Math.PI * 2) * live.breathAmp
      const radius = breath * (1 + energy * 0.05 - gather * 0.04 + project * 0.03)

      // ---- scene pass (into the scene FBO; bloom + composite follow) ----
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.scene.fb)
      gl.viewport(0, 0, W, H)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)

      // halo
      gl.useProgram(glowProg)
      gl.bindVertexArray(quadVao)
      gl.uniform1f(gl.getUniformLocation(glowProg, 'uAspect'), aspect)
      gl.uniform1f(gl.getUniformLocation(glowProg, 'uSize'), 1.55 * live.radius)
      gl.uniform1f(gl.getUniformLocation(glowProg, 'uTime'), now / 1000)
      gl.uniform1f(gl.getUniformLocation(glowProg, 'uIntensity'), 0.10 * live.glow + project * 0.12)
      gl.uniform1f(gl.getUniformLocation(glowProg, 'uSwirl'), 0.4)
      gl.uniform1f(gl.getUniformLocation(glowProg, 'uSweep'), sweep)
      gl.uniform3fv(gl.getUniformLocation(glowProg, 'uCore'), COLORS.primary)
      gl.uniform3fv(gl.getUniformLocation(glowProg, 'uMid'), COLORS.rim)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      gl.blendFunc(gl.ONE, gl.ONE)

      // filament lattice + particles
      gl.useProgram(lineProg)
      gl.bindVertexArray(filamentVao)
      const uni = name => gl.getUniformLocation(lineProg, name)

      gl.uniformMatrix3fv(uni('uRot'), false, rot)
      gl.uniform1f(uni('uAspect'), aspect)
      gl.uniform1f(uni('uScale'), scale)
      gl.uniform1f(uni('uRadius'), radius)
      gl.uniform1f(uni('uTime'), now / 1000)
      gl.uniform1f(uni('uEnergy'), energy * live.energyGain + live.pulseFloor + gather * 0.9 + project * 0.7)
      gl.uniform1f(uni('uPulseRate'), live.pulseRate)
      gl.uniform1f(uni('uShimmer'), live.shimmer)
      gl.uniform1f(uni('uBaseGlow'), live.baseGlow * (0.15 + 0.85 * ignite))
      gl.uniform1f(uni('uDim'), live.dim)
      gl.uniform3fv(uni('uRim'), COLORS.rim)
      gl.uniform3fv(uni('uPrimary'), COLORS.primary)
      gl.uniform3fv(uni('uMid'), COLORS.mid)
      gl.uniform3fv(uni('uCore'), COLORS.core)
      gl.drawArrays(gl.LINES, 0, filamentCount - 260)
      gl.drawArrays(gl.POINTS, filamentCount - 260, 260)

      // fragmented shells: three tilted counter-rotating rings
      gl.bindVertexArray(shellVao)
      const shellStates = [
        { dir: 1, speed: 0.16, tiltX: 1.15, tiltZ: 0.2 },
        { dir: -1, speed: 0.11, tiltX: 0.4, tiltZ: -0.5 },
        { dir: 1, speed: 0.07, tiltX: 1.9, tiltZ: 0.9 }
      ]

      shellStates.forEach((st, i) => {
        const a = now / 1000 * st.speed * st.dir * live.shellSpeed * (1 + energy * 0.8 + gather * 1.5 + project * 0.9)
        const ca = Math.cos(a)
        const sa = Math.sin(a)
        const ctx2 = Math.cos(st.tiltX)
        const stx = Math.sin(st.tiltX)
        const cz = Math.cos(st.tiltZ)
        const sz = Math.sin(st.tiltZ)
        // spin(Z-local) then tiltX then tiltZ, composed with global rot
        const m = [
          ca, sa, 0,
          -sa, ca, 0,
          0, 0, 1
        ]
        const tx = [
          1, 0, 0,
          0, ctx2, stx,
          0, -stx, ctx2
        ]
        const tz = [
          cz, sz, 0,
          -sz, cz, 0,
          0, 0, 1
        ]
        const mul = (A, B) => {
          const o = new Array(9)

          for (let r = 0; r < 3; r++) {
            for (let c = 0; c < 3; c++) {
              o[c * 3 + r] = A[0 * 3 + r] * B[c * 3 + 0] + A[1 * 3 + r] * B[c * 3 + 1] + A[2 * 3 + r] * B[c * 3 + 2]
            }
          }

          return o
        }
        const g = [rot[0], rot[1], rot[2], rot[3], rot[4], rot[5], rot[6], rot[7], rot[8]]
        const model = mul(g, mul(tz, mul(tx, m)))

        gl.uniformMatrix3fv(uni('uRot'), false, new Float32Array(model))
        gl.uniform1f(uni('uBaseGlow'), live.baseGlow * (0.75 - i * 0.14))
        gl.drawArrays(gl.LINES, shellMesh.ranges[i].start, shellMesh.ranges[i].count)
      })

      // core vortex — brightest element on screen
      gl.useProgram(glowProg)
      gl.bindVertexArray(quadVao)
      gl.uniform1f(gl.getUniformLocation(glowProg, 'uSize'), 0.34 * live.radius * (1 + energy * 0.18))
      gl.uniform1f(gl.getUniformLocation(glowProg, 'uIntensity'), live.coreIntensity * ignite * (1 + energy * 1.1 + gather * 1.4))
      gl.uniform1f(gl.getUniformLocation(glowProg, 'uSwirl'), 1.0)
      gl.uniform1f(gl.getUniformLocation(glowProg, 'uSweep'), 0.0)
      gl.uniform3fv(gl.getUniformLocation(glowProg, 'uCore'), COLORS.core)
      gl.uniform3fv(gl.getUniformLocation(glowProg, 'uMid'), COLORS.mid)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      // ---- bloom: quarter-res blur of the scene, then composite ----
      gl.useProgram(blurProg)
      gl.bindVertexArray(quadVao)
      gl.activeTexture(gl.TEXTURE0)
      gl.disable(gl.BLEND)

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.a.fb)
      gl.viewport(0, 0, fbo.bw, fbo.bh)
      gl.bindTexture(gl.TEXTURE_2D, fbo.scene.tex)
      gl.uniform1i(gl.getUniformLocation(blurProg, 'uTex'), 0)
      gl.uniform2f(gl.getUniformLocation(blurProg, 'uDir'), 1 / fbo.bw, 0)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo.b.fb)
      gl.bindTexture(gl.TEXTURE_2D, fbo.a.tex)
      gl.uniform2f(gl.getUniformLocation(blurProg, 'uDir'), 0, 1 / fbo.bh)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      // composite: crisp scene + soft bloom, straight onto the canvas
      gl.bindFramebuffer(gl.FRAMEBUFFER, null)
      gl.viewport(0, 0, W, H)
      gl.clearColor(0, 0, 0, 0)
      gl.clear(gl.COLOR_BUFFER_BIT)
      gl.useProgram(compProg)
      gl.enable(gl.BLEND)
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA)
      gl.bindTexture(gl.TEXTURE_2D, fbo.scene.tex)
      gl.uniform1i(gl.getUniformLocation(compProg, 'uTex'), 0)
      gl.uniform1f(gl.getUniformLocation(compProg, 'uAmount'), 1)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
      gl.blendFunc(gl.ONE, gl.ONE)
      gl.bindTexture(gl.TEXTURE_2D, fbo.b.tex)
      gl.uniform1f(gl.getUniformLocation(compProg, 'uAmount'), 0.9 + energy * 0.7)
      gl.drawArrays(gl.TRIANGLES, 0, 6)

      raf = window.requestAnimationFrame(frame)
    }

    raf = window.requestAnimationFrame(frame)
  } catch {
    return () => undefined
  }

  return () => {
    disposed = true
    window.cancelAnimationFrame(raf)
  }
}

// --- Materializing panels: the orb projects them; they assemble on its pulses.
const STATUS_COLOR = {
  Blocked: '#F87171',
  'Build Mode': '#60A5FA',
  Live: '#34D399',
  'Payment Follow-Up': '#FBBF24',
  Planning: '#7A8CA3',
  Ready: '#93C5FD',
  Testing: '#A78BFA'
}

const COCKPIT_CSS = `
@keyframes jvBreathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes jvSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes jvSpinR { from { transform: rotate(0deg); } to { transform: rotate(-360deg); } }
@keyframes jvSweep { 0% { background-position: -200% 0; } 100% { background-position: 300% 0; } }
@keyframes jvBootIn { from { opacity: 0; transform: scaleX(0); } to { opacity: 1; transform: scaleX(1); } }
@keyframes jvFadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
.jv-plate-border rect { stroke-dasharray: 1; stroke-dashoffset: 1; transition: stroke-dashoffset 620ms cubic-bezier(0.22, 1, 0.36, 1); }
.jv-shown .jv-plate-border rect { stroke-dashoffset: 0; }
.jv-scan { background: repeating-linear-gradient(0deg, rgba(147,197,253,0.028) 0 1px, transparent 1px 3px); }
.jv-chip { animation: jvBreathe 2.4s ease-in-out infinite; }
.jv-bar-charge { background-image: linear-gradient(90deg, transparent 0%, rgba(255,255,255,0.55) 50%, transparent 100%); background-size: 45% 100%; background-repeat: no-repeat; animation: jvSweep 1.1s ease-out 1; }
`

// Deciphering text: scrambles briefly, then settles — data assembling.
function Decipher({ delay = 0, style, text }) {
  const [shown, setShown] = useState('')

  useEffect(() => {
    const glyphs = 'ABCDEFGHKMNPRSTUVXYZ0123456789#$/'
    let frame = 0
    let timer = 0
    const start = window.setTimeout(() => {
      timer = window.setInterval(() => {
        frame += 1
        const settled = Math.floor((frame / 14) * text.length)

        setShown(
          text.slice(0, settled) +
            Array.from({ length: Math.max(0, Math.min(text.length - settled, 6)) }, () =>
              glyphs[Math.floor(Math.random() * glyphs.length)]).join('')
        )

        if (settled >= text.length) {
          setShown(text)
          window.clearInterval(timer)
        }
      }, 36)
    }, delay)

    return () => {
      window.clearTimeout(start)
      window.clearInterval(timer)
    }
  }, [delay, text])

  return jsx('span', { style, children: shown || '\u00a0' })
}

function ProjectCard({ dissolving, focus, index, row, shown }) {
  const side = index % 2 === 0 ? 'left' : 'right'
  const slot = Math.floor(index / 2)
  const done = row.tasks_done ?? 0
  const total = row.tasks_total ?? 0
  const statusColor = STATUS_COLOR[row.status] || '#60A5FA'
  const pos = focus
    ? { left: '56%', top: '17%', width: '350px' }
    : side === 'left'
      ? { left: '2.8%', top: 9 + slot * 20.5 + '%', width: '256px' }
      : { right: '2.8%', top: 9 + slot * 20.5 + '%', width: '256px' }
  const visible = shown && !dissolving

  return jsxs('div', {
    className: visible ? 'jv-shown' : '',
    style: {
      background: 'rgba(4, 9, 17, 0.72)',
      backdropFilter: 'blur(2px)',
      boxShadow: focus
        ? '0 0 30px rgba(59,130,246,0.30), inset 0 0 22px rgba(59,130,246,0.10)'
        : 'inset 0 0 14px rgba(59,130,246,0.05)',
      clipPath: 'polygon(10px 0, 100% 0, 100% calc(100% - 10px), calc(100% - 10px) 100%, 0 100%, 0 10px)',
      color: '#D9E6F2',
      opacity: visible ? (focus ? 1 : 0.92) : 0,
      padding: focus ? '15px 17px 13px' : '10px 12px 9px',
      pointerEvents: 'none',
      position: 'absolute',
      transform: visible ? 'scale(1)' : 'scale(0.94)',
      transition: 'opacity 360ms cubic-bezier(0.22, 1, 0.36, 1), transform 360ms cubic-bezier(0.22, 1, 0.36, 1)',
      transitionDelay: dissolving ? Math.max(0, 3 - index) * 45 + 'ms' : 140 + index * 75 + 'ms',
      zIndex: focus ? 3 : 2,
      ...pos
    },
    children: [
      // self-drawing border + notch frame
      jsx('svg', {
        className: 'jv-plate-border',
        style: { inset: 0, position: 'absolute' },
        viewBox: '0 0 100 100',
        preserveAspectRatio: 'none',
        children: jsx('rect', {
          fill: 'none',
          height: 99,
          pathLength: 1,
          rx: 0.5,
          stroke: focus ? 'rgba(96,165,250,0.8)' : 'rgba(59,130,246,0.42)',
          strokeWidth: focus ? 0.9 : 0.7,
          style: { transitionDelay: 140 + index * 75 + 'ms', vectorEffect: 'non-scaling-stroke' },
          width: 99,
          x: 0.5,
          y: 0.5
        })
      }),
      jsx('div', { className: 'jv-scan', style: { inset: 0, pointerEvents: 'none', position: 'absolute' } }),
      // corner tick
      jsx('div', {
        style: { borderLeft: '1px solid ' + statusColor, borderTop: '1px solid ' + statusColor, height: '7px', left: '3px', opacity: 0.9, position: 'absolute', top: '3px', width: '7px' }
      }),
      jsxs('div', {
        style: { alignItems: 'baseline', display: 'flex', gap: '8px', justifyContent: 'space-between', position: 'relative' },
        children: [
          visible
            ? jsx(Decipher, {
                delay: 180 + index * 75,
                style: { fontFamily: T.label, fontSize: focus ? '15px' : '12.5px', fontWeight: 600, letterSpacing: '0.09em', overflow: 'hidden', textTransform: 'uppercase', whiteSpace: 'nowrap' },
                text: String(row.name || '')
              })
            : jsx('span', { children: '\u00a0' }),
          jsx('div', {
            className: 'jv-chip',
            style: { color: statusColor, flexShrink: 0, fontFamily: T.label, fontSize: focus ? '10.5px' : '9px', fontWeight: 600, letterSpacing: '0.22em', textTransform: 'uppercase' },
            children: row.status
          })
        ]
      }),
      (focus || row.status === 'Blocked') && (row.note || row.next_action)
        ? jsx('div', {
            style: { animation: visible ? 'jvFadeUp 400ms 260ms both' : 'none', color: 'rgba(139,161,188,0.95)', fontSize: focus ? '11px' : '9.5px', lineHeight: 1.45, marginTop: '6px', position: 'relative' },
            children: String(row.note || row.next_action).slice(0, focus ? 260 : 96)
          })
        : null,
      total > 0
        ? jsxs('div', {
            style: { alignItems: 'center', display: 'flex', gap: '8px', marginTop: focus ? '10px' : '7px', position: 'relative' },
            children: [
              jsx('div', {
                style: { background: 'rgba(59,130,246,0.16)', flex: 1, height: '2px' },
                children: jsx('div', {
                  className: visible ? 'jv-bar-charge' : '',
                  style: { background: statusColor, height: '2px', transition: 'width 700ms cubic-bezier(0.22, 1, 0.36, 1) ' + (200 + index * 75) + 'ms', width: visible ? Math.round((done / total) * 100) + '%' : '0%' }
                })
              }),
              jsx('div', { style: { color: 'rgba(122,150,183,0.9)', fontFamily: T.data, fontSize: '9px', fontVariantNumeric: 'tabular-nums' }, children: done + '/' + total })
            ]
          })
        : null
    ]
  })
}

function HudPage() {
  const canvasRef = useRef(null)
  const labelRef = useRef(null)
  const sourceRef = useRef(null)
  const busy = useValue(host.state.busy)
  const [display, setDisplay] = useState({ detail: null, dissolving: false, focus: null, rows: [], shown: false })
  const tracker = useRef({
    amp: null,
    gesture: null,
    lastDeltaAt: 0,
    listenUntil: 0,
    mode: () => 'idle',
    thinkUntil: 0,
    realFeed: false,
    reportReal: () => undefined,
    speakUntil: 0
  }).current

  tracker.busy = busy

  const [booted, setBooted] = useState(false)
  const [clock, setClock] = useState('')
  const [jobs, setJobs] = useState([])
  const [activity, setActivity] = useState([])
  const [isFull, setIsFull] = useState(false)

  useEffect(() => {
    // Scheduled jobs: a real gateway read (cron.manage list), refreshed slowly.
    const pull = () => {
      void host
        .request('cron.manage', { action: 'list' })
        .then(res => {
          const rows = Array.isArray(res?.jobs) ? res.jobs : Array.isArray(res) ? res : []

          setJobs(rows.slice(0, 4))
        })
        .catch(() => undefined)
    }

    pull()
    const timer = window.setInterval(pull, 60_000)

    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    // Activity feed: the live event stream itself — truthful theater.
    const LABELS = {
      'display.clear': 'DISPLAY CLEARED',
      'display.detail': 'DETAIL STAGE',
      'display.projects': 'BOARD PROJECTED',
      'message.complete': 'REPLY DELIVERED',
      'message.start': 'AGENT ENGAGED',
      'wake.detected': 'WAKE DETECTED'
    }

    return host.onEvent('*', event => {
      const label = LABELS[event.type] ?? (event.type?.startsWith('tool.') ? 'TOOL \u00b7 ' + event.type.slice(5).toUpperCase() : null)

      if (!label) {
        return
      }

      const at = new Date()
      const stamp = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0') + ':' + String(at.getSeconds()).padStart(2, '0')

      setActivity(prev => [{ at: stamp, key: at.getTime() + label, label }, ...prev].slice(0, 7))
    })
  }, [])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('jarvis:chrome', { detail: { hide: true } }))
    window.dispatchEvent(new CustomEvent('jarvis:display-request'))
    const denseRetry = window.setTimeout(() => {
      window.dispatchEvent(new CustomEvent('jarvis:display-request'))
    }, 2500)

    return () => {
      window.clearTimeout(denseRetry)
      window.dispatchEvent(new CustomEvent('jarvis:chrome', { detail: { hide: false } }))
    }
  }, [])

  useEffect(() => {
    tracker.bootAt = performance.now()
    uiSound('boot')
    const done = window.setTimeout(() => setBooted(true), 1800)
    const tick = window.setInterval(() => {
      const d = new Date()

      setClock(
        String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0')
      )
    }, 1000)

    return () => {
      window.clearTimeout(done)
      window.clearInterval(tick)
    }
  }, [tracker])

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

    const killVoice = () => {
      window.dispatchEvent(new CustomEvent('jarvis:voice-kill'))
      tracker.speakUntil = 0
      tracker.listenUntil = 0
    }

    const onKey = event => {
      if (event.key === 'Escape') {
        killVoice()
      }
    }

    window.addEventListener('keydown', onKey)
    canvas.style.pointerEvents = 'auto'
    canvas.style.cursor = 'pointer'
    canvas.title = 'Click to stop JARVIS'
    canvas.addEventListener('click', killVoice)

    const disposers = [
      () => {
        window.removeEventListener('keydown', onKey)
        canvas.removeEventListener('click', killVoice)
      },
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
      host.onEvent('display.retrieving', () => {
        tracker.gesture = { at: performance.now(), kind: 'gather' }
      }),
      host.onEvent('display.projects', event => {
        const rows = event.payload?.result?.projects ?? []

        tracker.gesture = { at: performance.now(), kind: 'project' }
        uiSound('materialize')
        setDisplay(prev => ({ ...prev, detail: null, dissolving: false, focus: null, rows: rows.slice(0, 8), shown: false }))
        window.setTimeout(() => setDisplay(prev => ({ ...prev, shown: true })), 80)
      }),
      host.onEvent('display.detail', event => {
        const row = event.payload?.result?.projects?.[0]

        if (row) {
          tracker.gesture = { at: performance.now(), kind: 'project' }
          uiSound('materialize')
          setDisplay(prev => ({ ...prev, detail: row, dissolving: false, focus: null, shown: true }))
        }
      }),
      host.onEvent('display.focus', event => {
        const row = event.payload?.result?.projects?.[0]

        if (row) {
          tracker.gesture = { at: performance.now(), kind: 'project' }
          setDisplay(prev => ({ ...prev, dissolving: false, focus: row, shown: true }))
        }
      }),
      host.onEvent('display.clear', () => {
        tracker.gesture = { at: performance.now(), kind: 'sweep' }
        uiSound('dissolve')
        setDisplay(prev => ({ ...prev, dissolving: true }))
        window.setTimeout(() => setDisplay({ detail: null, dissolving: false, focus: null, rows: [], shown: false }), 620)
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
      jsx('style', { children: COCKPIT_CSS }),
      // ambient: slow counter-rotating radial tick grids + vignette — the room breathes
      jsx('div', {
        style: {
          animation: 'jvSpin 240s linear infinite', border: '1px dashed rgba(59,130,246,0.05)', borderRadius: '50%',
          height: '135vh', left: '50%', marginLeft: '-67.5vh', marginTop: '-67.5vh', pointerEvents: 'none',
          position: 'absolute', top: '46%', width: '135vh'
        }
      }),
      jsx('div', {
        style: {
          animation: 'jvSpinR 320s linear infinite', border: '1px dotted rgba(96,165,250,0.045)', borderRadius: '50%',
          height: '95vh', left: '50%', marginLeft: '-47.5vh', marginTop: '-47.5vh', pointerEvents: 'none',
          position: 'absolute', top: '46%', width: '95vh'
        }
      }),
      jsx('div', {
        style: { background: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0, 2, 6, 0.55) 100%)', inset: 0, pointerEvents: 'none', position: 'absolute', zIndex: 4 }
      }),
      // cockpit frame: corner brackets + readout rails
      ...[
        { borderLeft: 1, borderTop: 1, left: '14px', top: '14px' },
        { borderRight: 1, borderTop: 1, right: '14px', top: '14px' },
        { borderBottom: 1, borderLeft: 1, bottom: '14px', left: '14px' },
        { borderBottom: 1, borderRight: 1, bottom: '14px', right: '14px' }
      ].map((c, i) =>
        jsx('div', {
          style: {
            borderColor: 'rgba(96,165,250,0.4)', borderStyle: 'solid',
            borderWidth: (c.borderTop ? '1px ' : '0 ') + (c.borderRight ? '1px ' : '0 ') + (c.borderBottom ? '1px ' : '0 ') + (c.borderLeft ? '1px' : '0'),
            height: '22px', pointerEvents: 'none', position: 'absolute', width: '22px', zIndex: 5,
            ...Object.fromEntries(Object.entries(c).filter(([k]) => !k.startsWith('border')))
          }
        }, 'corner' + i)
      ),
      jsxs('div', {
        style: { alignItems: 'center', display: 'flex', justifyContent: 'space-between', left: '48px', pointerEvents: 'none', position: 'absolute', right: '48px', top: '17px', zIndex: 5 },
        children: [
          jsx('div', { style: { ...LABEL }, children: 'JARVIS OS \u00b7 COMMAND' }),
          jsxs('div', { style: { display: 'flex', gap: '22px' }, children: [
            display.rows.length
              ? jsx('div', { style: { ...LABEL, color: 'rgba(96,165,250,0.9)' }, children: display.rows.length + ' ON BOARD' })
              : null,
            jsx('div', { style: { ...LABEL, fontFamily: T.data, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.18em' }, children: clock })
          ] })
        ]
      }),
      // detail stage: the expand verb's instrument
      display.detail
        ? jsxs('div', {
            className: 'jv-shown',
            style: {
              background: 'rgba(4, 9, 17, 0.86)', boxShadow: '0 0 34px rgba(59,130,246,0.25), inset 0 0 26px rgba(59,130,246,0.08)',
              clipPath: 'polygon(14px 0, 100% 0, 100% calc(100% - 14px), calc(100% - 14px) 100%, 0 100%, 0 14px)',
              color: '#D9E6F2', maxHeight: '76%', overflow: 'hidden', padding: '18px 20px', pointerEvents: 'none',
              position: 'absolute', right: '3%', top: '10%', width: '390px', zIndex: 3
            },
            children: [
              jsx('svg', {
                className: 'jv-plate-border', preserveAspectRatio: 'none',
                style: { inset: 0, position: 'absolute' }, viewBox: '0 0 100 100',
                children: jsx('rect', { fill: 'none', height: 99, pathLength: 1, stroke: 'rgba(96,165,250,0.85)', strokeWidth: 0.8, style: { vectorEffect: 'non-scaling-stroke' }, width: 99, x: 0.5, y: 0.5 })
              }),
              jsx('div', { className: 'jv-scan', style: { inset: 0, position: 'absolute' } }),
              jsx(Decipher, { delay: 120, style: { fontFamily: T.label, fontSize: '17px', fontWeight: 600, letterSpacing: '0.1em', textTransform: 'uppercase' }, text: String(display.detail.name || '') }),
              jsxs('div', {
                style: { color: STATUS_COLOR[display.detail.status] || '#60A5FA', display: 'flex', fontFamily: T.label, fontSize: '10px', gap: '14px', letterSpacing: '0.22em', marginTop: '4px', textTransform: 'uppercase' },
                children: [display.detail.status, display.detail.priority].filter(Boolean).map(v => jsx('span', { className: 'jv-chip', children: v }, v))
              }),
              jsx('div', {
                style: { animation: 'jvFadeUp 400ms 200ms both', display: 'grid', gap: '3px 14px', gridTemplateColumns: '1fr 1fr', marginTop: '12px' },
                children: [
                  ['CLIENT', display.detail.client], ['COMPANY', display.detail.company],
                  ['PAYMENT', display.detail.payment], ['OWNER', display.detail.owner],
                  ['START', display.detail.start], ['TARGET', display.detail.target_end],
                  ['BUILD', display.detail.build_type]
                ].filter(([, v]) => v).map(([k, v]) =>
                  jsxs('div', { style: { display: 'flex', gap: '8px' }, children: [
                    jsx('span', { style: { ...LABEL, fontSize: '8.5px' }, children: k }),
                    jsx('span', { style: { fontFamily: T.data, fontSize: '10.5px', fontVariantNumeric: 'tabular-nums' }, children: String(v).slice(0, 34) })
                  ] }, k))
              }),
              (display.detail.note || display.detail.notes)
                ? jsx('div', { style: { animation: 'jvFadeUp 400ms 300ms both', borderLeft: '2px solid ' + (STATUS_COLOR[display.detail.status] || '#3B82F6'), color: 'rgba(139,161,188,0.95)', fontSize: '11px', lineHeight: 1.5, marginTop: '12px', paddingLeft: '10px' }, children: String(display.detail.note || display.detail.notes).slice(0, 300) })
                : null,
              Array.isArray(display.detail.task_list) && display.detail.task_list.length
                ? jsx('div', {
                    style: { animation: 'jvFadeUp 400ms 380ms both', marginTop: '12px' },
                    children: display.detail.task_list.slice(0, 10).map((task, i) =>
                      jsxs('div', { style: { alignItems: 'center', display: 'flex', fontSize: '10.5px', gap: '9px', opacity: task.done ? 0.55 : 1, padding: '2.5px 0' }, children: [
                        jsx('span', { style: { color: task.done ? '#34D399' : 'rgba(96,165,250,0.9)', fontFamily: T.data, fontSize: '9px' }, children: task.done ? '\u25a0' : '\u25a1' }),
                        jsx('span', { style: { textDecoration: task.done ? 'line-through' : 'none' }, children: String(task.label).slice(0, 52) })
                      ] }, i))
                  })
                : null
            ]
          })
        : null,
      // instrument zones: dense by default — jobs, activity, metrics
      jobs.length
        ? jsxs('div', {
            style: { background: 'rgba(4,9,17,0.6)', border: '1px solid rgba(59,130,246,0.22)', bottom: '52px', clipPath: 'polygon(8px 0, 100% 0, 100% 100%, 0 100%, 0 8px)', left: '2.8%', padding: '9px 12px', pointerEvents: 'none', position: 'absolute', width: '240px', zIndex: 2 },
            children: [
              jsx('div', { style: { ...LABEL, fontSize: '8.5px', marginBottom: '6px' }, children: 'SCHEDULED OPERATIONS' }),
              ...jobs.map((job, i) =>
                jsxs('div', { style: { alignItems: 'baseline', animation: 'jvFadeUp 400ms ' + i * 90 + 'ms both', display: 'flex', fontSize: '9.5px', gap: '8px', justifyContent: 'space-between', padding: '2px 0' }, children: [
                  jsx('span', { style: { color: '#D9E6F2', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: String(job.name || job.id || '').slice(0, 30) }),
                  jsx('span', { style: { color: 'rgba(96,165,250,0.85)', fontFamily: T.data, fontSize: '8.5px', whiteSpace: 'nowrap' }, children: String(job.schedule_display || job.schedule?.display || '').slice(0, 12) })
                ] }, job.id || i))
            ]
          })
        : null,
      activity.length
        ? jsxs('div', {
            style: { background: 'rgba(4,9,17,0.6)', border: '1px solid rgba(59,130,246,0.22)', bottom: '52px', clipPath: 'polygon(0 0, calc(100% - 8px) 0, 100% 8px, 100% 100%, 0 100%)', padding: '9px 12px', pointerEvents: 'none', position: 'absolute', right: '2.8%', width: '240px', zIndex: 2 },
            children: [
              jsx('div', { style: { ...LABEL, fontSize: '8.5px', marginBottom: '6px' }, children: 'LIVE ACTIVITY' }),
              ...activity.map(item =>
                jsxs('div', { style: { alignItems: 'baseline', animation: 'jvFadeUp 320ms both', display: 'flex', fontSize: '9px', gap: '8px', padding: '1.5px 0' }, children: [
                  jsx('span', { style: { color: 'rgba(96,165,250,0.75)', fontFamily: T.data, fontSize: '8px' }, children: item.at }),
                  jsx('span', { style: { color: 'rgba(217,230,242,0.9)', fontFamily: T.label, fontSize: '8.5px', letterSpacing: '0.14em' }, children: item.label })
                ] }, item.key))
            ]
          })
        : null,
      // edge tab: sessions/nav reachable without stock chrome
      jsx('div', {
        onClick: () => window.dispatchEvent(new CustomEvent('jarvis:chrome', { detail: { hide: false } })),
        style: { alignItems: 'center', background: 'rgba(59,130,246,0.10)', border: '1px solid rgba(59,130,246,0.35)', borderLeft: 'none', color: 'rgba(147,197,253,0.9)', cursor: 'pointer', display: 'flex', fontFamily: T.label, fontSize: '8px', height: '86px', justifyContent: 'center', left: 0, letterSpacing: '0.28em', padding: '0 3px', position: 'absolute', textTransform: 'uppercase', top: '44%', writingMode: 'vertical-rl', zIndex: 6 },
        children: 'NAV'
      }),
      // fullscreen toggle
      jsx('div', {
        onClick: () => {
          const root = document.documentElement

          if (document.fullscreenElement) {
            void document.exitFullscreen?.().catch(() => undefined)
            setIsFull(false)
          } else {
            void root.requestFullscreen?.().then(() => setIsFull(true)).catch(() => undefined)
          }
        },
        style: { color: 'rgba(96,165,250,0.8)', cursor: 'pointer', fontFamily: T.label, fontSize: '8.5px', letterSpacing: '0.28em', padding: '4px 8px', position: 'absolute', right: '48px', bottom: '17px', textTransform: 'uppercase', zIndex: 6 },
        children: isFull ? 'EXIT FULLSCREEN' : 'FULLSCREEN'
      }),
      // boot overlay
      !booted
        ? jsxs('div', {
            onClick: () => setBooted(true),
            style: { alignItems: 'center', background: 'rgba(1, 2, 6, 0.92)', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: '14px', inset: 0, justifyContent: 'center', position: 'absolute', zIndex: 9 },
            children: [
              jsx('div', { style: { animation: 'jvBootIn 700ms 150ms both', background: 'rgba(96,165,250,0.7)', height: '1px', width: '260px' } }),
              jsx('div', { style: { animation: 'jvFadeUp 500ms 480ms both', color: '#D9E6F2', fontFamily: T.label, fontSize: '26px', fontWeight: 600, letterSpacing: '0.6em', textIndent: '0.6em', textShadow: '0 0 22px rgba(59,130,246,0.6)' }, children: 'JARVIS' }),
              jsx('div', { style: { animation: 'jvFadeUp 500ms 850ms both', ...LABEL, color: 'rgba(96,165,250,0.95)' }, children: 'SYSTEMS ONLINE' }),
              jsx('div', { style: { animation: 'jvBootIn 700ms 150ms both', background: 'rgba(96,165,250,0.7)', height: '1px', width: '260px' } })
            ]
          })
        : null,
      jsx('div', {
        style: { inset: 0, pointerEvents: 'none', position: 'absolute' },
        children: [
          ...display.rows.map((row, index) =>
            jsx(ProjectCard, { dissolving: display.dissolving, focus: false, index, row, shown: display.shown }, row.name || String(index))),
          display.focus
            ? jsx(ProjectCard, { dissolving: display.dissolving, focus: true, index: 0, row: display.focus, shown: true }, 'focus')
            : null
        ]
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

// The route must never sit on the host's crash card: any render throw lands
// on a minimal recovering plate with a remount control, and the voice stack
// (feature-side) keeps running underneath untouched.
class HudBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  render() {
    if (!this.state.error) {
      return this.props.children
    }

    return jsxs('div', {
      style: {
        alignItems: 'center', background: '#02040A', color: '#D9E6F2', display: 'flex',
        flexDirection: 'column', gap: '12px', height: '100%', inset: 0, justifyContent: 'center', position: 'absolute'
      },
      children: [
        jsx('div', { style: { color: 'rgba(96,165,250,0.9)', fontFamily: T.label, fontSize: '12px', letterSpacing: '0.4em', textTransform: 'uppercase' }, children: 'HUD RECOVERING' }),
        jsx('div', { style: { color: 'rgba(122,150,183,0.8)', fontFamily: T.data, fontSize: '10px', maxWidth: '420px', textAlign: 'center' }, children: String(this.state.error?.message ?? this.state.error).slice(0, 160) }),
        jsx('button', {
          onClick: () => this.setState({ error: null }),
          style: { background: 'transparent', border: '1px solid rgba(96,165,250,0.5)', color: '#93C5FD', cursor: 'pointer', fontFamily: T.label, fontSize: '10px', letterSpacing: '0.3em', padding: '6px 18px', textTransform: 'uppercase' },
          children: 'REMOUNT'
        })
      ]
    })
  }
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
        render: () => jsx(HudBoundary, { children: jsx(HudPage, {}) })
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

    // Command mode is home: the SDK has no home-route claim, so on a fresh
    // boot landing on the app's default route, step into the cockpit.
    // Deep links and explicit routes are respected (only '' and '/' redirect).
    ctx.onDispose(
      (() => {
        const timer = window.setTimeout(() => {
          const hash = String(window.location.hash || '').replace(/^#/, '')

          if (hash === '' || hash === '/') {
            host.navigate('/hud')
          }
        }, 1200)

        return () => window.clearTimeout(timer)
      })()
    )

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
