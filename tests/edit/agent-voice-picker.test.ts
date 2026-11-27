import { describe, expect, it } from 'vitest';
import {
  agentVoiceBindingFor,
  buildAgentVoiceChoices,
  findAgentVoiceChoice,
  pickNarratorAgentId,
} from '@/lib/edit/agent-voice-picker';
import { pickNarratorAgent } from '@/lib/audio/agent-voice-options';
import type { ProviderWithVoices } from '@/lib/audio/voice-resolver';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

const AGENT = (id: string, role = 'teacher'): GeneratedAgentConfig => ({
  id,
  name: id,
  role,
  persona: '',
  avatar: '/avatars/teacher.png',
  color: '#000',
  priority: 10,
});

const REGISTRY_AGENT = (id: string, role = 'teacher'): AgentConfig => ({
  id,
  name: id,
  role,
  persona: '',
  avatar: '/avatars/teacher.png',
  color: '#000',
  allowedActions: [],
  priority: 10,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  isDefault: false,
});

const PROVIDER = (overrides: Partial<ProviderWithVoices> = {}): ProviderWithVoices => ({
  providerId: 'openai-tts',
  providerName: 'OpenAI TTS',
  voices: [],
  modelGroups: [],
  ...overrides,
});

describe('pickNarratorAgentId', () => {
  it('prefers the first teacher that already carries a voice binding', () => {
    const roster: GeneratedAgentConfig[] = [
      AGENT('t1'),
      { ...AGENT('t2'), voiceConfig: { providerId: 'openai-tts', voiceId: 'marin' } },
      { ...AGENT('t3'), voiceConfig: { providerId: 'qwen-tts', voiceId: 'cherry' } },
    ];
    expect(pickNarratorAgentId(roster)).toBe('t2');
  });

  it('falls back to the first teacher with a voice design', () => {
    const roster: GeneratedAgentConfig[] = [
      AGENT('t1'),
      {
        ...AGENT('t2'),
        voiceDesign: { identity: 'a teacher', texture: '', delivery: '' },
      },
    ];
    expect(pickNarratorAgentId(roster)).toBe('t2');
  });

  it('falls back to the first teacher when nobody carries a voice', () => {
    const roster: GeneratedAgentConfig[] = [AGENT('s1', 'student'), AGENT('t1'), AGENT('t2')];
    expect(pickNarratorAgentId(roster)).toBe('t1');
  });

  it('has no narrator without a teacher', () => {
    expect(pickNarratorAgentId([AGENT('s1', 'student')])).toBeUndefined();
    expect(pickNarratorAgentId([])).toBeUndefined();
  });

  it('agrees with the narration path (pickNarratorAgent)', () => {
    const cases: GeneratedAgentConfig[][] = [
      [AGENT('t1'), AGENT('t2')],
      [
        AGENT('t1'),
        { ...AGENT('t2'), voiceConfig: { providerId: 'openai-tts', voiceId: 'marin' } },
      ],
      [
        {
          ...AGENT('t1'),
          voiceDesign: { identity: 'a teacher', texture: '', delivery: '' },
        },
        AGENT('t2'),
      ],
      [
        AGENT('t1'),
        { ...AGENT('t2'), voiceConfig: { providerId: 'openai-tts', voiceId: 'marin' } },
        { ...AGENT('t3'), voiceDesign: { identity: 'a teacher', texture: '', delivery: '' } },
      ],
    ];
    for (const roster of cases) {
      const registry: AgentConfig[] = roster.map((agent) => ({
        ...REGISTRY_AGENT(agent.id, agent.role),
        // The contract keeps providerId an open string; the registry narrows it.
        ...(agent.voiceConfig
          ? { voiceConfig: agent.voiceConfig as AgentConfig['voiceConfig'] }
          : {}),
        ...(agent.voiceDesign ? { voiceDesign: agent.voiceDesign } : {}),
      }));
      expect(pickNarratorAgentId(roster)).toBe(pickNarratorAgent(registry)?.id);
    }
  });
});

describe('buildAgentVoiceChoices', () => {
  it('offers every voice of every model group, with its model', () => {
    const groups = buildAgentVoiceChoices([
      PROVIDER({
        modelGroups: [
          {
            modelId: 'gpt-4o-mini-tts',
            modelName: 'GPT-4o Mini TTS',
            voices: [{ id: 'marin', name: 'Marin' }],
          },
        ],
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('OpenAI TTS · GPT-4o Mini TTS');
    expect(groups[0].choices).toEqual([
      {
        providerId: 'openai-tts',
        modelId: 'gpt-4o-mini-tts',
        voiceId: 'marin',
        voiceName: 'Marin',
        providerName: 'OpenAI TTS',
        modelName: 'GPT-4o Mini TTS',
      },
    ]);
  });

  it('leaves the model out when the provider has none', () => {
    const groups = buildAgentVoiceChoices([
      PROVIDER({
        providerId: 'custom-tts-demo',
        providerName: 'Custom TTS',
        modelGroups: [
          { modelId: '', modelName: 'Custom TTS', voices: [{ id: 'v1', name: 'Voice One' }] },
        ],
      }),
    ]);
    expect(groups[0].label).toBe('Custom TTS');
    expect(groups[0].choices[0].modelId).toBeUndefined();
  });

  it('skips a model group that has no voice', () => {
    const groups = buildAgentVoiceChoices([
      PROVIDER({
        modelGroups: [
          { modelId: 'gpt-4o-mini-tts', modelName: 'GPT-4o Mini TTS', voices: [] },
          {
            modelId: 'tts-1',
            modelName: 'TTS-1',
            voices: [{ id: 'alloy', name: 'Alloy' }],
          },
        ],
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].choices.map((choice) => choice.voiceId)).toEqual(['alloy']);
  });

  it('keeps providers and models in catalog order', () => {
    const groups = buildAgentVoiceChoices([
      PROVIDER({
        providerId: 'openai-tts',
        providerName: 'A TTS',
        modelGroups: [
          { modelId: 'a1', modelName: 'A1', voices: [{ id: 'a-voice', name: 'A Voice' }] },
        ],
      }),
      PROVIDER({
        providerId: 'azure-tts',
        providerName: 'B TTS',
        modelGroups: [
          { modelId: 'b1', modelName: 'B1', voices: [{ id: 'b-voice', name: 'B Voice' }] },
        ],
      }),
    ]);
    expect(groups.map((group) => group.key)).toEqual(['openai-tts::a1', 'azure-tts::b1']);
  });

  it('has nothing to offer without a provider', () => {
    expect(buildAgentVoiceChoices([])).toEqual([]);
  });
});

describe('findAgentVoiceChoice', () => {
  const groups = buildAgentVoiceChoices([
    PROVIDER({
      modelGroups: [
        {
          modelId: 'gpt-4o-mini-tts',
          modelName: 'GPT-4o Mini TTS',
          voices: [{ id: 'marin', name: 'Marin' }],
        },
      ],
    }),
  ]);

  it('finds the bound voice', () => {
    const choice = findAgentVoiceChoice(groups, {
      providerId: 'openai-tts',
      modelId: 'gpt-4o-mini-tts',
      voiceId: 'marin',
    });
    expect(choice?.voiceName).toBe('Marin');
  });

  it('finds a binding that names no model', () => {
    // Older documents leave the model out; the voice is still the course voice.
    const choice = findAgentVoiceChoice(groups, { providerId: 'openai-tts', voiceId: 'marin' });
    expect(choice?.voiceId).toBe('marin');
    expect(choice?.modelId).toBe('gpt-4o-mini-tts');
  });

  it('does not re-point a binding whose model cannot speak the voice', () => {
    expect(
      findAgentVoiceChoice(groups, {
        providerId: 'openai-tts',
        modelId: 'some-other-model',
        voiceId: 'marin',
      }),
    ).toBeUndefined();
  });

  it('does not find a voice the catalog does not offer', () => {
    expect(
      findAgentVoiceChoice(groups, { providerId: 'openai-tts', voiceId: 'cedar' }),
    ).toBeUndefined();
    expect(
      findAgentVoiceChoice(groups, { providerId: 'other-tts', voiceId: 'marin' }),
    ).toBeUndefined();
    expect(findAgentVoiceChoice(groups, undefined)).toBeUndefined();
  });

  it('matches a model-less binding to the provider voice of the first group', () => {
    const multi = buildAgentVoiceChoices([
      PROVIDER({
        providerId: 'qwen-tts',
        providerName: 'Qwen TTS',
        modelGroups: [
          {
            modelId: 'qwen3-tts-flash',
            modelName: 'Qwen3 TTS Flash',
            voices: [{ id: 'cherry', name: 'Cherry' }],
          },
          {
            modelId: 'qwen3-tts-vc-2026-01-22',
            modelName: 'CosyVoice Voice Clone',
            voices: [{ id: 'clone-1', name: 'My Clone' }],
          },
        ],
      }),
    ]);
    expect(
      findAgentVoiceChoice(multi, { providerId: 'qwen-tts', voiceId: 'cherry' })?.modelId,
    ).toBe('qwen3-tts-flash');
    expect(
      findAgentVoiceChoice(multi, { providerId: 'qwen-tts', voiceId: 'clone-1' })?.modelId,
    ).toBe('qwen3-tts-vc-2026-01-22');
  });
});

describe('agentVoiceBindingFor', () => {
  it('persists provider, model and voice — and nothing else', () => {
    expect(
      agentVoiceBindingFor({
        providerId: 'openai-tts',
        modelId: 'gpt-4o-mini-tts',
        voiceId: 'marin',
        voiceName: 'Marin',
        providerName: 'OpenAI TTS',
        modelName: 'GPT-4o Mini TTS',
      }),
    ).toEqual({ providerId: 'openai-tts', modelId: 'gpt-4o-mini-tts', voiceId: 'marin' });
  });

  it('omits the model when the provider has none', () => {
    expect(
      agentVoiceBindingFor({
        providerId: 'custom-tts-demo',
        voiceId: 'v1',
        voiceName: 'Voice One',
        providerName: 'Custom TTS',
        modelName: 'Custom TTS',
      }),
    ).toEqual({ providerId: 'custom-tts-demo', voiceId: 'v1' });
  });
});
