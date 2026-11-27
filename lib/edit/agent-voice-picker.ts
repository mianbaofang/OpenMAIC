/**
 * Pure helpers behind the roster's course-voice picker.
 *
 * The roster is course-level content, and the teacher's voice is part of it:
 * course narration reads the FIRST teacher that carries a `voiceConfig` (see
 * `pickNarratorAgent` in `lib/audio/agent-voice-options.ts`), so the roster
 * must offer exactly one voice binding — on the card of the agent that will
 * actually narrate.
 *
 * Everything here is plain data in / plain data out, so the rules that decide
 * WHICH teacher narrates and WHICH voices may be picked are unit-testable
 * without a browser. The React component
 * (`components/edit/AgentsView/AgentVoicePicker.tsx`) only renders what these
 * helpers return.
 */

import type { ProviderWithVoices } from '@/lib/audio/voice-resolver';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

/** A TTS voice binding, in the shape the roster stores it. */
export interface AgentVoiceBinding {
  readonly providerId: string;
  readonly modelId?: string;
  readonly voiceId: string;
}

/** One selectable voice: a provider, a model of it, and a voice of that model. */
export interface AgentVoiceChoice {
  readonly providerId: string;
  readonly modelId?: string;
  readonly voiceId: string;
  /** The voice's display name (falls back to its id). */
  readonly voiceName: string;
  readonly providerName: string;
  readonly modelName: string;
}

/** The choices of one provider + model — a group in the picker. */
export interface AgentVoiceChoiceGroup {
  /** Stable identity of the group: provider + model. */
  readonly key: string;
  /** What the group shows: the provider, and its model when it has one. */
  readonly label: string;
  readonly choices: AgentVoiceChoice[];
}

/**
 * The teacher that narrates the course — the one card that may carry the
 * course voice.
 *
 * Mirrors `pickNarratorAgent` exactly, on the roster instead of the registry:
 * the first teacher that already has a voice binding, else the first that has
 * a voice design, else the first teacher. Binding a voice to any other teacher
 * would silently not change the narration, so the picker must not offer one.
 */
export function pickNarratorAgentId(roster: GeneratedAgentConfig[]): string | undefined {
  const teachers = roster.filter((agent) => agent.role === 'teacher');
  const bound = teachers.find((agent) => !!agent.voiceConfig);
  if (bound) return bound.id;
  const designed = teachers.find((agent) => !!agent.voiceDesign);
  if (designed) return designed.id;
  return teachers[0]?.id;
}

/** The group's label: the provider, plus its model when the provider has one. */
function groupLabel(providerName: string, modelId: string | undefined, modelName: string): string {
  if (!modelId) return providerName;
  return `${providerName} · ${modelName || modelId}`;
}

/**
 * The voices the owner may bind, taken from the canonical catalog
 * (`getEnabledProvidersWithVoices`).
 *
 * Only the voices a provider's model can actually speak are offered: the
 * catalog's model groups already carry that compatibility, so the groups —
 * not the provider's flat voice list — are what gets flattened here. The model
 * travels with the choice, because a binding is provider + model + voice.
 *
 * Browser-native voices are absent by construction: the catalog excludes them,
 * and a course voice is stored server-side, where a browser voice does not
 * exist.
 */
export function buildAgentVoiceChoices(providers: ProviderWithVoices[]): AgentVoiceChoiceGroup[] {
  const groups = new Map<string, AgentVoiceChoiceGroup>();

  for (const provider of providers) {
    for (const group of provider.modelGroups) {
      const modelId = group.modelId || undefined;
      const choices: AgentVoiceChoice[] = [];
      for (const voice of group.voices) {
        choices.push({
          providerId: provider.providerId,
          modelId,
          voiceId: voice.id,
          voiceName: voice.name || voice.id,
          providerName: provider.providerName,
          modelName: group.modelName || modelId || provider.providerName,
        });
      }
      if (choices.length === 0) continue;

      const key = `${provider.providerId}::${modelId ?? ''}`;
      const existing = groups.get(key);
      if (existing) {
        groups.set(key, { ...existing, choices: [...existing.choices, ...choices] });
        continue;
      }
      groups.set(key, {
        key,
        label: groupLabel(provider.providerName, modelId, group.modelName),
        choices,
      });
    }
  }

  return [...groups.values()];
}

/**
 * The choice a binding names, or undefined when the bound voice is not
 * offered (its provider is disabled, or its model cannot speak it any more).
 *
 * A binding written WITHOUT a model still names a voice: documents and older
 * generators leave the model out, and the catalog's groups are listed with the
 * provider's own model first — so the first group of that provider that speaks
 * the voice is the match. A binding that DOES name a model is matched against
 * that model only: a voice the named model cannot speak is not silently
 * re-pointed at another model.
 */
export function findAgentVoiceChoice(
  groups: AgentVoiceChoiceGroup[],
  binding: AgentVoiceBinding | undefined,
): AgentVoiceChoice | undefined {
  if (!binding) return undefined;

  // The exact binding: provider + model + voice.
  for (const group of groups) {
    for (const choice of group.choices) {
      if (choice.providerId !== binding.providerId) continue;
      if (choice.voiceId !== binding.voiceId) continue;
      if ((choice.modelId ?? '') !== (binding.modelId ?? '')) continue;
      return choice;
    }
  }

  // A binding with no model: the first voice of that provider that speaks it.
  if (!binding.modelId) {
    for (const group of groups) {
      for (const choice of group.choices) {
        if (choice.providerId !== binding.providerId) continue;
        if (choice.voiceId !== binding.voiceId) continue;
        return choice;
      }
    }
  }

  return undefined;
}

/** The binding a choice persists — provider + model + voice, nothing else. */
export function agentVoiceBindingFor(choice: AgentVoiceChoice): AgentVoiceBinding {
  return {
    providerId: choice.providerId,
    ...(choice.modelId ? { modelId: choice.modelId } : {}),
    voiceId: choice.voiceId,
  };
}
