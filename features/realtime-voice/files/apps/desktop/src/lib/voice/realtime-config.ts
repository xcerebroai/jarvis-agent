// OpenAI Realtime speech-to-speech behavioral contract for the desktop voice
// assistant.
//
// This module owns the *behavioral* Realtime session config — model, voice,
// semantic-VAD turn detection, the assistant persona instructions, and the
// `use_jarvis` bridge tool. It is pure data + builders so the exact wire shape
// is unit-testable without a live WebRTC connection. The ephemeral secret that
// authenticates the session is minted server-side (see the backend
// `/api/audio/realtime/token` endpoint); nothing secret lives here.
//
// EVERY customer-facing identity value — the assistant name, the user's name,
// the wake phrase, the voice, and the accent/delivery instructions — is
// resolved from `config.yaml` (`voice.realtime.*`) and threaded in through
// {@link RealtimeSessionConfigOptions}. The defaults below are the public
// product defaults (JARVIS, no personal user name, "hey jarvis", Marin, a
// concise neutral delivery); an operator overrides any of them in config
// without touching this file.

/** Default Realtime speech-to-speech model. Overridable via config. */
export const REALTIME_MODEL = 'gpt-realtime-2.1'

/** Default output voice. Overridable via config (`voice.realtime.voice`). */
export const REALTIME_VOICE = 'marin'

/** Public defaults for the configurable voice identity. */
export const DEFAULT_ASSISTANT_NAME = 'JARVIS'
export const DEFAULT_WAKE_PHRASE = 'hey jarvis'
export const DEFAULT_DELIVERY =
  'Use a clear, calm, and confident voice with a natural, neutral delivery. Keep it composed, precise, and subtly warm. Do not imitate a character or exaggerate an accent.'

/** Names of the two Realtime tools: one optional project-index lookup and one
 *  full-agent bridge. */
export const USE_JARVIS_TOOL_NAME = 'use_jarvis'
export const REVIEW_PROJECTS_TOOL_NAME = 'review_projects'

/** The configurable voice identity, resolved server-side from `config.yaml`.
 *  All fields have public defaults (see {@link defaultVoiceIdentity}). */
export interface VoiceIdentityConfig {
  /** Assistant name spoken/referred to by the persona. Default "JARVIS". */
  assistantName: string
  /** Operator's name, used ONLY in the opening greeting. Default "" (none). */
  userName: string
  /** Wake phrase the model is told never to echo. Default "hey jarvis". */
  wakePhrase: string
  /** Accent/delivery instructions. Default: concise, neutral. */
  delivery: string
  /** Optional operator-authored rotating greetings. Empty → generated. */
  greetings: string[]
  /** Whether the optional `review_projects` fast path is configured. When
   *  false the tool is omitted entirely and its instructions are dropped. */
  reviewProjectsEnabled: boolean
}

/** Session config = the resolved identity plus per-request model/voice
 *  overrides. Every field optional so a caller can pass `{}` and get the
 *  public-default JARVIS session. */
export interface RealtimeSessionConfigOptions extends Partial<VoiceIdentityConfig> {
  model?: string
  voice?: string
}

/** The public product defaults for the voice identity. */
export function defaultVoiceIdentity(): VoiceIdentityConfig {
  return {
    assistantName: DEFAULT_ASSISTANT_NAME,
    userName: '',
    wakePhrase: DEFAULT_WAKE_PHRASE,
    delivery: DEFAULT_DELIVERY,
    greetings: [],
    reviewProjectsEnabled: false
  }
}

/** Fill an options bag with the public defaults. */
function resolveIdentity(options: RealtimeSessionConfigOptions = {}): VoiceIdentityConfig {
  const base = defaultVoiceIdentity()

  return {
    assistantName: options.assistantName?.trim() || base.assistantName,
    userName: (options.userName ?? base.userName).trim(),
    wakePhrase: options.wakePhrase?.trim() || base.wakePhrase,
    delivery: options.delivery?.trim() || base.delivery,
    greetings: Array.isArray(options.greetings) ? options.greetings.filter(g => g.trim()) : base.greetings,
    reviewProjectsEnabled: Boolean(options.reviewProjectsEnabled)
  }
}

/**
 * Semantic-VAD turn detection: the model decides turn boundaries from meaning,
 * auto-creates a response on turn end, and truncates its own in-flight output
 * the instant the user speaks over it (native barge-in). `eagerness: 'high'`
 * makes it responsive for a hands-free assistant.
 */
export const REALTIME_TURN_DETECTION = {
  type: 'semantic_vad',
  eagerness: 'high',
  create_response: true,
  interrupt_response: true
} as const

/** Build the rotating launch greetings. Uses the configured user name ONLY in
 *  the opening greeting; when none is configured the greetings carry no name. */
export function buildGreetings(options: RealtimeSessionConfigOptions = {}): string[] {
  const cfg = resolveIdentity(options)

  if (cfg.greetings.length > 0) {
    return cfg.greetings
  }

  const who = cfg.userName ? `, ${cfg.userName}` : ''

  return [
    `Hello${who}. What are we working on?`,
    `Good to hear from you${who}. What is the mission?`,
    `I am online${who}. What do you need?`,
    `Ready when you are${who}. Where do we begin?`,
    `Welcome back${who}. What are we building?`
  ]
}

const GREETING_INDEX_KEY = 'voice:launch-greeting-index'

/** Advance the persisted greeting cursor so consecutive launches vary. */
export function nextRealtimeGreeting(
  options: RealtimeSessionConfigOptions = {},
  storage?: Pick<Storage, 'getItem' | 'setItem'> | null
): string {
  const greetings = buildGreetings(options)
  const target = storage === undefined ? (typeof localStorage !== 'undefined' ? localStorage : null) : storage
  let prior = -1

  try {
    prior = Number.parseInt(target?.getItem(GREETING_INDEX_KEY) ?? '-1', 10)
  } catch {
    prior = -1
  }

  const next = Number.isFinite(prior) ? (prior + 1) % greetings.length : 0

  try {
    target?.setItem(GREETING_INDEX_KEY, String(next))
  } catch {
    // Storage can be unavailable in hardened/private renderers; greeting still works.
  }

  return greetings[next]
}

/**
 * Assistant persona + tool-use policy, built from the resolved identity.
 * Delivery is whatever the operator configured (default: concise, neutral).
 * Style: short conversational turns, no filler, immediate acknowledgement.
 * Tool policy: reach for `use_jarvis` whenever the request needs real
 * capability; stay native for ordinary conversation. The optional
 * `review_projects` fast path is described ONLY when it is configured.
 */
export function buildInstructions(options: RealtimeSessionConfigOptions = {}): string {
  const cfg = resolveIdentity(options)
  const name = cfg.assistantName
  const who = cfg.userName
  const youAndUser = who || 'the user'

  const lines: string[] = [
    `You are ${name}, a calm, confident, and highly capable AI voice assistant.`,
    `Voice and delivery: ${cfg.delivery}`,
    `Style: default to one or two short sentences and no more than 60 spoken words. Begin speaking as soon as the answer is clear. Lead with the answer or decision. Include only facts that change what ${youAndUser} should know or do. No filler, throat-clearing, repeated context, exhaustive inventories, or long summaries unless explicitly asked for detail.`,
    who
      ? `Use ${who}'s name in the session-opening greeting only. Do not use their name in normal replies, confirmations, or follow-ups unless a rare urgent warning requires emphasis.`
      : `Do not invent or use a name for the user. Reserve any configured name for the session-opening greeting only.`,
    `Never repeat the wake phrase "${cfg.wakePhrase}" back, and never greet yourself by name.`,
    '',
    'Capability policy — this is important:'
  ]

  if (cfg.reviewProjectsEnabled) {
    lines.push(
      `Use ${REVIEW_PROJECTS_TOOL_NAME} for every request to review, list, summarize, prioritize, or check the status, blocker, progress, or next action of the projects in the configured project index. This is the fast authoritative path; do not call ${USE_JARVIS_TOOL_NAME} for a normal project review.`,
      `After ${REVIEW_PROJECTS_TOOL_NAME}, give the status counts and at most five priority items. Each item gets one short line: project, status, blocker or next action. Keep the spoken review under 90 words and offer a deeper drill-down instead of reading the full inventory.`
    )
  }

  lines.push(
    `Call ${USE_JARVIS_TOOL_NAME} whenever answering well needs tools or actions, private memory, session history, current external facts, files, code, the computer, calculation, or state changes. It routes to the full agent.`,
    `Do NOT call the tool for ordinary conversation — greetings, small talk, acknowledgements, clarifying questions, or things you plainly know. Answer those natively and immediately.`,
    `When you do call the tool AND the answer will take a noticeable moment, say a very short spoken preamble first (e.g. "One moment." / "Let me check.") so there is no dead air. If it will be quick, just call it silently. Never announce tool use for trivial requests.`,
    `When the tool returns, speak its result naturally in your own voice and style — rephrase and condense; do not read it verbatim or dump raw output.`
  )

  return lines.join('\n')
}

/** JSON-Schema for the full-agent bridge tool. */
export const USE_JARVIS_TOOL = {
  type: 'function',
  name: USE_JARVIS_TOOL_NAME,
  description:
    'Route a request to the full agent (memory, session history, tools, files, code, terminal, calculations, live external facts, and actions). Use whenever the request needs real capability, private/persistent memory, current external facts, or any action; do not use it for ordinary conversation.',
  parameters: {
    type: 'object',
    properties: {
      request: {
        type: 'string',
        description:
          "The user's request, phrased as a complete, self-contained instruction for the agent."
      }
    },
    required: ['request'],
    additionalProperties: false
  }
} as const

/** JSON-Schema for the optional configured-project-index fast path. */
export const REVIEW_PROJECTS_TOOL = {
  type: 'function',
  name: REVIEW_PROJECTS_TOOL_NAME,
  description:
    'Fast authoritative review of the projects in the configured local project index. Use for project status, blockers, priorities, progress, next actions, and current-project summaries. Do not use the full agent for a normal index review.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Optional project name/search phrase.' },
      status: { type: 'string', description: 'Optional exact status filter.' },
      limit: { type: 'integer', minimum: 1, maximum: 8, description: 'Maximum project rows; default 5.' }
    },
    additionalProperties: false
  }
} as const

/**
 * Build the `session.update` payload the renderer sends over the data channel
 * once the connection opens: audio-only output, the configured voice,
 * semantic-VAD turn detection, the resolved persona instructions, and the
 * routed tools with `tool_choice: 'auto'`. The `review_projects` tool is
 * included only when it is configured. Single source of truth for the
 * behavioral config.
 */
export function buildRealtimeSessionConfig(options: RealtimeSessionConfigOptions = {}) {
  const cfg = resolveIdentity(options)
  const tools = cfg.reviewProjectsEnabled ? [REVIEW_PROJECTS_TOOL, USE_JARVIS_TOOL] : [USE_JARVIS_TOOL]

  return {
    type: 'realtime' as const,
    model: options.model || REALTIME_MODEL,
    output_modalities: ['audio'] as const,
    audio: {
      input: {
        turn_detection: REALTIME_TURN_DETECTION
      },
      output: {
        voice: options.voice || REALTIME_VOICE
      }
    },
    instructions: buildInstructions(options),
    // Keep the conversational control layer fast. Complex work is delegated to
    // the full agent through use_jarvis, where deeper reasoning belongs.
    reasoning: { effort: 'minimal' as const },
    tools,
    tool_choice: 'auto' as const
  }
}

/** The full `session.update` event wrapping {@link buildRealtimeSessionConfig}. */
export function buildSessionUpdateEvent(options: RealtimeSessionConfigOptions = {}) {
  return {
    type: 'session.update' as const,
    session: buildRealtimeSessionConfig(options)
  }
}

/**
 * The `response.create` event that makes the model speak the launch greeting
 * verbatim and nothing else. Instruction-overrides the turn so no extra words
 * leak in.
 */
export function buildGreetingResponseEvent(greeting: string = nextRealtimeGreeting()) {
  return {
    type: 'response.create' as const,
    response: {
      instructions: `Say exactly this, word for word, and nothing else: "${greeting}"`
    }
  }
}
