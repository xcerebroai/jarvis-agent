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
  if (window.__jvNoOrb) {
    return () => undefined
  }

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

// --- The unified plate language: A's frame, B's guts ------------------------
// One primitive for every panel on the cockpit. The frame is light — an open
// border that draws itself (top+right, then left+bottom), a status-colored
// corner arc, a rounded trailing arc, breathing corner nodes, filament ticks,
// a projection thread toward the orb, a ±3px drift — and the content is data:
// header rail, deciphering title, hazard strip when blocked, tabular block,
// segment-charging bar, per-task ticks, a NEXT line. No filled rectangles:
// the background is the void. Every motion is transform/opacity only, and the
// drifting wrapper is its own compositor layer, so eight-plus plates hold
// frame rate; motion starts only on real events (data arriving, a task
// starting, a replay the owner asked for).
const STATUS_COLOR = {
  Blocked: '#F87171',
  'Build Mode': '#60A5FA',
  Live: '#34D399',
  'Payment Follow-Up': '#FBBF24',
  Planning: '#7A8CA3',
  Ready: '#93C5FD',
  Testing: '#A78BFA'
}

const EASE = 'cubic-bezier(0.22, 1, 0.36, 1)'
const LINE = 'rgba(147,197,253,0.85)'
const LINE_DIM = 'rgba(96,165,250,0.55)'
const GLOW = '0 0 6px rgba(96,165,250,0.5)'
const INK = '#D9E6F2'
const INK_DIM = 'rgba(139,161,188,0.95)'

const COCKPIT_CSS = `
@keyframes jvBreathe { 0%, 100% { opacity: 0.55; } 50% { opacity: 1; } }
@keyframes jvSpin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
@keyframes jvSpinR { from { transform: rotate(0deg); } to { transform: rotate(-360deg); } }
@keyframes jvSweep { 0% { background-position: -200% 0; } 100% { background-position: 300% 0; } }
@keyframes jvBootIn { from { opacity: 0; transform: scaleX(0); } to { opacity: 1; transform: scaleX(1); } }
@keyframes jvFadeUp { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
@keyframes jvDrift { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-3px); } }
@keyframes jvBlink { 0%, 100% { opacity: 1; } 50% { opacity: 0.15; } }
.jv-chip { animation: jvBreathe 2.4s ease-in-out infinite; }
.jv-drift { animation: jvDrift 7s ease-in-out infinite; will-change: transform; }
.jv-sweep { background-image: linear-gradient(90deg, transparent 0%, rgba(147,197,253,0.6) 50%, transparent 100%); background-size: 38% 100%; background-repeat: no-repeat; animation: jvSweep 1.7s linear infinite; }
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

  return jsx('span', { style, children: shown || ' ' })
}

/** shown flips false→true ~80ms after every key change so transitions re-run. */
function useMaterialize(key) {
  const [shown, setShown] = useState(false)

  useEffect(() => {
    setShown(false)
    const t = window.setTimeout(() => setShown(true), 80)

    return () => window.clearTimeout(t)
  }, [key])

  return shown
}

// --- layout:begin
// The cockpit grid: two columns of four slots flanking the orb. Every panel —
// project card, task plate, build plate — CLAIMS a slot; nothing is ever
// positioned over another panel. Operations (builds, then the task) claim
// the right column top-down first, then the left; cards reflow into whatever
// is left (left column first). The detail stage owns the whole right column
// while it is open. Cards that no longer fit are hidden and counted.
const GRID = { cardWidth: 256, opWidth: 292, pitch: 20.5, side: 2.8, slots: 4, top: 9 }

function computeCockpitLayout({ cards, detailOpen, ops }) {
  const column = side => Array.from({ length: GRID.slots }, (_, slot) => ({ side, slot }))
  const rightSlots = detailOpen ? [] : column('right')
  const leftSlots = column('left')
  const opOrder = [...rightSlots, ...leftSlots]
  const taken = new Set()
  const opPos = []

  for (let i = 0; i < ops; i++) {
    const pos = opOrder[i] || null

    opPos.push(pos)

    if (pos) {
      taken.add(pos.side + pos.slot)
    }
  }

  const cardOrder = [...leftSlots, ...rightSlots].filter(pos => !taken.has(pos.side + pos.slot))
  const cardPos = Array.from({ length: cards }, (_, j) => cardOrder[j] || null)

  return { cards: cardPos, hidden: Math.max(0, cards - cardOrder.length), ops: opPos }
}

function slotStyle(pos, width) {
  return {
    [pos.side]: GRID.side + '%',
    maxHeight: 'calc(' + GRID.pitch + '% - 12px)',
    top: GRID.top + pos.slot * GRID.pitch + '%',
    width: width + 'px'
  }
}
// --- layout:end

/**
 * The frame + content shell. `shown` drives the draw; `delay` staggers it
 * (board cards draw on successive orb pulses); `thread` points at the orb:
 * 'left' for right-column plates, 'right' for left-column plates, 'down' for
 * the center column, false for the rails. `phase` desyncs the drift.
 */
function Plate({ children, color = '#60A5FA', delay = 0, drift = true, phase = 0, shown, style, thread = 'left', width }) {
  const at = ms => delay + ms + 'ms'
  const line = (pos, axis, ms, key, dim) =>
    jsx('div', {
      style: {
        background: dim ? LINE_DIM : LINE, boxShadow: GLOW, position: 'absolute', ...pos,
        transform: shown ? 'scale(1)' : axis === 'x' ? 'scaleX(0)' : 'scaleY(0)',
        transition: 'transform 640ms ' + EASE + ' ' + at(ms)
      }
    }, key)
  const arc = (pos, d, stroke, ms, key, size) =>
    jsx('svg', {
      height: size, style: { overflow: 'visible', position: 'absolute', ...pos }, viewBox: '0 0 ' + size + ' ' + size, width: size,
      children: jsx('path', { d, fill: 'none', pathLength: 1, stroke, strokeWidth: 1.2, style: { filter: 'drop-shadow(0 0 3px ' + stroke + ')', strokeDasharray: 1, strokeDashoffset: shown ? 0 : 1, transition: 'stroke-dashoffset 700ms ' + EASE + ' ' + at(ms) } })
    }, key)
  const node = (pos, ms, key, tint) =>
    jsx('div', { className: 'jv-chip', style: { background: tint, borderRadius: '50%', boxShadow: '0 0 5px ' + tint, height: '3px', position: 'absolute', width: '3px', ...pos, opacity: shown ? 1 : 0, transition: 'opacity 400ms ' + at(ms) } }, key)
  const threadStyle = thread === 'left'
    ? { background: 'linear-gradient(90deg, transparent, rgba(96,165,250,0.75))', height: '1px', left: '-46px', top: '52%', transform: shown ? 'scaleX(1)' : 'scaleX(0)', transformOrigin: 'right', width: '46px' }
    : thread === 'right'
      ? { background: 'linear-gradient(270deg, transparent, rgba(96,165,250,0.75))', height: '1px', right: '-46px', top: '52%', transform: shown ? 'scaleX(1)' : 'scaleX(0)', transformOrigin: 'left', width: '46px' }
      : thread === 'down'
        ? { background: 'linear-gradient(180deg, rgba(96,165,250,0.75), transparent)', bottom: '-36px', height: '36px', left: '50%', transform: shown ? 'scaleY(1)' : 'scaleY(0)', transformOrigin: 'top', width: '1px' }
        : null

  return jsx('div', {
    className: drift && shown ? 'jv-drift' : '',
    style: { animationDelay: -phase + 's', color: INK, pointerEvents: 'none', ...(width ? { width: width + 'px' } : {}), ...style },
    children: jsxs('div', {
      style: { opacity: shown ? 1 : 0, position: 'relative', transition: 'opacity 380ms ' + at(0), height: '100%', maxHeight: 'inherit' },
      children: [
        jsxs('div', {
          style: { inset: 0, pointerEvents: 'none', position: 'absolute' },
          children: [
            threadStyle ? jsx('div', { style: { position: 'absolute', transition: 'transform 560ms ' + EASE + ' ' + at(40), ...threadStyle } }) : null,
            line({ height: '1px', left: '14px', right: 0, top: 0, transformOrigin: 'left' }, 'x', 60, 'top'),
            line({ height: '44px', right: 0, top: 0, transformOrigin: 'top', width: '1px' }, 'y', 420, 'right'),
            line({ bottom: 0, left: 0, top: '14px', transformOrigin: 'top', width: '1px' }, 'y', 300, 'left', true),
            line({ bottom: 0, height: '1px', left: 0, right: '34px', transformOrigin: 'left' }, 'x', 640, 'bottom', true),
            arc({ left: 0, top: 0 }, 'M 1 14 A 13 13 0 0 1 14 1', color, 520, 'tl', 16),
            arc({ bottom: 0, right: 0 }, 'M 1 35 A 34 34 0 0 0 35 1', LINE_DIM, 780, 'br', 36),
            node({ left: '-1px', top: '13px' }, 700, 'n0', color),
            node({ left: '13px', top: '-1px' }, 820, 'n1', '#93C5FD'),
            node({ right: '-1px', top: '43px' }, 940, 'n2', '#93C5FD'),
            node({ bottom: '-1px', right: '33px' }, 1060, 'n3', '#93C5FD'),
            ...[0, 1, 2, 3, 4].map(i =>
              jsx('div', { style: { background: LINE, bottom: 0, height: '5px', left: 52 + i * 22 + 'px', opacity: shown ? 0.8 : 0, position: 'absolute', transition: 'opacity 300ms ' + at(1000 + i * 70), width: '1px' } }, 't' + i))
          ]
        }),
        jsx('div', { style: { overflow: 'hidden', padding: '9px 14px 12px 15px', position: 'relative', maxHeight: 'inherit' }, children })
      ]
    })
  })
}

// --- B's guts, as reusable instruments -------------------------------------
function Rail({ left, right }) {
  return jsxs('div', {
    style: { color: 'rgba(122,150,183,0.9)', display: 'flex', fontFamily: T.data, fontSize: '7.5px', gap: '8px', justifyContent: 'space-between', letterSpacing: '0.2em', whiteSpace: 'nowrap' },
    children: [jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis' }, children: left }), right ? jsx('span', { style: { flexShrink: 0 }, children: right }) : null]
  })
}

/** Title: deciphers in while its tracking collapses from 0.34em to 0.08em. */
function Title({ delay = 0, shown, size = 12, text }) {
  return jsx('div', {
    style: { display: 'block', fontFamily: T.label, fontSize: size + 'px', fontWeight: 600, letterSpacing: shown ? '0.08em' : '0.34em', lineHeight: 1.2, marginTop: '4px', overflow: 'hidden', textOverflow: 'ellipsis', textShadow: '0 0 12px rgba(96,165,250,0.45)', textTransform: 'uppercase', transition: 'letter-spacing 900ms ' + EASE + ' ' + delay + 'ms', whiteSpace: 'nowrap' },
    children: shown ? jsx(Decipher, { delay: delay + 40, text }) : ' '
  })
}

function Chip({ blink, color, delay = 0, shown, text }) {
  return jsxs('div', {
    style: { display: 'inline-flex', flexDirection: 'column', flexShrink: 0 },
    children: [
      jsx('span', { className: blink ? 'jv-chip' : '', style: { color, fontFamily: T.label, fontSize: '8px', letterSpacing: '0.28em', opacity: shown ? 1 : 0, textShadow: '0 0 8px ' + color, textTransform: 'uppercase', transition: 'opacity 400ms ' + delay + 'ms' }, children: text }),
      jsx('div', { style: { background: color, boxShadow: '0 0 5px ' + color, height: '1px', marginTop: '2px', transform: shown ? 'scaleX(1)' : 'scaleX(0)', transformOrigin: 'left', transition: 'transform 600ms ' + EASE + ' ' + (delay + 80) + 'ms' } })
    ]
  })
}

function Hazard({ delay = 0, shown, text }) {
  return jsxs('div', {
    style: { alignItems: 'baseline', background: 'repeating-linear-gradient(135deg, rgba(248,113,113,0.14) 0 5px, transparent 5px 11px)', borderLeft: '2px solid #F87171', display: 'flex', fontSize: '8.5px', gap: '6px', lineHeight: 1.35, marginTop: '5px', opacity: shown ? 1 : 0, padding: '2px 6px', transition: 'opacity 300ms ' + delay + 'ms' },
    children: [
      jsx('span', { style: { animation: 'jvBlink 1.1s steps(2) infinite', color: '#F87171', fontFamily: T.data, fontSize: '8px' }, children: '■' }),
      jsx('span', { style: { color: '#FCA5A5', fontFamily: T.label, fontSize: '8px', letterSpacing: '0.22em' }, children: 'BLOCKED' }),
      shown ? jsx(Decipher, { delay: delay + 60, style: { color: 'rgba(217,230,242,0.9)', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, text }) : null
    ]
  })
}

function DataGrid({ cols = 4, delay = 0, items, shown }) {
  return jsx('div', {
    style: { display: 'grid', gap: '3px 8px', gridTemplateColumns: 'repeat(' + cols + ', minmax(0, 1fr))', marginTop: '6px' },
    children: items.map(([label, value], i) =>
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '1px', minWidth: 0 }, children: [
        jsx('span', { style: { ...LABEL, fontSize: '6.5px', letterSpacing: '0.24em' }, children: label }),
        jsx('span', { style: { color: INK, fontFamily: T.data, fontSize: '9px', fontVariantNumeric: 'tabular-nums', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: shown ? jsx(Decipher, { delay: delay + i * 70, text: String(value) }) : ' ' })
      ] }, label))
  })
}

function ChargeBar({ color, delay = 0, done, shown, total }) {
  const SEG = 12
  const frac = total ? done / total : 0
  const filled = Math.round(frac * SEG)

  return jsxs('div', {
    style: { alignItems: 'center', display: 'flex', gap: '8px', marginTop: '7px' },
    children: [
      jsx('div', { style: { display: 'flex', flex: 1, gap: '2px' }, children: Array.from({ length: SEG }, (_, i) =>
        jsx('div', { style: { background: i < filled ? color : 'rgba(59,130,246,0.16)', boxShadow: i < filled ? '0 0 4px ' + color : 'none', flex: 1, height: '4px', opacity: shown ? 1 : 0, transform: shown ? 'scaleY(1)' : 'scaleY(0)', transition: 'opacity 120ms ' + (delay + i * 40) + 'ms, transform 160ms ' + EASE + ' ' + (delay + i * 40) + 'ms' } }, i)) }),
      jsx('span', { style: { color: 'rgba(147,197,253,0.9)', fontFamily: T.data, fontSize: '8.5px', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }, children: done + '/' + total + ' · ' + Math.round(frac * 100) + '%' })
    ]
  })
}

function TickRow({ color, delay = 0, done, shown, total }) {
  if (!total) {
    return null
  }

  return jsxs('div', {
    style: { alignItems: 'center', display: 'flex', gap: '6px', marginTop: '5px' },
    children: [
      jsx('span', { style: { ...LABEL, fontSize: '6.5px' }, children: 'TASKS' }),
      jsx('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '3px' }, children: Array.from({ length: Math.min(total, 24) }, (_, i) =>
        jsx('div', { style: { background: i < done ? color : 'transparent', border: '1px solid ' + (i < done ? color : 'rgba(96,165,250,0.5)'), height: '5px', opacity: shown ? 1 : 0, transition: 'opacity 150ms ' + (delay + i * 35) + 'ms', width: '5px' } }, i)) })
    ]
  })
}

function NextLine({ delay = 0, label = 'NEXT ▸', shown, text }) {
  if (!text) {
    return null
  }

  return jsxs('div', {
    style: { color: INK_DIM, fontSize: '8.5px', lineHeight: 1.4, marginTop: '5px', opacity: shown ? 1 : 0, overflow: 'hidden', textOverflow: 'ellipsis', transition: 'opacity 400ms ' + delay + 'ms', whiteSpace: 'nowrap' },
    children: [jsx('span', { style: { color: '#93C5FD', fontFamily: T.label, fontSize: '7.5px', letterSpacing: '0.22em', marginRight: '6px' }, children: label }), String(text).slice(0, 90)]
  })
}

/** Activity line: the sweep for running work (no fake progress). */
function Sweep() {
  return jsx('div', { className: 'jv-sweep', style: { background: 'rgba(59,130,246,0.14)', height: '1px', marginTop: '7px' } })
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC']

/** "2026-08-12" → "AUG 12" — fits a 4-column data block at cockpit width. */
function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''))

  return m ? MONTHS[Number(m[2]) - 1] + ' ' + m[3] : iso ? String(iso).slice(0, 8) : '—'
}

function projectFacts(row) {
  const done = row.tasks_done ?? 0
  const total = row.tasks_total ?? 0
  const days = typeof row.days_to_deadline === 'number' ? row.days_to_deadline : null

  return {
    color: STATUS_COLOR[row.status] || '#60A5FA',
    countdown: days === null ? '—' : days < 0 ? 'T+' + Math.abs(days) + 'D' : 'T−' + days + 'D',
    done,
    note: String(row.note || ''),
    revenue: String(row.revenue_relevance || '—').toUpperCase() + (row.revenue_outstanding ? ' $' + Math.round(row.revenue_outstanding) : ''),
    stale: typeof row.staleness_days === 'number' ? row.staleness_days + 'D' : '—',
    total
  }
}

// One board card. delay = its place in the projection (it draws on its own
// orb pulse). Focus = the show_project verb's larger stage version.
function ProjectPlate({ delay, dissolving, focus, index, pos, row, shown, updated }) {
  const f = projectFacts(row)
  const visible = shown && !dissolving
  const width = focus ? 350 : GRID.cardWidth
  const style = focus
    ? { left: '56%', position: 'absolute', top: '17%', zIndex: 3 }
    : { position: 'absolute', zIndex: 2, ...slotStyle(pos, GRID.cardWidth) }
  const d = dissolving ? Math.max(0, 3 - index) * 40 : delay

  return jsx(Plate, {
    color: f.color, delay: d, phase: index * 1.3, shown: visible, style, thread: focus ? 'left' : pos.side === 'left' ? 'right' : 'left', width,
    children: jsxs('div', { children: [
      jsx(Rail, { left: 'PROJECT · ' + String(row.priority || 'NORMAL').toUpperCase(), right: updated ? 'IDX ' + updated : '' }),
      jsxs('div', { style: { alignItems: 'flex-end', display: 'flex', gap: '8px', justifyContent: 'space-between' }, children: [
        jsx('div', { style: { minWidth: 0 }, children: jsx(Title, { delay: d + 120, shown: visible, size: focus ? 15 : 12, text: String(row.name || '') }) }),
        jsx(Chip, { blink: row.status === 'Blocked' || row.status === 'Build Mode', color: f.color, delay: d + 420, shown: visible, text: String(row.status || '') })
      ] }),
      row.status === 'Blocked' && f.note ? jsx(Hazard, { delay: d + 380, shown: visible, text: f.note.slice(0, 70) }) : null,
      jsx(DataGrid, { delay: d + 520, items: [['DEADLINE', shortDate(row.deadline || row.target_end)], ['COUNTDOWN', f.countdown], ['STALE', f.stale], ['REVENUE', f.revenue]], shown: visible }),
      f.total ? jsx(ChargeBar, { color: f.color, delay: d + 500, done: f.done, shown: visible, total: f.total }) : null,
      jsx(TickRow, { color: f.color, delay: d + 980, done: f.done, shown: visible, total: f.total }),
      jsx(NextLine, { delay: d + 1150, shown: visible, text: row.next_action || (row.status !== 'Blocked' ? f.note : '') })
    ] })
  })
}

// --- Operation plates: task / build / sight / judgment, same language ------
const STATE_COLOR = { cancelled: '#F87171', done: '#34D399', failed: '#F87171', idle: '#7A8CA3', planning: '#60A5FA', running: '#93C5FD', waiting: '#FBBF24', working: '#93C5FD' }

function elapsedLabel(sinceMs) {
  const seconds = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000))

  return seconds < 3600
    ? Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0')
    : Math.floor(seconds / 3600) + 'h' + String(Math.floor((seconds % 3600) / 60)).padStart(2, '0')
}

function Meta({ items }) {
  return jsx('div', {
    style: { color: 'rgba(96,165,250,0.85)', display: 'flex', flexWrap: 'wrap', fontFamily: T.data, fontSize: '8px', fontVariantNumeric: 'tabular-nums', gap: '10px', letterSpacing: '0.1em', marginTop: '4px' },
    children: items.filter(Boolean).map((item, i) => jsx('span', { style: { opacity: item.dim ? 0.5 : 0.85 }, children: item.text }, i))
  })
}

function Body({ color, delay = 0, mono, shown, text }) {
  if (!text) {
    return null
  }

  return jsx('div', {
    style: { borderLeft: '1px solid ' + (color || LINE_DIM), color: mono ? INK_DIM : 'rgba(217,230,242,0.95)', fontFamily: mono ? T.data : 'inherit', fontSize: mono ? '8.5px' : '10px', lineHeight: 1.5, marginTop: '7px', maxHeight: '58px', opacity: shown ? 1 : 0, overflow: 'hidden', paddingLeft: '8px', transition: 'opacity 400ms ' + delay + 'ms', whiteSpace: 'pre-wrap' },
    children: text
  })
}

// The task pop: the plate draws on voice.task.started (its own key), the
// orb gathers, and the stream tail is the agent's real output.
function TaskPlate({ clock, pos, task }) {
  const shown = useMaterialize(task.id)
  const color = STATE_COLOR[task.status] || '#93C5FD'
  const kindLabel = task.kind === 'research' ? 'RESEARCH OPERATION' : task.kind === 'browser' ? 'BROWSER OPERATION · WATCH THE SCREEN' : 'TASK OPERATION'

  return jsx(Plate, {
    color, delay: 0, phase: 2.1, shown, style: { opacity: task.status === 'cancelled' ? 0.65 : 1, position: 'absolute', zIndex: 3, ...slotStyle(pos, GRID.opWidth) }, thread: pos.side === 'left' ? 'right' : 'left', width: GRID.opWidth,
    children: jsxs('div', { children: [
      jsxs('div', { style: { alignItems: 'baseline', display: 'flex', gap: '8px', justifyContent: 'space-between' }, children: [
        jsx(Rail, { left: kindLabel }),
        jsx(Chip, { blink: task.status === 'running', color, delay: 300, shown, text: task.status === 'running' ? 'RUNNING' : task.status === 'done' ? 'COMPLETE' : 'CANCELLED' })
      ] }),
      jsx(Title, { delay: 120, shown, size: 11.5, text: task.goal.slice(0, 90) }),
      jsx(Meta, { items: [{ text: 'T+' + elapsedLabel(task.startedAt) }, task.sessionId ? { text: 'SESSION LINKED' } : { dim: true, text: 'LINKING…' }] }),
      task.status === 'running' ? jsx(Sweep, {}) : null,
      task.tools.length
        ? jsx('div', { style: { color: task.tools.includes('browser_vision') ? '#93C5FD' : 'rgba(122,150,183,0.9)', fontFamily: T.label, fontSize: '7.5px', letterSpacing: '0.2em', marginTop: '6px', textTransform: 'uppercase' }, children: 'TOOLS · ' + task.tools.map(t => t.replace(/_/g, ' ')).join(' · ') })
        : null,
      task.media.length
        ? jsx('div', { style: { display: 'flex', gap: '6px', marginTop: '6px' }, children: task.media.map((m, i) =>
            jsx('img', { alt: '', src: m.thumbnail, style: { animation: 'jvFadeUp 400ms both', border: '1px solid rgba(96,165,250,0.4)', height: '40px', objectFit: 'cover', objectPosition: 'top', width: task.media.length > 1 ? '84px' : '100%' } }, m.path || i)) })
        : null,
      task.status === 'done' && task.summary
        ? jsx(Body, { color: 'rgba(52,211,153,0.6)', delay: 120, shown, text: task.summary.slice(0, 520) })
        : task.tail ? jsx(Body, { delay: 0, mono: true, shown, text: task.tail }) : null
    ] })
  })
}

function BuildPlate({ build, clock, pos }) {
  const state = build.inFlight ? (build.state === 'planning' ? 'planning' : 'working') : build.state || 'idle'
  const color = STATE_COLOR[state] || '#60A5FA'
  const shown = useMaterialize(build.id)
  const since = build.inFlight && build.turnStartedAt ? build.turnStartedAt : Date.parse(build.created_at || '') || Date.now()

  return jsx(Plate, {
    color, phase: 3.4 + pos.slot, shown, style: { opacity: state === 'done' ? 0.8 : 1, position: 'absolute', zIndex: 3, ...slotStyle(pos, GRID.opWidth) }, thread: pos.side === 'left' ? 'right' : 'left', width: GRID.opWidth,
    children: jsxs('div', { children: [
      jsxs('div', { style: { alignItems: 'baseline', display: 'flex', gap: '8px', justifyContent: 'space-between' }, children: [
        jsx(Rail, { left: 'BUILD SESSION' }),
        jsx(Chip, { blink: Boolean(build.inFlight), color, delay: 300, shown, text: state === 'waiting' ? 'WAITING FOR YOU' : state.toUpperCase() })
      ] }),
      jsx(Title, { delay: 120, shown, text: String(build.name || '').slice(0, 60) }),
      jsx(Meta, { items: [{ text: (build.inFlight ? 'STEP T+' : 'AGE ') + elapsedLabel(since) }, build.session_id ? { text: 'SESSION LINKED' } : { dim: true, text: 'SESSION PENDING' }, build.project_id ? { text: 'ON BOARD' } : null] }),
      build.inFlight ? jsx(Sweep, {}) : null,
      build.lastTool ? jsx(NextLine, { delay: 200, label: 'TOOL ▸', shown, text: String(build.lastTool).replace(/_/g, ' ') }) : null,
      build.inFlight && build.tail
        ? jsx(Body, { delay: 0, mono: true, shown, text: build.tail })
        : build.last_summary
          ? jsx(Body, { color, delay: 200, shown, text: String(build.last_summary).slice(0, 200) })
          : jsx(NextLine, { delay: 300, label: 'GOAL ▸', shown, text: String(build.goal || '') })
    ] })
  })
}

function SightPlate({ sight }) {
  const shown = useMaterialize(sight.at)
  const color = sight.status === 'failed' ? '#F87171' : sight.status === 'done' ? '#34D399' : '#93C5FD'
  const target = sight.target

  return jsx(Plate, {
    color, drift: false, shown, thread: 'down', width: 440,
    children: jsxs('div', { children: [
      jsxs('div', { style: { alignItems: 'baseline', display: 'flex', gap: '8px', justifyContent: 'space-between' }, children: [
        jsx(Rail, { left: 'SIGHT · SCREEN CAPTURE', right: target ? (target.kind === 'window' ? 'TARGET · ' + String(target.app || 'WINDOW').toUpperCase().slice(0, 22) : 'TARGET · DISPLAY ' + (target.display_index || 1) + (target.includes_self ? ' · INCLUDES JARVIS' : '')) : sight.app ? 'TARGET · ' + String(sight.app).toUpperCase().slice(0, 22) : '' }),
        jsx(Chip, { blink: sight.status === 'capturing', color, delay: 200, shown, text: sight.status === 'capturing' ? 'CAPTURING · ANALYZING' : sight.status === 'done' ? 'ANALYZED' : 'FAILED' })
      ] }),
      sight.question ? jsx(Title, { delay: 100, shown, size: 10.5, text: String(sight.question).slice(0, 80) }) : null,
      target?.title ? jsx(NextLine, { delay: 300, label: 'WINDOW ▸', shown, text: String(target.title).slice(0, 70) }) : null,
      sight.status === 'capturing' ? jsx(Sweep, {}) : null,
      sight.thumbnail ? jsx('img', { alt: '', src: sight.thumbnail, style: { animation: 'jvFadeUp 400ms both', border: '1px solid rgba(96,165,250,0.4)', display: 'block', marginTop: '8px', maxHeight: '150px', objectFit: 'cover', objectPosition: 'top', width: '100%' } }) : null,
      sight.status === 'done' && sight.answer ? jsx(Body, { color: 'rgba(52,211,153,0.6)', delay: 150, shown, text: String(sight.answer).slice(0, 360) }) : null,
      sight.status === 'failed' ? jsx('div', { style: { color: '#F87171', fontSize: '10px', marginTop: '6px' }, children: sight.permission ? 'Screen Recording permission needed — enable JARVIS in System Settings › Privacy & Security' : String(sight.error).slice(0, 160) }) : null,
      sight.status === 'done'
        ? jsx(DataGrid, { cols: 5, delay: 200, items: [['LOOK', (sight.latencyMs / 1000).toFixed(1) + 's'], ['CAPTURE', (sight.captureMs ?? '?') + 'ms'], ['VISION', (sight.analyzeMs ?? '?') + 'ms'], ['COST', typeof sight.costUsd === 'number' ? '$' + sight.costUsd.toFixed(4) + ' est' : 'n/a'], ['TOKENS', sight.usage?.total_tokens ? String(sight.usage.total_tokens) : '—']], shown })
        : null
    ] })
  })
}

function JudgmentPlate({ judgment }) {
  const shown = useMaterialize(judgment.at)
  const color = judgment.status === 'failed' ? '#F87171' : judgment.status === 'done' ? '#34D399' : '#93C5FD'

  return jsx(Plate, {
    color, drift: false, shown, thread: 'down', width: 440,
    children: jsxs('div', { children: [
      jsxs('div', { style: { alignItems: 'baseline', display: 'flex', gap: '8px', justifyContent: 'space-between' }, children: [
        jsx(Rail, { left: 'JUDGMENT · FULL AGENT · WHOLE BOARD' }),
        jsx(Chip, { blink: judgment.status === 'reasoning', color, delay: 200, shown, text: judgment.status === 'reasoning' ? 'REASONING' : judgment.status === 'done' ? 'ANSWERED' : 'NO ANSWER' })
      ] }),
      judgment.question ? jsx(Title, { delay: 100, shown, size: 10.5, text: String(judgment.question).slice(0, 90) }) : null,
      judgment.status === 'reasoning'
        ? jsxs('div', { children: [jsx(Sweep, {}), jsx(Meta, { items: [{ text: 'T+' + Math.max(0, Math.floor((Date.now() - judgment.at) / 1000)) + 's · BUDGET 5–10s' }] })] })
        : null,
      judgment.status === 'done' ? jsx(Body, { color: 'rgba(52,211,153,0.6)', delay: 150, shown, text: String(judgment.answer).slice(0, 460) }) : null,
      judgment.status === 'failed' ? jsx('div', { style: { color: '#F87171', fontSize: '10px', marginTop: '6px' }, children: String(judgment.error).slice(0, 120) }) : null,
      judgment.status !== 'reasoning' && typeof judgment.elapsedMs === 'number'
        ? jsx(Meta, { items: [{ text: 'T ' + (judgment.elapsedMs / 1000).toFixed(1) + 's' + (judgment.elapsedMs > 10_000 ? ' · OVER BUDGET' : ' · WITHIN BUDGET') }] })
        : null
    ] })
  })
}

// The expand verb's instrument: the full record in the same language.
function DetailStage({ detail }) {
  const shown = useMaterialize(detail.name)
  const f = projectFacts(detail)
  const tasks = Array.isArray(detail.task_list) ? detail.task_list : []
  const facts = [['CLIENT', detail.client], ['COMPANY', detail.company], ['PAYMENT', detail.payment], ['OWNER', detail.owner], ['START', detail.start], ['TARGET', detail.target_end], ['BUILD', detail.build_type], ['DEADLINE', detail.deadline || detail.target_end], ['COUNTDOWN', f.countdown], ['STALE', f.stale], ['REVENUE', f.revenue]].filter(([, v]) => v && v !== '—').map(([k, v]) => [k, String(v).slice(0, 34)])

  return jsx(Plate, {
    color: f.color, phase: 1.7, shown, style: { maxHeight: '78%', position: 'absolute', right: '3%', top: '10%', zIndex: 4 }, thread: 'left', width: 390,
    children: jsxs('div', { children: [
      jsx(Rail, { left: 'PROJECT DETAIL · ' + String(detail.priority || 'NORMAL').toUpperCase(), right: detail.id ? String(detail.id) : '' }),
      jsxs('div', { style: { alignItems: 'flex-end', display: 'flex', gap: '10px', justifyContent: 'space-between' }, children: [
        jsx('div', { style: { minWidth: 0 }, children: jsx(Title, { delay: 120, shown, size: 16, text: String(detail.name || '') }) }),
        jsx(Chip, { blink: detail.status === 'Blocked', color: f.color, delay: 400, shown, text: String(detail.status || '') })
      ] }),
      detail.status === 'Blocked' && (detail.note || detail.notes) ? jsx(Hazard, { delay: 380, shown, text: String(detail.note || detail.notes).slice(0, 90) }) : null,
      jsx(DataGrid, { cols: 3, delay: 500, items: facts, shown }),
      f.total ? jsx(ChargeBar, { color: f.color, delay: 700, done: f.done, shown, total: f.total }) : null,
      (detail.note || detail.notes) && detail.status !== 'Blocked' ? jsx(Body, { color: f.color, delay: 800, shown, text: String(detail.note || detail.notes).slice(0, 300) }) : null,
      tasks.length
        ? jsx('div', { style: { marginTop: '8px' }, children: tasks.slice(0, 12).map((task, i) =>
            jsxs('div', { style: { alignItems: 'center', display: 'flex', fontSize: '10px', gap: '8px', opacity: shown ? (task.done ? 0.55 : 1) : 0, padding: '2px 0', transition: 'opacity 250ms ' + (900 + i * 60) + 'ms' }, children: [
              jsx('div', { style: { background: task.done ? f.color : 'transparent', border: '1px solid ' + (task.done ? f.color : 'rgba(96,165,250,0.6)'), flexShrink: 0, height: '6px', width: '6px' } }),
              jsx('span', { style: { overflow: 'hidden', textDecoration: task.done ? 'line-through' : 'none', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: String(task.label).slice(0, 60) })
            ] }, i)) })
        : null
    ] })
  })
}

// Metric tiles: number, label, a filament underline that draws in. No box.
function MetricTiles({ rows, shown }) {
  const counts = {}

  rows.forEach(row => { counts[row.status] = (counts[row.status] || 0) + 1 })
  const done = rows.reduce((total, row) => total + (row.tasks_done || 0), 0)
  const total = rows.reduce((sum, row) => sum + (row.tasks_total || 0), 0)
  const tiles = [
    ...Object.entries(counts).map(([status, count]) => ({ color: STATUS_COLOR[status] || '#60A5FA', label: status, value: count })),
    { color: '#93C5FD', label: 'TASKS', value: done + '/' + total }
  ]

  return jsx('div', {
    style: { display: 'flex', gap: '18px', justifyContent: 'center', left: '50%', pointerEvents: 'none', position: 'absolute', top: '42px', transform: 'translateX(-50%)', zIndex: 5 },
    children: tiles.map((tile, i) =>
      jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '3px', minWidth: '52px', opacity: shown ? 1 : 0, transition: 'opacity 400ms ' + (200 + i * 70) + 'ms' }, children: [
        jsxs('div', { style: { alignItems: 'baseline', display: 'flex', gap: '6px' }, children: [
          jsx('span', { style: { color: tile.color, fontFamily: T.data, fontSize: '12px', fontVariantNumeric: 'tabular-nums', fontWeight: 600, textShadow: '0 0 8px ' + tile.color }, children: String(tile.value) }),
          jsx('span', { style: { ...LABEL, fontSize: '7px', letterSpacing: '0.22em' }, children: tile.label })
        ] }),
        jsx('div', { style: { background: tile.color, boxShadow: '0 0 5px ' + tile.color, height: '1px', opacity: 0.8, transform: shown ? 'scaleX(1)' : 'scaleX(0)', transformOrigin: 'left', transition: 'transform 600ms ' + EASE + ' ' + (300 + i * 70) + 'ms' } })
      ] }, tile.label))
  })
}

function JobsRail({ jobs }) {
  const shown = useMaterialize(jobs.length)

  return jsx(Plate, {
    drift: false, shown, style: { bottom: '52px', left: '2.8%', position: 'absolute', zIndex: 2 }, thread: false, width: 240,
    children: jsxs('div', { children: [
      jsx(Rail, { left: 'SCHEDULED OPERATIONS', right: jobs.length + ' JOB' + (jobs.length === 1 ? '' : 'S') }),
      ...jobs.map((job, i) =>
        jsxs('div', { style: { alignItems: 'baseline', display: 'flex', fontSize: '9.5px', gap: '8px', justifyContent: 'space-between', opacity: shown ? 1 : 0, padding: '3px 0 0', transition: 'opacity 300ms ' + (200 + i * 90) + 'ms' }, children: [
          jsx('span', { style: { color: INK, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: String(job.name || job.id || '').slice(0, 30) }),
          jsx('span', { style: { color: 'rgba(96,165,250,0.85)', fontFamily: T.data, fontSize: '8.5px', whiteSpace: 'nowrap' }, children: String(job.schedule_display || job.schedule?.display || '').slice(0, 12) })
        ] }, job.id || i))
    ] })
  })
}

function ActivityRail({ activity }) {
  const shown = useMaterialize(activity.length > 0)

  return jsx(Plate, {
    drift: false, shown, style: { bottom: '52px', position: 'absolute', right: '2.8%', zIndex: 2 }, thread: false, width: 240,
    children: jsxs('div', { children: [
      jsx(Rail, { left: 'LIVE ACTIVITY' }),
      ...activity.map(item =>
        jsxs('div', { style: { alignItems: 'baseline', animation: 'jvFadeUp 320ms both', display: 'flex', fontSize: '9px', gap: '8px', padding: '2px 0 0' }, children: [
          jsx('span', { style: { color: 'rgba(96,165,250,0.75)', fontFamily: T.data, fontSize: '8px' }, children: item.at }),
          jsx('span', { style: { color: 'rgba(217,230,242,0.9)', fontFamily: T.label, fontSize: '8.5px', letterSpacing: '0.14em', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: item.label }),
          item.detail ? jsx('span', { style: { color: 'rgba(96,165,250,0.8)', fontFamily: T.data, fontSize: '7.5px', marginLeft: 'auto', whiteSpace: 'nowrap' }, children: item.detail }) : null
        ] }, item.key))
    ] })
  })
}

function HudPage() {
  const canvasRef = useRef(null)
  const labelRef = useRef(null)
  const sourceRef = useRef(null)
  const busy = useValue(host.state.busy)
  const [display, setDisplay] = useState({ detail: null, dissolving: false, focus: null, rows: [], shown: false })
  // Delegated work (P5): one live task at a time, streaming the REAL pinned
  // session's deltas — the panel shows what the agent is actually writing.
  const [task, setTask] = useState(null)
  const taskRef = useRef(null)
  const taskTimersRef = useRef([])
  const pulseTimersRef = useRef([])
  const boardArmedRef = useRef(false)
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
  // P5.1 instruments: sight (one look at a time), judgment (one at a time),
  // and the build dock (persistent, restart-surviving plates).
  const [sight, setSight] = useState(null)
  const [judgment, setJudgment] = useState(null)
  const [builds, setBuilds] = useState([])
  const buildsRef = useRef([])
  const p51TimersRef = useRef({})

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
      'voice.task.cancelled': 'TASK CANCELLED',
      'voice.task.done': 'TASK COMPLETE',
      'voice.task.started': 'TASK DELEGATED',
      'voice.task.media': 'RESEARCH \u00b7 SCREENSHOT',
      'voice.sight.started': 'SIGHT \u00b7 CAPTURING',
      'voice.sight.done': 'SIGHT \u00b7 ANALYZED',
      'voice.sight.failed': 'SIGHT \u00b7 FAILED',
      'voice.judgment.started': 'JUDGMENT \u00b7 FULL BOARD',
      'voice.judgment.done': 'JUDGMENT \u00b7 ANSWERED',
      'voice.judgment.failed': 'JUDGMENT \u00b7 NO ANSWER',
      'build.started': 'BUILD SESSION OPENED',
      'build.update': 'BUILD UPDATE',
      'display.edited': 'BOARD EDITED',
      'wake.detected': 'WAKE DETECTED'
    }
    // Honest numbers ride along on the rail: a look's real time + cost, a
    // judgment's elapsed, a build's state.
    const DETAIL = {
      'voice.sight.done': p => (p.target?.app ? String(p.target.app).slice(0, 14) + ' \u00b7 ' : '') + (p.latencyMs / 1000).toFixed(1) + 's \u00b7 ' + (typeof p.costUsd === 'number' ? '$' + p.costUsd.toFixed(4) : 'cost n/a'),
      'voice.judgment.done': p => (p.elapsedMs / 1000).toFixed(1) + 's',
      'voice.judgment.failed': p => (p.elapsedMs / 1000).toFixed(1) + 's',
      'build.update': p => String(p.name || '').slice(0, 18) + ' \u00b7 ' + String(p.inFlight ? 'working' : p.state || '').toUpperCase(),
      'build.started': p => String(p.name || '').slice(0, 24),
      'display.edited': p => String(p.name || '').slice(0, 24)
    }

    return host.onEvent('*', event => {
      const label = LABELS[event.type] ?? (event.type?.startsWith('tool.') ? 'TOOL \u00b7 ' + event.type.slice(5).toUpperCase() : null)

      if (!label) {
        return
      }

      const at = new Date()
      const stamp = String(at.getHours()).padStart(2, '0') + ':' + String(at.getMinutes()).padStart(2, '0') + ':' + String(at.getSeconds()).padStart(2, '0')
      let detail = ''

      try {
        detail = DETAIL[event.type] ? DETAIL[event.type](event.payload ?? {}) : ''
      } catch {
        detail = ''
      }

      setActivity(prev => [{ at: stamp, detail, key: at.getTime() + label, label }, ...prev].slice(0, 7))
    })
  }, [])

  useEffect(() => {
    window.dispatchEvent(new CustomEvent('jarvis:chrome', { detail: { hide: true } }))

    // The gateway takes seconds to boot on a cold launch: keep asking for the
    // board with backoff until rows arrive. Dense by default, patiently.
    const delays = [800, 2500, 6000, 12_000, 22_000, 40_000]
    const timers = delays.map(ms =>
      window.setTimeout(() => {
        if (!boardArmedRef.current) {
          window.dispatchEvent(new CustomEvent('jarvis:display-request'))
        }

        if (!buildsRef.current.length) {
          window.dispatchEvent(new CustomEvent('jarvis:builds-request'))
        }
      }, ms)
    )

    return () => {
      timers.forEach(t => window.clearTimeout(t))
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
        taskTimersRef.current.forEach(t => window.clearTimeout(t))
        taskTimersRef.current = []
        pulseTimersRef.current.forEach(t => window.clearTimeout(t))
        pulseTimersRef.current = []
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

        boardArmedRef.current = rows.length > 0
        tracker.gesture = { at: performance.now(), kind: 'project' }

        if (!event.payload?.silent) {
          uiSound('materialize')
        }

        setDisplay(prev => ({ ...prev, detail: null, dissolving: false, focus: null, rows: rows.slice(0, 8), shown: false, updated: String(event.payload?.result?.updated || '') }))
        window.setTimeout(() => setDisplay(prev => ({ ...prev, shown: true })), 80)
        // Board projection: each card draws in on its own orb pulse (staggered
        // with the cards' draw delays) — the orb is the projector.
        pulseTimersRef.current.forEach(t => window.clearTimeout(t))
        pulseTimersRef.current = rows.slice(0, 8).map((_, i) =>
          window.setTimeout(() => {
            tracker.gesture = { at: performance.now(), kind: 'project' }
          }, 140 + i * 110))
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
      host.onEvent('voice.task.started', event => {
        const payload = event.payload ?? {}

        taskTimersRef.current.forEach(t => window.clearTimeout(t))
        taskTimersRef.current = []
        tracker.gesture = { at: performance.now(), kind: 'gather' }
        uiSound('materialize')
        const next = {
          goal: String(payload.goal || ''),
          id: payload.id,
          kind: payload.kind === 'research' ? 'research' : payload.kind === 'browser' ? 'browser' : 'task',
          sessionId: payload.sessionId || null,
          media: [],
          startedAt: Date.now(),
          status: 'running',
          summary: '',
          tail: '',
          tools: []
        }

        taskRef.current = next
        setTask(next)
      }),
      host.onEvent('voice.task.session', event => {
        const current = taskRef.current

        if (current && event.payload?.id === current.id) {
          const next = { ...current, sessionId: event.payload.sessionId || null }

          taskRef.current = next
          setTask(next)
        }
      }),
      host.onEvent('message.delta', event => {
        // Stream the delegated session's REAL output into the task plate.
        const current = taskRef.current
        const sid = event.session_id ?? event.sessionId

        if (!current || current.status !== 'running' || !current.sessionId || sid !== current.sessionId) {
          return
        }

        const payload = event.payload ?? {}
        const chunk = typeof payload.text === 'string' ? payload.text : typeof payload.delta === 'string' ? payload.delta : ''

        if (!chunk) {
          return
        }

        const next = { ...current, tail: (current.tail + chunk).slice(-420) }

        taskRef.current = next
        setTask(next)
      }),
      host.onEvent('voice.task.done', event => {
        const current = taskRef.current

        if (!current || event.payload?.id !== current.id) {
          return
        }

        tracker.gesture = { at: performance.now(), kind: 'project' }
        uiSound('tick')
        const next = { ...current, status: 'done', summary: String(event.payload?.summary || '') }

        taskRef.current = next
        setTask(next)
        taskTimersRef.current.push(
          window.setTimeout(() => {
            if (taskRef.current?.id === current.id) {
              taskRef.current = null
              setTask(null)
            }
          }, 30_000)
        )
      }),
      host.onEvent('voice.task.cancelled', event => {
        const current = taskRef.current

        if (!current || event.payload?.id !== current.id) {
          return
        }

        tracker.gesture = { at: performance.now(), kind: 'sweep' }
        uiSound('dissolve')
        const next = { ...current, status: 'cancelled' }

        taskRef.current = next
        setTask(next)
        taskTimersRef.current.push(
          window.setTimeout(() => {
            if (taskRef.current?.id === current.id) {
              taskRef.current = null
              setTask(null)
            }
          }, 5000)
        )
      }),
      // Research: which tools the agent is really using (browser_vision = it
      // LOOKED), and the screenshots it named — truthful theater.
      host.onEvent('tool.start', event => {
        const sid = event.session_id ?? event.sessionId
        const payload = event.payload ?? {}
        const name = String(payload.name ?? payload.tool ?? payload.tool_name ?? payload.function ?? '').trim()

        if (!sid || !name) {
          return
        }

        const current = taskRef.current

        if (current && current.status === 'running' && current.sessionId === sid) {
          const next = { ...current, tools: [...current.tools.filter(t => t !== name), name].slice(-4) }

          taskRef.current = next
          setTask(next)
        }

        if (buildsRef.current.some(b => b.session_id === sid)) {
          const rows = buildsRef.current.map(b => (b.session_id === sid ? { ...b, lastTool: name } : b))

          buildsRef.current = rows
          setBuilds(rows)
        }
      }),
      host.onEvent('voice.task.media', event => {
        const current = taskRef.current

        if (!current || event.payload?.id !== current.id || !event.payload?.thumbnail) {
          return
        }

        const next = { ...current, media: [...current.media, { path: event.payload.path, thumbnail: event.payload.thumbnail }].slice(-3) }

        taskRef.current = next
        setTask(next)
      }),
      // SIGHT
      host.onEvent('voice.sight.started', event => {
        window.clearTimeout(p51TimersRef.current.sight)
        tracker.gesture = { at: performance.now(), kind: 'gather' }
        uiSound('tick')
        setSight({ app: String(event.payload?.app || ''), at: Date.now(), question: String(event.payload?.question || ''), status: 'capturing' })
      }),
      host.onEvent('voice.sight.done', event => {
        const p = event.payload ?? {}

        tracker.gesture = { at: performance.now(), kind: 'project' }
        uiSound('materialize')
        setSight({ ...p, at: Date.now(), status: 'done' })
        p51TimersRef.current.sight = window.setTimeout(() => setSight(null), 45_000)
      }),
      host.onEvent('voice.sight.failed', event => {
        setSight({ at: Date.now(), error: String(event.payload?.error || 'failed'), permission: event.payload?.permission || null, status: 'failed' })
        p51TimersRef.current.sight = window.setTimeout(() => setSight(null), 9000)
      }),
      // JUDGMENT — the full agent reasoning over the whole board
      host.onEvent('voice.judgment.started', event => {
        window.clearTimeout(p51TimersRef.current.judgment)
        tracker.gesture = { at: performance.now(), kind: 'gather' }
        tracker.thinkUntil = performance.now() + THINK_HOLD_MS
        setJudgment({ at: Date.now(), question: String(event.payload?.question || ''), status: 'reasoning' })
      }),
      host.onEvent('voice.judgment.done', event => {
        const p = event.payload ?? {}

        tracker.gesture = { at: performance.now(), kind: 'project' }
        tracker.thinkUntil = 0
        uiSound('tick')
        setJudgment({ answer: String(p.answer || ''), at: Date.now(), elapsedMs: p.elapsedMs, question: String(p.question || ''), status: 'done' })
        p51TimersRef.current.judgment = window.setTimeout(() => setJudgment(null), 40_000)
      }),
      host.onEvent('voice.judgment.failed', event => {
        tracker.thinkUntil = 0
        setJudgment(prev => ({ ...(prev || {}), elapsedMs: event.payload?.elapsedMs, error: String(event.payload?.error || 'no answer'), status: 'failed' }))
        p51TimersRef.current.judgment = window.setTimeout(() => setJudgment(null), 9000)
      }),
      // BUILD SESSIONS — the persistent dock
      host.onEvent('build.list', event => {
        const rows = Array.isArray(event.payload?.builds) ? event.payload.builds : []
        const prior = buildsRef.current
        const merged = rows.map(row => ({ ...(prior.find(b => b.id === row.id) || {}), ...row }))

        buildsRef.current = merged
        setBuilds(merged)
      }),
      host.onEvent('build.started', event => {
        const row = event.payload ?? {}

        if (!row.id) {
          return
        }

        tracker.gesture = { at: performance.now(), kind: 'project' }
        uiSound('materialize')
        const rows = [...buildsRef.current.filter(b => b.id !== row.id), { ...row, tail: '' }]

        buildsRef.current = rows
        setBuilds(rows)
      }),
      host.onEvent('build.update', event => {
        const row = event.payload ?? {}

        if (!row.id) {
          return
        }

        const known = buildsRef.current.some(b => b.id === row.id)
        const rows = known
          ? buildsRef.current.map(b => (b.id === row.id ? { ...b, ...row, tail: row.inFlight ? b.tail : '' } : b))
          : [...buildsRef.current, { ...row, tail: '' }]

        if (row.state === 'done') {
          uiSound('tick')
        }

        buildsRef.current = rows
        setBuilds(rows)
      }),
      host.onEvent('build.session', event => {
        const { id, sessionId } = event.payload ?? {}
        const rows = buildsRef.current.map(b => (b.id === id ? { ...b, session_id: sessionId } : b))

        buildsRef.current = rows
        setBuilds(rows)
      }),
      host.onEvent('message.delta', event => {
        // Stream each build session's REAL output into its plate.
        const sid = event.session_id ?? event.sessionId

        if (!sid || !buildsRef.current.some(b => b.session_id === sid && b.inFlight)) {
          return
        }

        const payload = event.payload ?? {}
        const chunk = typeof payload.text === 'string' ? payload.text : typeof payload.delta === 'string' ? payload.delta : ''

        if (!chunk) {
          return
        }

        const rows = buildsRef.current.map(b => (b.session_id === sid ? { ...b, tail: ((b.tail || '') + chunk).slice(-360) } : b))

        buildsRef.current = rows
        setBuilds(rows)
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

  // Slot grid: operations first (builds keep stable slots, the task follows),
  // cards reflow into the remainder. Nothing overlaps.
  const dockBuilds = builds.slice(0, 4)
  const opsList = [...dockBuilds.map(build => ({ build, kind: 'build' })), ...(task ? [{ kind: 'task' }] : [])]
  const layout = computeCockpitLayout({ cards: display.rows.length, detailOpen: Boolean(display.detail), ops: opsList.length })
  const taskPos = task ? layout.ops[opsList.length - 1] : null
  const boardShown = display.shown && !display.dissolving

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
        style: { background: 'radial-gradient(ellipse at 50% 45%, transparent 55%, rgba(0, 2, 6, 0.55) 100%)', inset: 0, pointerEvents: 'none', position: 'absolute', zIndex: 1 }
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
          jsx('div', { style: { ...LABEL }, children: 'JARVIS OS · COMMAND' }),
          jsxs('div', { style: { display: 'flex', gap: '22px' }, children: [
            display.rows.length
              ? jsx('div', { style: { ...LABEL, color: 'rgba(96,165,250,0.9)' }, children: display.rows.length + ' ON BOARD' + (layout.hidden ? ' · ' + (display.rows.length - layout.hidden) + ' SHOWN' : '') })
              : null,
            jsx('div', { style: { ...LABEL, fontFamily: T.data, fontVariantNumeric: 'tabular-nums', letterSpacing: '0.18em' }, children: clock })
          ] })
        ]
      }),
      // detail stage: the expand verb's instrument
      display.detail ? jsx(DetailStage, { detail: display.detail }, 'detail') : null,
      // metric tiles: real aggregates from the live board
      display.rows.length ? jsx(MetricTiles, { rows: display.rows, shown: boardShown }) : null,
      // delegated work: the task plate — the task pop
      task && taskPos ? jsx(TaskPlate, { clock, pos: taskPos, task }, 'task-' + task.id) : null,
      // build sessions: pinned plates in their slots
      ...dockBuilds.map((build, i) => (layout.ops[i] ? jsx(BuildPlate, { build, clock, pos: layout.ops[i] }, build.id) : null)),
      // center column: SIGHT + JUDGMENT (one of each at a time)
      sight || judgment
        ? jsxs('div', {
            style: { display: 'flex', flexDirection: 'column', gap: '14px', left: '50%', pointerEvents: 'none', position: 'absolute', top: '86px', transform: 'translateX(-50%)', width: '440px', zIndex: 5 },
            children: [sight ? jsx(SightPlate, { sight }, 'sight') : null, judgment ? jsx(JudgmentPlate, { judgment }, 'judgment') : null]
          })
        : null,
      // rails: scheduled operations + live activity
      jobs.length ? jsx(JobsRail, { jobs }, 'jobs') : null,
      activity.length ? jsx(ActivityRail, { activity }, 'activity') : null,
      // edge tab: sessions/nav reachable without stock chrome (no fill — a filament tab)
      jsx('div', {
        onClick: () => window.dispatchEvent(new CustomEvent('jarvis:chrome', { detail: { hide: false } })),
        style: { alignItems: 'center', borderBottom: '1px solid rgba(59,130,246,0.35)', borderRight: '1px solid rgba(59,130,246,0.35)', borderTop: '1px solid rgba(59,130,246,0.35)', color: 'rgba(147,197,253,0.9)', cursor: 'pointer', display: 'flex', fontFamily: T.label, fontSize: '8px', height: '86px', justifyContent: 'center', left: 0, letterSpacing: '0.28em', padding: '0 3px', position: 'absolute', textTransform: 'uppercase', top: '44%', writingMode: 'vertical-rl', zIndex: 6 },
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
      // the board: every card draws on its own orb pulse, in its slot
      jsx('div', {
        style: { inset: 0, pointerEvents: 'none', position: 'absolute' },
        children: [
          ...display.rows.map((row, index) =>
            layout.cards[index]
              ? jsx(ProjectPlate, { delay: 140 + index * 110, dissolving: display.dissolving, focus: false, index, pos: layout.cards[index], row, shown: display.shown, updated: display.updated }, row.name || String(index))
              : null),
          display.focus
            ? jsx(ProjectPlate, { delay: 0, dissolving: display.dissolving, focus: true, index: 0, pos: { side: 'right', slot: 0 }, row: display.focus, shown: true, updated: display.updated }, 'focus')
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
