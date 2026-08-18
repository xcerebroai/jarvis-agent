import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { atom } from 'nanostores'
import { type ComponentType, type ReactNode, StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { __resetLaunchGreetingForTests, useComposerVoice } from './use-composer-voice'

// The persistent voice session lives in the desktop-level supervisor. The
// composer only forwards start/end intents and VIEWS `$voiceState`; the launch
// path must start it exactly once per renderer launch and never re-create it on
// a remount. The greeting is spoken NATIVELY by the Realtime session on connect,
// so the old TTS `playSpeechText` path must never run.
const supervisor = vi.hoisted(() => {
  return { playSpeechText: vi.fn() }
})

vi.mock('@/lib/voice/voice-supervisor', async () => {
  const { atom: nanoAtom, computed } = await import('nanostores')
  const $active = nanoAtom(false)
  const start = vi.fn(() => $active.set(true))
  const end = vi.fn(() => $active.set(false))

  return {
    $voiceState: computed($active, active => ({ active, fallback: false, status: 'idle', muted: false, level: 0 })),
    voiceSupervisor: {
      start,
      end,
      stopTurn: vi.fn(),
      toggleMute: vi.fn(),
      registerDelegate: () => () => undefined,
      maybeAutoStart: vi.fn(async () => start()),
      isActive: () => $active.get(),
      __resetForTests: () => $active.set(false)
    }
  }
})

vi.mock('@/lib/voice/agent-delegate', () => ({ createForegroundDelegate: () => ({ runTurn: () => null }) }))

vi.mock('@/lib/voice-playback', () => ({ playSpeechText: supervisor.playSpeechText }))

const conversationShape = {
  end: vi.fn(),
  level: 0,
  muted: false,
  start: vi.fn(),
  status: 'idle' as const,
  stopTurn: vi.fn(),
  toggleMute: vi.fn()
}

vi.mock('./use-voice-conversation', () => ({
  useVoiceConversation: () => conversationShape
}))

vi.mock('./use-voice-recorder', () => ({
  useVoiceRecorder: () => ({ dictate: vi.fn(), voiceActivityState: null, voiceStatus: 'idle' })
}))

vi.mock('./use-auto-speak-replies', () => ({
  useAutoSpeakReplies: () => undefined
}))

vi.mock('../scope', () => ({
  useComposerScope: () => ({ $messages: atom([]) })
}))

vi.mock('../focus', () => ({
  onComposerVoiceToggleRequest: () => () => undefined
}))

vi.mock('@/lib/chat-messages', () => ({
  chatMessageText: () => '',
  collectUnspokenTurnSpeech: () => null
}))

vi.mock('@/lib/haptics', () => ({ triggerHaptic: vi.fn() }))

vi.mock('@/lib/wake-indicator', () => ({
  clearWakeIndicator: vi.fn(),
  syncWakeIndicatorWithVoice: () => false
}))

vi.mock('@/store/composer-input-history', () => ({ resetBrowseState: vi.fn() }))

vi.mock('@/store/gateway', () => ({ $gateway: atom(null) }))

vi.mock('@/store/notifications', () => ({ notify: vi.fn(), notifyError: vi.fn() }))

vi.mock('@/store/voice-prefs', () => ({
  $autoSpeakReplies: atom(false),
  $voiceStopPhrase: atom(''),
  setAutoSpeakReplies: vi.fn()
}))

vi.mock('@/store/wake-word', () => ({ resumeWakeAfterVoice: vi.fn() }))

vi.mock('@/i18n', () => ({
  translateNow: (k: string) => k,
  useI18n: () => ({
    t: {
      assistant: { thread: { readAloudFailed: '' } },
      notifications: { voice: { sayStopToEnd: (phrase: string) => phrase } },
      settings: { config: { autosaveFailed: '' } }
    }
  })
}))

import { voiceSupervisor } from '@/lib/voice/voice-supervisor'

interface HookProps {
  disabled: boolean
  target: 'main' | (string & {})
}

function renderVoice(props: HookProps, wrapper?: ComponentType<{ children: ReactNode }>) {
  return renderHook(
    ({ disabled, target }: HookProps) =>
      useComposerVoice({
        busy: false,
        clearDraft: vi.fn(),
        disabled,
        focusInput: vi.fn(),
        insertText: vi.fn(),
        maxRecordingSeconds: 120,
        onSubmit: vi.fn(async () => true),
        onTranscribeAudio: vi.fn(async () => ''),
        sessionId: 'session-1',
        target
      }),
    { initialProps: props, wrapper }
  )
}

describe('useComposerVoice launch auto-start (global voice, native greeting)', () => {
  beforeEach(() => {
    __resetLaunchGreetingForTests()
    voiceSupervisor.__resetForTests?.()
    vi.clearAllMocks()
  })

  afterEach(() => {
    cleanup()
  })

  it('starts the global voice session on launch without the old TTS greeting', async () => {
    const hook = renderVoice({ disabled: false, target: 'main' })

    await waitFor(() => expect(hook.result.current.voiceConversationActive).toBe(true))
    expect(voiceSupervisor.start).toHaveBeenCalledTimes(1)
    // The greeting is spoken natively by the Realtime session, never via TTS.
    expect(supervisor.playSpeechText).not.toHaveBeenCalled()
  })

  it('starts once per renderer launch, and a remount re-attaches to the surviving session', async () => {
    const first = renderVoice({ disabled: false, target: 'main' }, StrictMode)

    await waitFor(() => expect(first.result.current.voiceConversationActive).toBe(true))
    expect(voiceSupervisor.start).toHaveBeenCalledTimes(1)

    // A remount (session switch, composer remount, profile switch) must NOT
    // start a second time — and the voice session stays active globally, not reset.
    first.unmount()
    const second = renderVoice({ disabled: false, target: 'main' }, StrictMode)

    await act(async () => {
      await Promise.resolve()
    })

    expect(voiceSupervisor.start).toHaveBeenCalledTimes(1)
    expect(second.result.current.voiceConversationActive).toBe(true)
    expect(supervisor.playSpeechText).not.toHaveBeenCalled()
  })

  it('never auto-starts for a session-tile composer', async () => {
    const hook = renderVoice({ disabled: false, target: 'tile:abc' })

    await act(async () => {
      await Promise.resolve()
    })

    expect(hook.result.current.voiceConversationActive).toBe(false)
    expect(voiceSupervisor.start).not.toHaveBeenCalled()
  })

  it('waits until a disabled composer becomes enabled before auto-starting', async () => {
    const hook = renderVoice({ disabled: true, target: 'main' })

    await act(async () => {
      await Promise.resolve()
    })
    expect(hook.result.current.voiceConversationActive).toBe(false)
    expect(voiceSupervisor.start).not.toHaveBeenCalled()

    hook.rerender({ disabled: false, target: 'main' })

    await waitFor(() => expect(hook.result.current.voiceConversationActive).toBe(true))
    expect(voiceSupervisor.start).toHaveBeenCalledTimes(1)
  })
})
