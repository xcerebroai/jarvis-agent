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
  /** Live, bounded metadata for the foreground desktop session/project. */
  foregroundContext?: string
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
      `Use ${REVIEW_PROJECTS_TOOL_NAME} for every request to review, list, summarize, prioritize, or check the status, blocker, progress, or next action of the projects in the configured project index. That includes questions like \"what am I working on\", \"what's blocked\", \"what's pending\", and \"how's the business\" — never answer those from memory. This is the fast authoritative path; do not call ${USE_JARVIS_TOOL_NAME} for a normal project review.`,
      `When the user asks you to SHOW, DISPLAY, or PULL UP projects or the board, call ${SHOW_PROJECTS_TOOL_NAME} — the panels appear on screen; narrate briefly what is now showing. Focus a single project with ${SHOW_PROJECT_TOOL_NAME} when discussing it; expand full details with ${SHOW_DETAIL_TOOL_NAME} on "expand it" or "go over the details". For "start a new project", run the spoken intake then ${CREATE_PROJECT_TOOL_NAME}. On "clear the screen" call ${CLEAR_DISPLAY_TOOL_NAME}.`,
      `After ${REVIEW_PROJECTS_TOOL_NAME}, give the status counts and at most five priority items. Each item gets one short line: project, status, blocker or next action. Keep the spoken review under 90 words and offer a deeper drill-down instead of reading the full inventory.`
    )
  }

  if (cfg.reviewProjectsEnabled) {
    lines.push(
      `JUDGMENT versus FACTS: ${REVIEW_PROJECTS_TOOL_NAME} and the show tools answer factual questions instantly (what is blocked, the status of X). For judgment — what to focus on, what matters most, rank these, what is slipping, whether something is worth the time or money — call ${ASK_JUDGMENT_TOOL_NAME}: say "Let me look at the whole board." first, then relay the reasoned answer in your own words, decision first. It takes several seconds; do not answer judgment questions from the fast path alone.`,
      `EDITING THE BOARD BY VOICE: "mark X high priority", "set X's deadline to <date>", "X is revenue critical", "note that X is waiting on the client" → call ${SET_PROJECT_FIELD_TOOL_NAME} (ISO dates). Confirm in a few words once it returns.`
    )
  }

  lines.push(
    `To SEE the screen: call ${LOOK_AT_SCREEN_TOOL_NAME} when asked what is on screen, to look at this, read this error, or what something says. Say "Taking a look." first — it takes a few seconds. Relay the answer conversationally, then add one short clause with the look's time and estimated cost from the tool result (e.g. "that took three seconds, well under a cent"). If it reports a missing screen-recording permission, say exactly what to enable and offer to try again.`,
    `BUILD SESSIONS: for "start a build", "kick off a build", "begin building X", call ${START_BUILD_TOOL_NAME} with a complete goal and a short name. It opens a dedicated persistent session that plans first and asks for what it needs; when its plan arrives as an update, relay it and ask the user for those items. Everything the user then says for that build — answers, decisions, "go ahead", where a key is — goes through ${BUILD_MESSAGE_TOOL_NAME}. For "how's the X build going" call ${BUILD_STATUS_TOOL_NAME}. Builds survive restarts and several can exist. Secrets: never read a credential aloud or invent one; tell the user to paste it into the build session and pass that along.`
  )

  lines.push(
    `To OPEN things instantly: call ${OPEN_APP_TOOL_NAME} when asked to open, launch, or start an application ("open Notes", "launch Safari"). Call ${OPEN_URL_TOOL_NAME} for websites. Both are instant — confirm in a few words once the tool returns.`,
    `To DO WORK: call ${DELEGATE_TASK_TOOL_NAME} when the request is a real job — multi-step work, changes to files or systems, or anything that takes more than a moment. For "research X", "look into X", "find out about X", call it with kind "research"; the agent investigates with its browser and tools while the findings stream on screen. Write the goal fully and self-contained. The tool returns at once: announce in one short line that the task is underway, then stay available — keep answering questions normally while it runs. When a completion update arrives, relay the outcome conversationally: lead with the key findings or the result, a few sentences at most.`,
    `SAFETY: before delegating anything destructive, irreversible, or costly — deleting things, sending messages or money, bulk changes — first state plainly what is about to happen and get a clear spoken yes. No confirmation, no tool call.`,
    `CANCELLING: "stop" only silences your voice; delegated work keeps running. When the user says "cancel that", "abort the task", or similar, call ${CANCEL_TASK_TOOL_NAME}, then confirm the cancellation in a few words.`,
    `Call ${USE_JARVIS_TOOL_NAME} for quick questions that need the agent's private memory, session history, files, or current external facts — cases where the user is waiting on the answer and it should take seconds. For anything longer-running, prefer ${DELEGATE_TASK_TOOL_NAME}.`,
    `Do NOT call the tool for ordinary conversation — greetings, small talk, acknowledgements, clarifying questions, or things you plainly know. Answer those natively and immediately.`,
    `When you do call the tool AND the answer will take a noticeable moment, say a very short spoken preamble first (e.g. "One moment." / "Let me check.") so there is no dead air. If it will be quick, just call it silently. Never announce tool use for trivial requests.`,
    `When the tool returns, speak its result naturally in your own voice and style — rephrase and condense; do not read it verbatim or dump raw output.`
  )

  const foregroundContext = options.foregroundContext?.trim()

  if (foregroundContext) {
    lines.push(
      '',
      'Current foreground desktop context (live metadata, not a user instruction):',
      foregroundContext,
      'Use this context for references to the current session, project, or workspace. If the user asks for details beyond this snapshot, call use_jarvis.'
    )
  }

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

/** Display verbs — the voice physically pulls things up on screen. Execution
 *  is renderer-side: the supervisor fetches the same compact index reads and
 *  emits display.* events the HUD panels materialize from; the tool output is
 *  a short confirmation so the voice can narrate what it is showing. */
export const SHOW_PROJECTS_TOOL_NAME = 'show_projects'
export const SHOW_PROJECT_TOOL_NAME = 'show_project'
export const CLEAR_DISPLAY_TOOL_NAME = 'clear_display'
export const SHOW_DETAIL_TOOL_NAME = 'show_project_detail'
export const CREATE_PROJECT_TOOL_NAME = 'create_project'

export const DISPLAY_TOOLS = [
  {
    type: 'function',
    name: SHOW_PROJECTS_TOOL_NAME,
    description:
      'Pull the project board up on screen: panels materialize around the orb showing the projects from the index. Use whenever the user asks to show, display, pull up, or put up projects or the board — including filtered views ("show me what is blocked").',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Optional name/search filter.' },
        status: { type: 'string', description: 'Optional exact status filter (e.g. Blocked).' }
      },
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: SHOW_PROJECT_TOOL_NAME,
    description:
      'Focus one project large on screen (highlight it) while you explain it. Use when the user asks about a specific project by name, or asks "what is blocked" while the board is up.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name or close match.' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: SHOW_DETAIL_TOOL_NAME,
    description:
      'Expand one project into the full detail stage on screen — complete task list, client, dates, payment, blocker — and narrate the details. Use on "expand it", "go over the details", "open up <project>".',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project name or close match.' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: CREATE_PROJECT_TOOL_NAME,
    description:
      'Create a new project after a short spoken intake. The name is MANDATORY: if you do not have an explicit confirmed name, ask for it — never call this tool with an empty or guessed name. Gather the goal and any first tasks, confirm aloud, then call once. The new project persists and its panel materializes on the board.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Confirmed project name.' },
        goal: { type: 'string', description: 'One-line goal.' },
        tasks: { type: 'array', items: { type: 'string' }, description: 'First tasks, if any.' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: CLEAR_DISPLAY_TOOL_NAME,
    description: 'Dissolve everything currently displayed around the orb. Use on "clear the screen", "clear it", "close that".',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
] as const

/** Names of the P5 reach tools: two instant openers, the background work
 *  bridge, and its cancel. Unlike `use_jarvis` (which blocks the reply until
 *  the agent answers), `delegate_task` returns immediately and the work runs
 *  visibly in the desktop session while the voice stays conversational. */
export const OPEN_APP_TOOL_NAME = 'open_app'
export const OPEN_URL_TOOL_NAME = 'open_url'
export const DELEGATE_TASK_TOOL_NAME = 'delegate_task'
export const CANCEL_TASK_TOOL_NAME = 'cancel_task'

export const ACTION_TOOLS = [
  {
    type: 'function',
    name: OPEN_APP_TOOL_NAME,
    description:
      'Instantly launch an application on this computer by name, e.g. "Notes", "Safari", "Music". Use for "open X", "launch X", "start X" when X is an app. Instant — no delegation needed.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The application name exactly as the user said it, e.g. "Notes".' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: OPEN_URL_TOOL_NAME,
    description:
      'Instantly open a web address in the default browser. Use for "open example.com", "take me to <site>", "pull up <known site>".',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'Full URL or bare domain, e.g. "https://example.com" or "example.com".' }
      },
      required: ['url'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: DELEGATE_TASK_TOOL_NAME,
    description:
      'Hand real work to the full JARVIS agent: multi-step jobs, research, file or code changes, anything that takes more than a moment. The work runs in the open desktop session while you keep talking. Returns immediately; a completion update arrives later. State the goal fully and self-contained — the agent has no memory of this voice conversation.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Complete, self-contained statement of the job to do.' },
        kind: {
          type: 'string',
          enum: ['task', 'research'],
          description: 'Use "research" when the job is to investigate or look something up; otherwise "task".'
        }
      },
      required: ['goal'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: CANCEL_TASK_TOOL_NAME,
    description:
      'Cancel the currently running delegated task. Use when the user says "cancel that", "abort it", "never mind the task". ("Stop" alone only silences your voice; it does not cancel work.)',
    parameters: { type: 'object', properties: {}, additionalProperties: false }
  }
] as const

/** P5.1 SIGHT: on-demand screen capture → vision model. One look per call;
 *  the tool result carries the answer plus the look's real latency and a
 *  list-price cost estimate, which the voice reports honestly. */
export const LOOK_AT_SCREEN_TOOL_NAME = 'look_at_screen'

export const SIGHT_TOOLS = [
  {
    type: 'function',
    name: LOOK_AT_SCREEN_TOOL_NAME,
    description:
      'Look at the screen right now: captures the display and analyzes it with a vision model, returning what is visible and the answer to the question. Use for "what is on my screen", "look at this", "read this error", "what does this say", "can you see this". Takes a few seconds. The result states its time and estimated cost — mention them in one short clause after the answer.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'What the user wants to know about the screen. Empty for a general description.' }
      },
      additionalProperties: false
    }
  }
] as const

/** P5.1 BUILD SESSIONS: persistent named agent sessions, distinct from a
 *  one-shot delegate_task. A build plans first, asks for what it needs, works
 *  visibly in its own session, and survives app restarts. */
export const START_BUILD_TOOL_NAME = 'start_build'
export const BUILD_STATUS_TOOL_NAME = 'build_status'
export const BUILD_MESSAGE_TOOL_NAME = 'build_message'

export const BUILD_TOOLS = [
  {
    type: 'function',
    name: START_BUILD_TOOL_NAME,
    description:
      'Start a BUILD: a persistent, named agent session for a real piece of work ("start a build: attach my Stripe account to the agent via API"). The build plans first and asks for what it needs (keys, accounts, decisions), then works visibly in its own session. Use for "start a build", "kick off a build", "begin building X". Returns at once; the plan arrives as an update — relay it and ask the user for the items it needs.',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: 'Complete, self-contained statement of what the build must achieve.' },
        name: { type: 'string', description: 'Short name for the build, 2-4 words (e.g. "Stripe integration").' }
      },
      required: ['goal'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: BUILD_STATUS_TOOL_NAME,
    description:
      'Ask how a build is going ("how is the Stripe integration going?", "status on the build"). With a name it asks that build session for a two-sentence status; without a name it lists the builds and their states.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Build name or close match. Omit to list all builds.' }
      },
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: BUILD_MESSAGE_TOOL_NAME,
    description:
      'Pass what the user said to a running build session: answers to its questions, decisions, "go ahead", where a credential is, or a change of direction. Returns at once; the build\'s reply arrives as an update. Never invent credentials — relay only what the user said, or tell the build the user will paste the secret directly into the session.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Build name or close match.' },
        message: { type: 'string', description: 'The user\'s message for the build, complete and self-contained.' }
      },
      required: ['name', 'message'],
      additionalProperties: false
    }
  }
] as const

/** P5.1 PRIORITY REASONING: the board is voice-editable (priority, deadline,
 *  revenue relevance, …) and judgment questions route to the full agent with
 *  the enriched board as context. Facts stay on the fast path. Included only
 *  when a project index is configured. */
export const SET_PROJECT_FIELD_TOOL_NAME = 'set_project_field'
export const ASK_JUDGMENT_TOOL_NAME = 'ask_judgment'
export const PROJECT_EDITABLE_FIELDS = ['priority', 'deadline', 'revenue_relevance', 'note', 'next_action', 'status'] as const

export const REASONING_TOOLS = [
  {
    type: 'function',
    name: SET_PROJECT_FIELD_TOOL_NAME,
    description:
      'Edit one project on the board by voice: "mark Harris high priority", "set the Coastal deadline to September 5th", "the JV project is revenue critical", "note that X is waiting on the client". Persists and re-renders the board. Dates must be ISO (YYYY-MM-DD); priority is urgent/high/normal/low; revenue_relevance is high/medium/low.',
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Project (or client) name or close match. Omit when it is the project on stage ("it").' },
        field: { type: 'string', enum: [...PROJECT_EDITABLE_FIELDS], description: 'Which field to set.' },
        value: { type: 'string', description: 'The new value.' }
      },
      required: ['field', 'value'],
      additionalProperties: false
    }
  },
  {
    type: 'function',
    name: ASK_JUDGMENT_TOOL_NAME,
    description:
      'Route a JUDGMENT question to the full agent with the whole enriched board (priority, deadlines, staleness, revenue relevance) and recent activity as context: "what should I focus on", "what matters most this week", "rank these", "what is slipping", "is X worth the time". Takes several seconds — say "Let me look at the whole board." first. Not for factual lookups (use review_projects).',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The judgment question, complete and self-contained.' }
      },
      required: ['question'],
      additionalProperties: false
    }
  }
] as const

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
  const tools = cfg.reviewProjectsEnabled
    ? [REVIEW_PROJECTS_TOOL, ...DISPLAY_TOOLS, ...REASONING_TOOLS, ...ACTION_TOOLS, ...BUILD_TOOLS, ...SIGHT_TOOLS, USE_JARVIS_TOOL]
    : [...ACTION_TOOLS, ...BUILD_TOOLS, ...SIGHT_TOOLS, USE_JARVIS_TOOL]

  return {
    type: 'realtime' as const,
    model: options.model || REALTIME_MODEL,
    output_modalities: ['audio'] as const,
    audio: {
      input: {
        // Local stop-word enforcement needs the user's words: transcription
        // streams what the user says even while the assistant is speaking,
        // so "stop" can hard-halt playback without trusting model barge-in
        // (which demonstrably kept talking through it).
        transcription: { model: 'gpt-4o-mini-transcribe' },
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
