'use client';

/**
 * Course-wide narration refresh for the roster's narrator.
 *
 * The voice picker above rewrites the teacher's persisted binding. This panel
 * turns that binding into new speech clips without touching the rest of the
 * course: every target goes through the existing owner-gated speech helper,
 * gets a fresh pooled audio id, and is stamped only while its text still
 * matches. The confirmation names the clip count before any provider work.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, RefreshCw, Square } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMayGenerateForStage } from '@/lib/classroom/generation-permission';
import { regenerateSpeechAudio } from '@/lib/audio/regenerate-speech-tts';
import { useSlotTTSProvidersConfig, useTTSSelection } from '@/lib/audio/use-tts-selection';
import { resolveNarratorVoiceBinding, type ResolvedVoice } from '@/lib/audio/voice-resolver';
import { useI18n } from '@/lib/hooks/use-i18n';
import {
  countCourseSpeechClips,
  renarrateCourse,
  type RenarrateCourseResult,
  type RenarrateProgress,
} from '@/lib/edit/renarrate-course';
import { flushStageSave, useStageStore } from '@/lib/store/stage';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

interface CourseNarrationPanelProps {
  /** The narrator's persisted course binding; absent means use the workspace voice. */
  readonly voiceConfig?: GeneratedAgentConfig['voiceConfig'];
}

type Phase = 'idle' | 'confirm' | 'running' | 'done';

export function CourseNarrationPanel({ voiceConfig }: CourseNarrationPanelProps) {
  const { t } = useI18n();
  const stageId = useStageStore((state) => state.stage?.id);
  const scenes = useStageStore((state) => state.scenes);
  const language = useStageStore((state) => state.stage?.languageDirective);
  const courseGenerating = useStageStore((state) => state.courseGenerating);
  const mayGenerate = useMayGenerateForStage(stageId);
  const selection = useTTSSelection();
  const providersConfig = useSlotTTSProvidersConfig();

  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState<RenarrateProgress | null>(null);
  const [result, setResult] = useState<RenarrateCourseResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const abortRef = useRef<AbortController | null>(null);

  const clipCount = useMemo(() => countCourseSpeechClips(scenes), [scenes]);
  const managedTts = !!selection && selection.providerId !== 'browser-native-tts';

  // Capture the same effective voice the narration resolver would choose now,
  // then pin it for the whole batch. A roster/global edit mid-run cannot make
  // later clips switch timbre.
  const resolvedVoice = useMemo<ResolvedVoice | undefined>(() => {
    if (!selection) return undefined;
    return resolveNarratorVoiceBinding(
      voiceConfig as ResolvedVoice | undefined,
      {
        providerId: selection.providerId,
        ...(selection.modelId ? { modelId: selection.modelId } : {}),
        voiceId: selection.voice,
      },
      providersConfig,
    );
  }, [providersConfig, selection, voiceConfig]);

  const disabledReason = !managedTts
    ? t('edit.roster.renarrateUnavailable')
    : !mayGenerate
      ? t('edit.roster.renarrateNotOwner')
      : courseGenerating
        ? t('edit.roster.renarrateGenerating')
        : clipCount === 0
          ? t('edit.roster.renarrateNoClips')
          : undefined;

  useEffect(() => () => abortRef.current?.abort(), []);

  const start = async () => {
    if (!resolvedVoice || disabledReason || phase === 'running' || abortRef.current) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase('running');
    setProgress(null);
    setResult(null);
    setError(null);
    try {
      // Persist a just-picked roster voice before the first paid request.
      await flushStageSave();
      const next = await renarrateCourse({
        signal: controller.signal,
        language,
        onProgress: setProgress,
        deps: {
          regenerate: (sceneOrder, action, clipLanguage, signal) =>
            regenerateSpeechAudio(sceneOrder, action, clipLanguage, signal, resolvedVoice),
        },
      });
      setResult(next);
    } catch (cause) {
      setError(cause);
    } finally {
      abortRef.current = null;
      setPhase('done');
    }
  };

  const reset = () => {
    setPhase('idle');
    setProgress(null);
    setResult(null);
    setError(null);
  };

  const processed = progress?.processed ?? 0;
  const total = progress?.total ?? clipCount;
  const percent = total > 0 ? Math.round((processed / total) * 100) : 0;

  return (
    <div className="mt-1 flex flex-col gap-2 rounded-[10px] border border-border bg-background/60 p-2.5">
      {phase === 'idle' && (
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="course-renarrate"
            disabled={!!disabledReason}
            onClick={() => setPhase('confirm')}
            className="w-full justify-center"
          >
            <RefreshCw className="size-3.5" />
            {t('edit.roster.renarrateButton', { count: clipCount })}
          </Button>
          {disabledReason && (
            <span className="text-[10.5px] leading-relaxed text-muted-foreground/70">
              {disabledReason}
            </span>
          )}
        </>
      )}

      {phase === 'confirm' && (
        <div role="group" aria-labelledby="course-renarrate-title" className="flex flex-col gap-2">
          <span id="course-renarrate-title" className="text-[12px] font-semibold text-foreground">
            {t('edit.roster.renarrateConfirmTitle')}
          </span>
          <span className="text-[10.5px] leading-relaxed text-muted-foreground">
            {t('edit.roster.renarrateConfirmBody', { count: clipCount })}
          </span>
          <div className="flex items-center justify-end gap-2">
            <Button type="button" variant="ghost" size="xs" onClick={reset}>
              {t('common.cancel')}
            </Button>
            <Button
              type="button"
              size="xs"
              data-testid="course-renarrate-confirm"
              onClick={() => void start()}
            >
              {t('common.confirm')}
            </Button>
          </div>
        </div>
      )}

      {phase === 'running' && (
        <div className="flex flex-col gap-2" aria-live="polite">
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {t('edit.roster.renarrateProgress', { processed, total })}
          </div>
          <div
            role="progressbar"
            aria-label={t('edit.roster.renarrateButton', { count: total })}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={processed}
            className="h-1.5 overflow-hidden rounded-full bg-muted"
          >
            <div
              className="h-full rounded-full bg-primary transition-[width] duration-300"
              style={{ width: `${percent}%` }}
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="xs"
            data-testid="course-renarrate-stop"
            onClick={() => abortRef.current?.abort()}
            className="self-end"
          >
            <Square className="size-3" />
            {t('edit.roster.renarrateStop')}
          </Button>
        </div>
      )}

      {phase === 'done' && (
        <div className="flex flex-col gap-1.5" aria-live="polite">
          {result && (
            <span className="text-[10.5px] leading-relaxed text-muted-foreground">
              {t('edit.roster.renarrateResult', {
                succeeded: result.succeeded,
                failed: result.failed,
                skipped: result.skipped,
              })}
            </span>
          )}
          {result?.stageChanged && (
            <span className="text-[10.5px] leading-relaxed text-muted-foreground">
              {t('edit.roster.renarrateStageChanged')}
            </span>
          )}
          {result?.saveError !== undefined && (
            <span className="text-[10.5px] leading-relaxed text-muted-foreground">
              {t('edit.roster.renarrateSaveError')}
            </span>
          )}
          {error !== null && (
            <span className="text-[10.5px] leading-relaxed text-destructive">
              {t('common.errorPrefix')}
              {error instanceof Error ? error.message : String(error)}
            </span>
          )}
          <Button type="button" variant="ghost" size="xs" onClick={reset} className="self-end">
            {t('common.close')}
          </Button>
        </div>
      )}
    </div>
  );
}
