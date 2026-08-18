import { useStore } from '@nanostores/react'
import { useEffect, useRef } from 'react'

import { type AgentSubmit, createForegroundDelegate } from '@/lib/voice/agent-delegate'
import { $voiceState, voiceSupervisor } from '@/lib/voice/voice-supervisor'

import type { ComposerTarget } from '../focus'

interface UseVoiceSessionArgs {
  /** Only the main composer registers the routing delegate for `use_jarvis`. */
  target: ComposerTarget
  /** This composer's submit seam — a routed `use_jarvis` request runs through it. */
  onSubmit: AgentSubmit
}

/**
 * The composer's VIEW of the desktop-level voice supervisor.
 *
 * This hook owns no session, no mic, no timers — it only subscribes to the
 * global `$voiceState` state and forwards control intents to the singleton.
 * A composer unmount (tab switch, route change, remount) therefore never closes
 * the voice session; the supervisor is the sole owner. The main composer additionally
 * registers a foreground routing delegate so `use_jarvis` reaches whatever
 * session is currently on screen, pinning each turn to the session it started in.
 */
export function useVoiceSession({ target, onSubmit }: UseVoiceSessionArgs) {
  const state = useStore($voiceState)
  const submitRef = useRef(onSubmit)
  // Render-time mirror so the delegate always routes through the latest submit
  // without re-registering (which would drop an in-flight pinned turn).
  submitRef.current = onSubmit

  useEffect(() => {
    if (target !== 'main') {
      return undefined
    }

    const delegate = createForegroundDelegate((text, options) => submitRef.current(text, options))

    return voiceSupervisor.registerDelegate(delegate)
  }, [target])

  return {
    active: state.active,
    fallback: state.fallback,
    end: voiceSupervisor.end,
    level: state.level,
    muted: state.muted,
    start: voiceSupervisor.start,
    status: state.status,
    stopTurn: voiceSupervisor.stopTurn,
    toggleMute: voiceSupervisor.toggleMute
  }
}
