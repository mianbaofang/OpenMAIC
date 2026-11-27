'use client';

/**
 * AgentVoicePicker — the course voice of the roster's narrator.
 *
 * Course narration is produced on the server from the stage document, and the
 * voice it uses is the FIRST teacher that carries a `voiceConfig` (see
 * `pickNarratorAgent`). A teacher's voice is therefore pinned with the course:
 * changing the workspace's global voice does not move it. This control writes
 * the binding onto the roster's narrator, where the narration path reads it.
 *
 * The voices come from the canonical catalog (`getEnabledProvidersWithVoices`),
 * so the picker never invents a provider and never offers a voice its model
 * cannot speak. Browser-native voices are absent on purpose: a course voice is
 * stored server-side, where a browser voice does not exist.
 */

import { useMemo } from 'react';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSlotTTSProvidersConfig } from '@/lib/audio/use-tts-selection';
import { useAllVoiceProfiles } from '@/lib/audio/voxcpm-voices';
import { getEnabledProvidersWithVoices } from '@/lib/audio/voice-resolver';
import { VOXCPM_AUTO_VOICE_ID } from '@/lib/audio/voxcpm';
import {
  agentVoiceBindingFor,
  buildAgentVoiceChoices,
  findAgentVoiceChoice,
  type AgentVoiceBinding,
  type AgentVoiceChoice,
} from '@/lib/edit/agent-voice-picker';

interface AgentVoicePickerProps {
  /** The agent's current binding; undefined when it has none. */
  readonly value: AgentVoiceBinding | undefined;
  /** The new binding; undefined clears it, handing the agent back to the workspace voice. */
  readonly onChange: (binding: AgentVoiceBinding | undefined) => void;
}

/** The value of one `<option>`: the binding it stands for, encoded. */
function voiceKey(binding: AgentVoiceBinding): string {
  return JSON.stringify([binding.providerId, binding.modelId ?? '', binding.voiceId]);
}

export function AgentVoicePicker({ value, onChange }: AgentVoicePickerProps) {
  const { t } = useI18n();
  const ttsProvidersConfig = useSlotTTSProvidersConfig();
  const { profiles: voiceProfiles } = useAllVoiceProfiles();

  const groups = useMemo(
    () => buildAgentVoiceChoices(getEnabledProvidersWithVoices(ttsProvidersConfig, voiceProfiles)),
    [ttsProvidersConfig, voiceProfiles],
  );
  const choices = useMemo(() => groups.flatMap((group) => group.choices), [groups]);

  // The bound voice, when the catalog still offers it. A binding the catalog no
  // longer offers (its provider was turned off, or its model cannot speak it)
  // stays visible as the current value — it is what the course is pinned to.
  const selected = findAgentVoiceChoice(groups, value);
  const isUnavailable = !!value && !selected;
  // The matched choice's own key, so a binding that named no model still
  // highlights the catalog option it belongs to.
  const selectedKey = selected ? voiceKey(selected) : value ? voiceKey(value) : '';

  const displayVoiceName = (voiceId: string, voiceName: string) =>
    voiceId === VOXCPM_AUTO_VOICE_ID ? t('settings.voxcpmAutoVoice') : voiceName;

  const currentLabel = selected
    ? `${selected.providerName}${selected.modelId ? ` · ${selected.modelName}` : ''} · ${displayVoiceName(selected.voiceId, selected.voiceName)}`
    : value
      ? `${value.providerId}${value.modelId ? ` · ${value.modelId}` : ''} · ${value.voiceId}`
      : t('edit.roster.voiceUnset');

  const handleChange = (event: React.ChangeEvent<HTMLSelectElement>) => {
    const raw = event.target.value;
    if (!raw) {
      onChange(undefined);
      return;
    }
    const picked = choices.find((choice) => voiceKey(choice) === raw);
    if (picked) onChange(agentVoiceBindingFor(picked));
  };

  const renderChoice = (choice: AgentVoiceChoice) => (
    <option key={voiceKey(choice)} value={voiceKey(choice)}>
      {displayVoiceName(choice.voiceId, choice.voiceName)}
    </option>
  );

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-semibold tracking-[0.01em] text-muted-foreground">
        {t('edit.roster.voiceLabel')}
      </span>
      <select
        data-testid="agent-roster-voice"
        aria-label={t('edit.roster.voiceLabel')}
        value={selectedKey}
        onChange={handleChange}
        disabled={choices.length === 0}
        className="w-full min-w-0 rounded-[10px] border border-border bg-background px-3 py-2.5 text-[12.5px] text-foreground outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20 disabled:cursor-not-allowed disabled:opacity-60"
      >
        <option value="">{t('edit.roster.voiceUnset')}</option>
        {isUnavailable && value && <option value={voiceKey(value)}>{value.voiceId}</option>}
        {groups.map((group) => (
          <optgroup key={group.key} label={group.label}>
            {group.choices.map(renderChoice)}
          </optgroup>
        ))}
      </select>
      <span className="text-[10.5px] leading-relaxed text-muted-foreground/70">
        {choices.length === 0 ? t('edit.roster.voiceNoVoices') : currentLabel}
        {isUnavailable ? ` · ${t('edit.roster.voiceUnavailable')}` : ''}
      </span>
      <span className="text-[10.5px] leading-relaxed text-muted-foreground/60">
        {t('edit.roster.voiceHint')}
      </span>
    </div>
  );
}
