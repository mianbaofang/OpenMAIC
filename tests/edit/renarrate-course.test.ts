import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The orchestrator is exercised through injected collaborators: a fake course,
 * a fake provider and a fake save. The real modules are mocked out so the
 * suite never loads a provider, an IndexedDB or the network.
 */
const mocks = vi.hoisted(() => ({
  regenerateSpeechAudio: vi.fn(),
  stampGeneratedAudio: vi.fn(),
  flushStageSave: vi.fn(),
  stageScenes: [] as unknown[],
}));

vi.mock('@/lib/audio/regenerate-speech-tts', () => ({
  regenerateSpeechAudio: mocks.regenerateSpeechAudio,
}));

vi.mock('@/lib/edit/course-edit', () => ({
  stampGeneratedAudio: mocks.stampGeneratedAudio,
}));

vi.mock('@/lib/store/stage', () => ({
  useStageStore: { getState: () => ({ scenes: mocks.stageScenes }) },
  flushStageSave: mocks.flushStageSave,
}));

import {
  collectCourseSpeechTargets,
  countCourseSpeechClips,
  renarrateCourse,
  type CourseSceneLike,
  type RenarrateCourseDeps,
  type RenarrateProgress,
} from '@/lib/edit/renarrate-course';

interface FakeAction {
  id?: string;
  type: string;
  text?: string;
  audioId?: string;
  elementId?: string;
}

interface FakeScene {
  id: string;
  order: number;
  actions: FakeAction[];
  content?: { untouched: boolean };
}

type RegenerateFn = RenarrateCourseDeps['regenerate'];
type StampFn = RenarrateCourseDeps['stamp'];
type FlushFn = RenarrateCourseDeps['flush'];

type RegenerateMock = ReturnType<typeof vi.fn<RegenerateFn>>;
type StampMock = ReturnType<typeof vi.fn<StampFn>>;
type FlushMock = ReturnType<typeof vi.fn<FlushFn>>;

/** A course of three spoken lines across two scenes, plus a non-speech cue. */
function threeLineCourse(): FakeScene[] {
  return [
    {
      id: 's1',
      order: 1,
      actions: [
        { id: 'a1', type: 'speech', text: 'First line', audioId: 'old-a1' },
        { id: 'cue-1', type: 'spotlight', elementId: 'e1' },
        { id: 'a2', type: 'speech', text: 'Second line', audioId: 'old-a2' },
      ],
      content: { untouched: true },
    },
    {
      id: 's2',
      order: 2,
      actions: [{ id: 'a3', type: 'speech', text: 'Third line' }],
      content: { untouched: true },
    },
  ];
}

/**
 * Stamping the way `stampGeneratedAudio` does it: the new audio id lands on
 * the line only while the line still says the same words.
 */
function stampInto(scenes: FakeScene[]): StampFn {
  return (sceneId, actionId, text, audioId) => {
    const scene = scenes.find((candidate) => candidate.id === sceneId);
    const action = scene?.actions.find((candidate) => candidate.id === actionId);
    if (!scene || !action || action.type !== 'speech' || action.text !== text) return;
    action.audioId = audioId;
  };
}

function depsFor(
  scenes: FakeScene[],
  overrides: {
    getStageId?: () => string | undefined;
    regenerate?: RegenerateMock;
    stamp?: StampMock;
    flush?: FlushMock;
  } = {},
) {
  const base = {
    readScenes: (): readonly CourseSceneLike[] => scenes,
    getStageId: (): string | undefined => 'stage-1',
    regenerate: vi.fn<RegenerateFn>(async (_sceneOrder, action) =>
      action.id ? `audio-${action.id}` : null,
    ),
    stamp: vi.fn<StampFn>(stampInto(scenes)),
    flush: vi.fn<FlushFn>(async () => {}),
  };
  return {
    readScenes: base.readScenes,
    getStageId: overrides.getStageId ?? base.getStageId,
    regenerate: overrides.regenerate ?? base.regenerate,
    stamp: overrides.stamp ?? base.stamp,
    flush: overrides.flush ?? base.flush,
  };
}

beforeEach(() => {
  mocks.regenerateSpeechAudio.mockReset();
  mocks.stampGeneratedAudio.mockReset();
  mocks.flushStageSave.mockReset().mockResolvedValue(undefined);
  mocks.stageScenes = [];
});

describe('collecting the lines to narrate', () => {
  it('takes every spoken line, in course order', () => {
    const scenes = threeLineCourse();
    // Deliberately out of order in the array: the course order is the scenes'
    // own order, and the lines of a scene keep the order they are in.
    const shuffled = [scenes[1], scenes[0]];

    expect(collectCourseSpeechTargets(shuffled)).toEqual([
      { sceneId: 's1', sceneOrder: 1, actionId: 'a1', text: 'First line' },
      { sceneId: 's1', sceneOrder: 1, actionId: 'a2', text: 'Second line' },
      { sceneId: 's2', sceneOrder: 2, actionId: 'a3', text: 'Third line' },
    ]);
  });

  it('leaves out a line with no words and a line with no id', () => {
    const scenes: FakeScene[] = [
      {
        id: 's1',
        order: 1,
        actions: [
          { id: 'blank', type: 'speech', text: '   ' },
          { id: 'empty', type: 'speech', text: '' },
          { type: 'speech', text: 'No id at all' },
          { id: 'no-text', type: 'speech' },
          { id: 'cue-1', type: 'spotlight' },
          { id: 'good', type: 'speech', text: 'Kept' },
        ],
      },
    ];

    expect(collectCourseSpeechTargets(scenes).map((target) => target.actionId)).toEqual(['good']);
    expect(countCourseSpeechClips(scenes)).toBe(1);
  });

  it('counts nothing for a course without spoken lines', () => {
    expect(collectCourseSpeechTargets([])).toEqual([]);
    expect(countCourseSpeechClips(undefined)).toBe(0);
    expect(
      countCourseSpeechClips([{ id: 's1', order: 1, actions: [{ id: 'c', type: 'laser' }] }]),
    ).toBe(0);
  });
});

describe('narrating the course', () => {
  it('narrates one line at a time, in order, and puts each new clip on its line', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes);
    const order: string[] = [];

    const result = await renarrateCourse({
      deps: {
        ...deps,
        regenerate: vi.fn<RegenerateFn>(async (_sceneOrder, action) => {
          order.push(`regen:${action.id}`);
          return `audio-${action.id}`;
        }),
      },
    });

    expect(order).toEqual(['regen:a1', 'regen:a2', 'regen:a3']);
    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(3);
    expect(result.failed).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.aborted).toBe(false);

    // The line now carries the new clip; nothing else about the course moved.
    expect(scenes[0].actions[0]).toMatchObject({ id: 'a1', audioId: 'audio-a1' });
    expect(scenes[0].actions[2]).toMatchObject({ id: 'a2', audioId: 'audio-a2' });
    expect(scenes[1].actions[0]).toMatchObject({ id: 'a3', audioId: 'audio-a3' });
    expect(scenes[0].actions[1]).toEqual({ id: 'cue-1', type: 'spotlight', elementId: 'e1' });
    expect(scenes[0].content).toEqual({ untouched: true });
    expect(scenes[1].content).toEqual({ untouched: true });
  });

  it('stamps the new id and saves it', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes);

    await renarrateCourse({ deps, language: 'English' });

    expect(deps.stamp).toHaveBeenCalledWith('s1', 'a1', 'First line', 'audio-a1');
    expect(deps.stamp).toHaveBeenCalledWith('s2', 'a3', 'Third line', 'audio-a3');
    // One save per narrated line, so an interrupted run keeps what it made.
    expect(deps.flush).toHaveBeenCalledTimes(3);
  });

  it('hands the line its own text and the clip it already had', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes);

    await renarrateCourse({ deps, language: 'English' });

    expect(deps.regenerate).toHaveBeenCalledWith(
      1,
      { id: 'a1', text: 'First line', audioId: 'old-a1' },
      'English',
      undefined,
    );
  });

  it('reports the counts and keeps them adding up', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes, {
      regenerate: vi.fn<RegenerateFn>(async (_sceneOrder, action) => {
        if (action.id === 'a2') throw new Error('provider refused');
        return action.id ? `audio-${action.id}` : null;
      }),
    });

    const result = await renarrateCourse({ deps });

    expect(result.total).toBe(3);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.skipped).toBe(0);
    expect(result.succeeded + result.failed + result.skipped).toBe(result.total);
    expect(result.results).toHaveLength(3);
    expect(result.results[1]).toMatchObject({ outcome: 'failed', reason: 'error' });
    expect(result.results[1].error).toBeInstanceOf(Error);
  });

  it('keeps going after a line fails, and saves the lines that worked', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes, {
      regenerate: vi.fn<RegenerateFn>(async (_sceneOrder, action) => {
        if (action.id === 'a1') throw new Error('provider refused');
        return action.id ? `audio-${action.id}` : null;
      }),
    });

    const result = await renarrateCourse({ deps });

    expect(deps.regenerate).toHaveBeenCalledTimes(3);
    expect(result.failed).toBe(1);
    expect(result.succeeded).toBe(2);
    expect(deps.flush).toHaveBeenCalledTimes(2);
    expect(scenes[0].actions[0].audioId).toBe('old-a1');
    expect(scenes[0].actions[2].audioId).toBe('audio-a2');
  });

  it('counts a line the provider refused as failed, not narrated', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes, { regenerate: vi.fn<RegenerateFn>(async () => null) });

    const result = await renarrateCourse({ deps });

    expect(result.failed).toBe(3);
    expect(result.succeeded).toBe(0);
    expect(deps.stamp).not.toHaveBeenCalled();
    expect(deps.flush).not.toHaveBeenCalled();
  });

  it('tells the caller how far it got', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes);
    const seen: RenarrateProgress[] = [];

    await renarrateCourse({ deps, onProgress: (progress) => seen.push(progress) });

    expect(seen[0]).toMatchObject({ total: 3, processed: 0, succeeded: 0 });
    expect(seen[1]).toMatchObject({ processed: 1, succeeded: 1 });
    expect(seen[1].current).toMatchObject({ actionId: 'a1' });
    expect(seen[1].result).toMatchObject({ outcome: 'succeeded', audioId: 'audio-a1' });
    expect(seen.at(-1)).toMatchObject({
      total: 3,
      processed: 3,
      succeeded: 3,
      failed: 0,
      skipped: 0,
    });
  });
});

describe('a line that moved on', () => {
  it('skips a line whose words changed, and never calls the provider for it', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes, {
      regenerate: vi.fn<RegenerateFn>(async (_sceneOrder, action) => {
        // The line is reworded while the run is busy with the line before it.
        if (action.id === 'a1') scenes[0].actions[2].text = 'Reworded while the run was busy';
        return `audio-${action.id}`;
      }),
    });

    const result = await renarrateCourse({ deps });

    expect(deps.regenerate).toHaveBeenCalledTimes(2);
    expect(result.total).toBe(3);
    expect(result.skipped).toBe(1);
    expect(result.succeeded).toBe(2);
    expect(result.results[1]).toMatchObject({ outcome: 'skipped', reason: 'text-changed' });
    expect(scenes[0].actions[2].audioId).toBe('old-a2');
  });

  it('skips a line that was deleted, and never calls the provider for it', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes, {
      regenerate: vi.fn<RegenerateFn>(async (_sceneOrder, action) => {
        if (action.id === 'a1') {
          scenes[0].actions = scenes[0].actions.filter((action) => action.id !== 'a2');
        }
        return `audio-${action.id}`;
      }),
    });

    const result = await renarrateCourse({ deps });

    expect(deps.regenerate).toHaveBeenCalledTimes(2);
    expect(result.skipped).toBe(1);
    expect(result.results[1]).toMatchObject({ outcome: 'skipped', reason: 'action-removed' });
  });

  it('skips a line whose scene was deleted', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes, {
      regenerate: vi.fn<RegenerateFn>(async (_sceneOrder, action) => {
        if (action.id === 'a1') scenes.splice(1, 1);
        return `audio-${action.id}`;
      }),
    });

    const result = await renarrateCourse({ deps });

    expect(result.skipped).toBe(1);
    expect(result.results[2]).toMatchObject({ outcome: 'skipped', reason: 'scene-removed' });
  });

  it('leaves a line alone when it changed while its own clip was being made', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes, {
      regenerate: vi.fn<RegenerateFn>(async (_sceneOrder, action) => {
        if (action.id === 'a1') scenes[0].actions[0].text = 'Reworded mid-flight';
        return `audio-${action.id}`;
      }),
    });

    const result = await renarrateCourse({ deps });

    // The stamp did not land, so the old clip is still the one that plays.
    expect(scenes[0].actions[0].audioId).toBe('old-a1');
    expect(result.results[0]).toMatchObject({ outcome: 'skipped', reason: 'text-changed' });
    expect(result.succeeded).toBe(2);
  });

  it('does not claim a line it could not put the new clip on', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes, { stamp: vi.fn<StampFn>(() => {}) });

    const result = await renarrateCourse({ deps });

    expect(result.succeeded).toBe(0);
    expect(result.skipped).toBe(3);
    expect(result.results[0]).toMatchObject({ outcome: 'skipped', reason: 'not-stamped' });
    expect(deps.flush).not.toHaveBeenCalled();
  });
});

describe('stopping the run', () => {
  it('starts nothing when the signal is already aborted', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes);
    const controller = new AbortController();
    controller.abort();

    const result = await renarrateCourse({ deps, signal: controller.signal });

    expect(deps.regenerate).not.toHaveBeenCalled();
    expect(result.aborted).toBe(true);
    expect(result.total).toBe(3);
    expect(result.skipped).toBe(3);
    expect(result.succeeded).toBe(0);
    expect(result.failed).toBe(0);
    expect(result.results.every((entry) => entry.reason === 'aborted')).toBe(true);
  });

  it('stops before the next line starts, and reports the rest as skipped', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes);
    const controller = new AbortController();
    const regenerate = vi.fn<RegenerateFn>(async (_sceneOrder, action) => {
      controller.abort();
      return action.id ? `audio-${action.id}` : null;
    });

    const result = await renarrateCourse({
      deps: { ...deps, regenerate },
      signal: controller.signal,
    });

    expect(regenerate).toHaveBeenCalledTimes(1);
    expect(result.aborted).toBe(true);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.succeeded + result.failed + result.skipped).toBe(result.total);
    expect(result.results.map((entry) => entry.outcome)).toEqual([
      'succeeded',
      'skipped',
      'skipped',
    ]);
    expect(result.results[1].reason).toBe('aborted');
  });

  it('hands the signal to the provider, so the clip in flight can be cancelled', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes);
    const controller = new AbortController();

    await renarrateCourse({ deps, signal: controller.signal });

    expect(deps.regenerate).toHaveBeenCalledWith(
      1,
      expect.objectContaining({ id: 'a1' }),
      undefined,
      controller.signal,
    );
  });
});

describe('another course taking over', () => {
  it('leaves the new course alone when the swap happens mid-clip', async () => {
    const scenes = threeLineCourse();
    let stageId: string | undefined = 'stage-1';
    const deps = depsFor(scenes, {
      getStageId: () => stageId,
      regenerate: vi.fn<RegenerateFn>(async (_sceneOrder, action) => {
        // Another course is opened while the first clip is being made.
        if (action.id === 'a1') stageId = 'stage-2';
        return `audio-${action.id}`;
      }),
    });

    const result = await renarrateCourse({ deps });

    expect(result.stageChanged).toBe(true);
    expect(deps.regenerate).toHaveBeenCalledTimes(1);
    // The clip made for the first course is not stamped on anything.
    expect(deps.stamp).not.toHaveBeenCalled();
    expect(scenes[0].actions[0].audioId).toBe('old-a1');
    expect(result.succeeded).toBe(0);
    expect(result.skipped).toBe(3);
    expect(result.results[0]).toMatchObject({ outcome: 'skipped', reason: 'stage-changed' });
    expect(result.results[1]).toMatchObject({ outcome: 'skipped', reason: 'stage-changed' });
  });

  it('does not start another clip once another course has taken over', async () => {
    const scenes = threeLineCourse();
    let stageId: string | undefined = 'stage-1';
    const deps = depsFor(scenes, {
      getStageId: () => stageId,
      flush: vi.fn<FlushFn>(async () => {
        stageId = 'stage-2';
      }),
    });

    const result = await renarrateCourse({ deps });

    expect(deps.regenerate).toHaveBeenCalledTimes(1);
    expect(result.stageChanged).toBe(true);
    expect(result.succeeded).toBe(1);
    expect(result.skipped).toBe(2);
    expect(result.results[1].reason).toBe('stage-changed');
  });
});

describe('the save', () => {
  it('reports a save that failed, and keeps the clip', async () => {
    const scenes = threeLineCourse();
    const deps = depsFor(scenes, {
      flush: vi.fn<FlushFn>(async () => {
        throw new Error('the server said no');
      }),
    });

    const result = await renarrateCourse({ deps });

    expect(result.succeeded).toBe(3);
    expect(result.saveError).toBeInstanceOf(Error);
    expect(scenes[0].actions[0].audioId).toBe('audio-a1');
  });
});
