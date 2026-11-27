/**
 * Course-wide speech re-narration: regenerate the audio of every spoken line in
 * the current course, and change nothing else.
 *
 * The course's content, images, videos, quizzes, scripts and roster are never
 * touched. The only thing that changes is the `audioId` of a `speech` action,
 * and it changes to a freshly allocated pooled asset: `regenerateSpeechAudio`
 * always allocates a new identity (another document may still hold the old one,
 * and no browser can prove it does not), so the old bytes are never overwritten
 * or deleted. The old pooled audio simply stops being referenced by this line.
 *
 * The run is sequential on purpose — one line at a time, in course order. A
 * provider fanning a whole course out in one request is a different (and much
 * more expensive) shape of work, and one line that fails must not take the rest
 * of the course with it.
 *
 * The run belongs to the course it started on. If another course is opened
 * while it works, it stops: a clip made for one course is never stamped on
 * another one.
 *
 * Every collaborator is injected ({@link RenarrateCourseDeps}), so the
 * orchestrator can be exercised without a provider, a store or a network.
 *
 * The owner-generation permission is NOT re-implemented here: the single call
 * that can spend the operator's provider budget goes through
 * `regenerateSpeechAudio`, which refuses on its own gate.
 */

import { regenerateSpeechAudio } from '@/lib/audio/regenerate-speech-tts';
import { stampGeneratedAudio } from '@/lib/edit/course-edit';
import { flushStageSave, useStageStore } from '@/lib/store/stage';

/**
 * The shape of a scene this module needs. Structural on purpose: the course's
 * own `Scene` type satisfies it, and so does a plain object in a test.
 */
export interface CourseSceneLike {
  readonly id: string;
  readonly order?: number | undefined;
  readonly actions?: readonly CourseSpeechActionLike[] | undefined;
}

/** The shape of an action this module needs. */
export interface CourseSpeechActionLike {
  readonly id?: string | undefined;
  readonly type?: string | undefined;
  readonly text?: string | undefined;
  readonly audioId?: string | undefined;
}

/** One spoken line, as it stood when the run took its snapshot. */
export interface CourseSpeechTarget {
  /** The scene the line lives in. */
  readonly sceneId: string;
  /** The scene's order at snapshot time. */
  readonly sceneOrder: number;
  /** The action id of the spoken line. */
  readonly actionId: string;
  /** The line's text, exactly as it read at snapshot time. */
  readonly text: string;
}

/** What happened to one line. */
export type RenarrateOutcome = 'succeeded' | 'failed' | 'skipped';

/**
 * Why a line was left as it was.
 *
 * `text-changed` and the `*-removed` reasons mean the line moved on while the
 * run was working on it, so it was not stamped; `not-stamped` means the line
 * still says the same words but the new clip did not land on it; `aborted`
 * means the run stopped before this line started; `stage-changed` means the
 * course was swapped for another one while the run was working.
 */
export type RenarrateSkipReason =
  | 'scene-removed'
  | 'action-removed'
  | 'text-changed'
  | 'not-stamped'
  | 'aborted'
  | 'stage-changed';

/**
 * Why a line could not be narrated. `no-audio` means the provider produced no
 * clip (the workspace has no managed TTS, the line is empty, the course is not
 * allowed to generate — `regenerateSpeechAudio` answers null to all of them);
 * `error` means the call itself threw.
 */
export type RenarrateFailReason = 'no-audio' | 'error';

/** The outcome for one line. */
export interface RenarrateClipResult {
  /** The line this outcome belongs to. */
  readonly target: CourseSpeechTarget;
  readonly outcome: RenarrateOutcome;
  /** The newly allocated audio id, when one was produced. */
  readonly audioId?: string;
  /** Why the line was skipped or failed. */
  readonly reason?: RenarrateSkipReason | RenarrateFailReason;
  /** The thrown error, when the line failed with one. */
  readonly error?: unknown;
}

/** How far the run has got — enough for a status row. */
export interface RenarrateProgress {
  /** How many lines the run started with. */
  readonly total: number;
  /** How many lines are settled (succeeded + failed + skipped). */
  readonly processed: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  /** The line just handled, for a "now working on…" row. */
  readonly current: CourseSpeechTarget | null;
  /** What happened to that line. */
  readonly result: RenarrateClipResult | null;
}

/** How the run ended. */
export interface RenarrateCourseResult {
  /** How many lines the run started with. */
  readonly total: number;
  readonly succeeded: number;
  readonly failed: number;
  readonly skipped: number;
  /** True when the run stopped early because the signal was aborted. */
  readonly aborted: boolean;
  /** True when the run stopped early because another course took over. */
  readonly stageChanged: boolean;
  /** One entry per line, in the order the run handled them. */
  readonly results: readonly RenarrateClipResult[];
  /**
   * The first error a save threw, if any. The clips themselves still
   * succeeded: the store keeps the unsaved change queued and retries it.
   */
  readonly saveError?: unknown;
}

/** The collaborators the run drives. */
export interface RenarrateCourseDeps {
  /** The course's scenes, read fresh every time they are needed. */
  readScenes: () => readonly CourseSceneLike[] | null | undefined;
  /**
   * The course that is on screen right now. The run takes the id it sees at
   * the start and stops when another course takes over: a line narrated for
   * one course must never be stamped on another one.
   */
  getStageId: () => string | undefined;
  /**
   * Narrate one line. Returns the freshly allocated audio id, or null when no
   * clip was produced (no managed TTS, an empty line, the course is not allowed
   * to generate, the provider declined).
   */
  regenerate: (
    sceneOrder: number,
    action: { id?: string; text?: string; audioId?: string },
    language: string | undefined,
    signal: AbortSignal | undefined,
  ) => Promise<string | null>;
  /**
   * Put the new audio id on the line — only if the line still says the same
   * words. Stamping is write-back, not an edit: it is not an undo step.
   */
  stamp: (sceneId: string, actionId: string, text: string, audioId: string) => void;
  /** Persist what was stamped. */
  flush: () => Promise<void>;
}

/** How the run is configured. */
export interface RenarrateCourseOptions {
  /** Stop the run: the clip in flight is cancelled and no further clip starts. */
  signal?: AbortSignal;
  /** The course's language directive, passed to the provider. */
  language?: string;
  /** Called once before the first line and after every settled line. */
  onProgress?: (progress: RenarrateProgress) => void;
  /** Replace collaborators (a caller with its own store, or a test). */
  deps?: Partial<RenarrateCourseDeps>;
}

function orderOf(scene: CourseSceneLike): number {
  return typeof scene.order === 'number' ? scene.order : 0;
}

/**
 * Every line of the course that has something to say, in course order.
 *
 * A line with no text, or with no id to stamp the new audio on, is not a
 * target: there is nothing to narrate and nowhere to put the result.
 *
 * The input is structural, so the course's own scenes and a plain test object
 * are both accepted.
 */
export function collectCourseSpeechTargets(
  scenes: readonly CourseSceneLike[] | null | undefined,
): CourseSpeechTarget[] {
  if (!scenes || scenes.length === 0) return [];
  const ordered = scenes
    .map((scene, index) => ({ scene, index }))
    .sort((a, b) => orderOf(a.scene) - orderOf(b.scene) || a.index - b.index)
    .map((entry) => entry.scene);
  const targets: CourseSpeechTarget[] = [];
  for (const scene of ordered) {
    if (!scene?.id) continue;
    const sceneOrder = orderOf(scene);
    for (const action of scene.actions ?? []) {
      if (!action || action.type !== 'speech') continue;
      const actionId = action.id;
      if (!actionId) continue;
      const text = action.text ?? '';
      if (!text.trim()) continue;
      targets.push({ sceneId: scene.id, sceneOrder, actionId, text });
    }
  }
  return targets;
}

/**
 * How many narrations a course-wide run would make — the number a confirmation
 * dialog shows before the operator pays for them.
 */
export function countCourseSpeechClips(
  scenes: readonly CourseSceneLike[] | null | undefined,
): number {
  return collectCourseSpeechTargets(scenes).length;
}

/** The collaborators the run uses when the caller supplies none. */
export function defaultRenarrateCourseDeps(): RenarrateCourseDeps {
  return {
    readScenes: () => useStageStore.getState().scenes,
    getStageId: () => useStageStore.getState().stage?.id,
    regenerate: (sceneOrder, action, language, signal) =>
      regenerateSpeechAudio(sceneOrder, action, language, signal),
    stamp: stampGeneratedAudio,
    flush: () => flushStageSave(),
  };
}

/** The default collaborators, with the caller's own taking their place. */
function mergeDeps(overrides: Partial<RenarrateCourseDeps> | undefined): RenarrateCourseDeps {
  const base = defaultRenarrateCourseDeps();
  if (!overrides) return base;
  return {
    readScenes: overrides.readScenes ?? base.readScenes,
    getStageId: overrides.getStageId ?? base.getStageId,
    regenerate: overrides.regenerate ?? base.regenerate,
    stamp: overrides.stamp ?? base.stamp,
    flush: overrides.flush ?? base.flush,
  };
}

/** What the course holds of one target, read fresh. */
type LiveLookup =
  | {
      readonly kind: 'found';
      readonly sceneOrder: number;
      readonly text: string;
      readonly audioId?: string;
    }
  | { readonly kind: 'scene-removed' }
  | { readonly kind: 'action-removed' }
  | { readonly kind: 'text-changed' };

/** Why a lookup that did not find a live line ended the way it did. */
function skipReasonFor(kind: Exclude<LiveLookup['kind'], 'found'>): RenarrateSkipReason {
  if (kind === 'scene-removed') return 'scene-removed';
  if (kind === 'action-removed') return 'action-removed';
  return 'text-changed';
}

/**
 * Look the target up in the course as it is NOW. The snapshot the run started
 * with may be stale: the line may have been reworded, moved to another scene
 * or deleted while the run was busy with the lines before it.
 */
function lookUpLive(
  scenes: readonly CourseSceneLike[] | null | undefined,
  target: CourseSpeechTarget,
): LiveLookup {
  const scene = scenes?.find((candidate) => candidate?.id === target.sceneId);
  if (!scene) return { kind: 'scene-removed' };
  const action = scene.actions?.find((candidate) => candidate?.id === target.actionId);
  if (!action || action.type !== 'speech') return { kind: 'action-removed' };
  const text = action.text ?? '';
  if (text !== target.text) return { kind: 'text-changed' };
  return { kind: 'found', sceneOrder: orderOf(scene), text, audioId: action.audioId };
}

/**
 * Narrate one line and put its new audio on it.
 *
 * A line that moved on is skipped, not narrated: narrating words that are no
 * longer on the line, and then stamping the result onto whatever now holds
 * that id, is exactly the clobbering the snapshot is there to prevent.
 */
async function renarrateOne(
  target: CourseSpeechTarget,
  deps: RenarrateCourseDeps,
  options: RenarrateCourseOptions,
  state: RunState,
): Promise<RenarrateClipResult> {
  const live = lookUpLive(deps.readScenes(), target);
  if (live.kind !== 'found') {
    return { target, outcome: 'skipped', reason: skipReasonFor(live.kind) };
  }

  let audioId: string | null = null;
  try {
    audioId = await deps.regenerate(
      live.sceneOrder,
      { id: target.actionId, text: live.text, audioId: live.audioId },
      options.language,
      options.signal,
    );
  } catch (error) {
    return { target, outcome: 'failed', reason: 'error', error };
  }
  if (!audioId) return { target, outcome: 'failed', reason: 'no-audio' };

  if (deps.getStageId() !== state.stageId) {
    // Another course took over while this clip was being made. The clip was
    // made for the course this run started on, so it is not stamped on the
    // one that is on screen now.
    state.stageChanged = true;
    return { target, outcome: 'skipped', reason: 'stage-changed', audioId };
  }

  try {
    // The stamp lands only if the line still says these words.
    deps.stamp(target.sceneId, target.actionId, live.text, audioId);
  } catch (error) {
    return { target, outcome: 'failed', reason: 'error', audioId, error };
  }

  const after = lookUpLive(deps.readScenes(), target);
  if (after.kind !== 'found') {
    // The line moved on while the clip was being made: the new audio was not
    // put on it, and the old clip is still the one that plays.
    return { target, outcome: 'skipped', reason: skipReasonFor(after.kind), audioId };
  }
  if (after.audioId !== audioId) {
    // The line still says these words, but the new clip is not on it.
    return { target, outcome: 'skipped', reason: 'not-stamped', audioId };
  }

  // Persist the stamp now, so a run that is interrupted keeps every clip it
  // has already narrated. A save that fails leaves the change queued for the
  // store's own retry: the clip still succeeded.
  try {
    await deps.flush();
  } catch (error) {
    if (state.saveError === undefined) state.saveError = error;
  }
  return { target, outcome: 'succeeded', audioId };
}

/** The running totals of one run. */
interface RunState {
  /** The course the run started on. */
  stageId: string | undefined;
  succeeded: number;
  failed: number;
  skipped: number;
  stageChanged: boolean;
  saveError?: unknown;
}

/**
 * Narrate every spoken line of the current course, one at a time.
 *
 * The run stops early when the signal is aborted: the clip in flight is
 * cancelled, no further clip starts, and the lines that were never started are
 * reported as skipped. It stops the same way when another course takes over
 * mid-run, so a clip made for one course is never stamped on another. A line
 * that fails does not stop the others.
 */
export async function renarrateCourse(
  options: RenarrateCourseOptions = {},
): Promise<RenarrateCourseResult> {
  const deps = mergeDeps(options.deps);
  const state: RunState = {
    stageId: deps.getStageId(),
    succeeded: 0,
    failed: 0,
    skipped: 0,
    stageChanged: false,
  };
  const targets = collectCourseSpeechTargets(deps.readScenes());
  const results: RenarrateClipResult[] = [];
  let aborted = false;

  const report = (current: CourseSpeechTarget | null, result: RenarrateClipResult | null) => {
    options.onProgress?.({
      total: targets.length,
      processed: results.length,
      succeeded: state.succeeded,
      failed: state.failed,
      skipped: state.skipped,
      current,
      result,
    });
  };

  report(null, null);

  for (const target of targets) {
    if (options.signal?.aborted) {
      aborted = true;
      break;
    }
    if (deps.getStageId() !== state.stageId) {
      // Another course is on screen now: this run belongs to the one that was.
      state.stageChanged = true;
      break;
    }
    const settled = await renarrateOne(target, deps, options, state);
    results.push(settled);
    if (settled.outcome === 'succeeded') state.succeeded += 1;
    else if (settled.outcome === 'failed') state.failed += 1;
    else state.skipped += 1;
    report(target, settled);
  }

  if (aborted || state.stageChanged) {
    // The lines the run never started are settled as skipped, so the counts
    // always add up to the total.
    const reason: RenarrateSkipReason = aborted ? 'aborted' : 'stage-changed';
    for (const target of targets.slice(results.length)) {
      results.push({ target, outcome: 'skipped', reason });
      state.skipped += 1;
    }
  }

  report(null, null);

  return {
    total: targets.length,
    succeeded: state.succeeded,
    failed: state.failed,
    skipped: state.skipped,
    aborted,
    stageChanged: state.stageChanged,
    results,
    ...(state.saveError === undefined ? {} : { saveError: state.saveError }),
  };
}
