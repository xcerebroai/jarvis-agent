import { describe, expect, it } from 'vitest'

import {
  buildGreetingResponseEvent,
  buildGreetings,
  buildInstructions,
  buildRealtimeSessionConfig,
  buildSessionUpdateEvent,
  DEFAULT_ASSISTANT_NAME,
  DEFAULT_WAKE_PHRASE,
  nextRealtimeGreeting,
  REALTIME_MODEL,
  REALTIME_TURN_DETECTION,
  REALTIME_VOICE,
  REVIEW_PROJECTS_TOOL,
  REVIEW_PROJECTS_TOOL_NAME,
  ACTION_TOOLS,
  BUILD_TOOLS,
  REASONING_TOOLS,
  SIGHT_TOOLS,
  DISPLAY_TOOLS,
  USE_JARVIS_TOOL,
  USE_JARVIS_TOOL_NAME
} from './realtime-config'

describe('realtime-config', () => {
  it('pins the default public model, voice, name, and wake phrase', () => {
    expect(REALTIME_MODEL).toBe('gpt-realtime-2.1')
    expect(REALTIME_VOICE).toBe('marin')
    expect(DEFAULT_ASSISTANT_NAME).toBe('JARVIS')
    expect(DEFAULT_WAKE_PHRASE).toBe('hey jarvis')
  })

  it('rotates greetings, carries NO name by default, and never echoes a wake phrase', () => {
    const values = new Map<string, string>()
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value)
    }
    const first = nextRealtimeGreeting({}, storage)
    const second = nextRealtimeGreeting({}, storage)

    expect(first).not.toBe(second)
    // Public default: no personal user name anywhere in the greeting.
    const defaults = buildGreetings({})
    expect(defaults.every(g => !/\bhey\b/i.test(g))).toBe(true)
    expect(defaults.length).toBeGreaterThan(1)
  })

  it('uses the configured user name ONLY in greetings, never invents one', () => {
    const named = buildGreetings({ userName: 'Ada' })
    expect(named.every(g => g.includes('Ada'))).toBe(true)

    // Operator-authored greetings win verbatim.
    expect(buildGreetings({ greetings: ['Custom line'] })).toEqual(['Custom line'])
  })

  it('configures high-eagerness semantic VAD that creates and interrupts responses', () => {
    expect(REALTIME_TURN_DETECTION).toEqual({
      type: 'semantic_vad',
      eagerness: 'high',
      create_response: true,
      interrupt_response: true
    })
  })

  it('builds the session config with audio-only output, default voice, minimal reasoning, and VAD', () => {
    const config = buildRealtimeSessionConfig()

    expect(config.type).toBe('realtime')
    expect(config.model).toBe('gpt-realtime-2.1')
    expect(config.output_modalities).toEqual(['audio'])
    expect(config.audio.output.voice).toBe('marin')
    expect(config.reasoning).toEqual({ effort: 'minimal' })
    expect(config.audio.input.turn_detection).toEqual(REALTIME_TURN_DETECTION)
    expect(config.tool_choice).toBe('auto')
  })

  it('omits review_projects by default and includes it only when configured', () => {
    const off = buildRealtimeSessionConfig()
    expect(off.tools).toEqual([...ACTION_TOOLS, ...BUILD_TOOLS, ...SIGHT_TOOLS, USE_JARVIS_TOOL])

    const on = buildRealtimeSessionConfig({ reviewProjectsEnabled: true })
    expect(on.tools).toEqual([REVIEW_PROJECTS_TOOL, ...DISPLAY_TOOLS, ...REASONING_TOOLS, ...ACTION_TOOLS, ...BUILD_TOOLS, ...SIGHT_TOOLS, USE_JARVIS_TOOL])

    expect(REVIEW_PROJECTS_TOOL_NAME).toBe('review_projects')
    expect(REVIEW_PROJECTS_TOOL.parameters.properties.limit.maximum).toBe(8)
    expect(USE_JARVIS_TOOL_NAME).toBe('use_jarvis')
    expect(USE_JARVIS_TOOL.type).toBe('function')
    expect(USE_JARVIS_TOOL.name).toBe('use_jarvis')
    expect(USE_JARVIS_TOOL.parameters.required).toEqual(['request'])
    expect(USE_JARVIS_TOOL.parameters.properties.request.type).toBe('string')
    expect(USE_JARVIS_TOOL.parameters.additionalProperties).toBe(false)
  })

  it('instructs concise neutral delivery, short replies, no filler, and tool policy', () => {
    const instructions = buildInstructions().toLowerCase()

    expect(instructions).toContain('you are jarvis')
    expect(instructions).toContain('no more than 60 spoken words')
    expect(instructions).toContain('begin speaking as soon as')
    expect(instructions).toContain('no filler')
    expect(instructions).toContain('session-opening greeting only')
    // Default delivery is neutral and explicitly not a character imitation.
    expect(instructions).toContain('do not imitate a character')
    // Tool policy: use the bridge for real capability; stay native otherwise.
    expect(instructions).toContain('use_jarvis')
    expect(instructions).toContain('memory')
    expect(instructions).toContain('preamble')
  })

  it('describes the review tool in instructions only when it is configured', () => {
    expect(buildInstructions().toLowerCase()).not.toContain('review_projects')
    expect(buildInstructions().toLowerCase()).not.toContain('under 90 words')

    const withReview = buildInstructions({ reviewProjectsEnabled: true }).toLowerCase()
    expect(withReview).toContain('review_projects')
    expect(withReview).toContain('under 90 words')
  })

  it('threads a custom assistant name, wake phrase, and delivery through the instructions', () => {
    const instructions = buildInstructions({
      assistantName: 'ATLAS',
      wakePhrase: 'atlas online',
      delivery: 'Speak with a warm Southern lilt.'
    })
    expect(instructions).toContain('You are ATLAS')
    expect(instructions).toContain('"atlas online"')
    expect(instructions).toContain('warm Southern lilt')
    expect(instructions).not.toContain('JARVIS')
  })

  it('allows model/voice overrides but defaults to production values', () => {
    const overridden = buildRealtimeSessionConfig({ model: 'other', voice: 'cedar' })
    expect(overridden.model).toBe('other')
    expect(overridden.audio.output.voice).toBe('cedar')

    const wrapped = buildSessionUpdateEvent()
    expect(wrapped.type).toBe('session.update')
    expect(wrapped.session.model).toBe('gpt-realtime-2.1')
  })

  it('builds a greeting response that says the selected greeting verbatim', () => {
    const greeting = 'Ready when you are. Where do we begin?'
    const event = buildGreetingResponseEvent(greeting)
    expect(event.type).toBe('response.create')
    expect(event.response.instructions).toContain(greeting)
  })
})
