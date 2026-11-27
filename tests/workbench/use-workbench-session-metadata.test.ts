// @vitest-environment jsdom

import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { useWorkbenchStream } from '@/lib/workbench/use-workbench-session';

class FakeEventSource {
  static readonly CLOSED = 2;
  readonly readyState = 1;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {}

  addEventListener(): void {}
  removeEventListener(): void {}
  close(): void {}
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function jsonResponse(value: unknown): Response {
  return { ok: true, json: async () => value } as Response;
}

function Harness({
  sessionId,
  seedTitle,
}: {
  readonly sessionId: string;
  readonly seedTitle?: { readonly title: string | null };
}) {
  const attach = useWorkbenchStore((state) => state.attach);
  const setSessionTitle = useWorkbenchStore((state) => state.setSessionTitle);
  useLayoutEffect(() => {
    attach(sessionId, null);
    if (seedTitle) setSessionTitle(seedTitle.title);
  }, [attach, seedTitle, sessionId, setSessionTitle]);
  useWorkbenchStream(sessionId);
  return null;
}

describe('session detail bootstrap attachment lifetime', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    vi.stubGlobal('EventSource', FakeEventSource);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    useWorkbenchStore.getState().detach();
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('ignores an old A detail response after navigating A to B to A', async () => {
    const firstA = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockReturnValueOnce(firstA.promise)
      .mockResolvedValueOnce(
        jsonResponse({
          prompt: 'B prompt',
          title: 'B title',
          status: 'running',
          stageId: 'stage-b',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          prompt: 'Current A prompt',
          title: 'Current A title',
          status: 'succeeded',
          stageId: 'stage-a-current',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(createElement(Harness, { sessionId: 'session-a' })));
    await act(async () => root.render(createElement(Harness, { sessionId: 'session-b' })));
    await act(async () => root.render(createElement(Harness, { sessionId: 'session-a' })));

    expect(useWorkbenchStore.getState()).toMatchObject({
      sessionId: 'session-a',
      sessionPrompt: 'Current A prompt',
      sessionTitle: 'Current A title',
      status: 'succeeded',
      stageId: 'stage-a-current',
    });

    await act(async () => {
      firstA.resolve(
        jsonResponse({
          prompt: 'Stale A prompt',
          title: 'Stale A title',
          status: 'failed',
          stageId: 'stage-a-stale',
        }),
      );
      await firstA.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useWorkbenchStore.getState()).toMatchObject({
      sessionId: 'session-a',
      sessionPrompt: 'Current A prompt',
      sessionTitle: 'Current A title',
      status: 'succeeded',
      stageId: 'stage-a-current',
    });
  });

  it('keeps an authoritative clear made while the detail request is in flight', async () => {
    const detail = deferred<Response>();
    vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValueOnce(detail.promise));

    await act(async () => root.render(createElement(Harness, { sessionId: 'session-a' })));
    act(() => useWorkbenchStore.getState().setSessionTitle(null));
    await act(async () => {
      detail.resolve(
        jsonResponse({
          prompt: 'Current prompt',
          title: 'Stale title',
          status: 'running',
          stageId: 'stage-a',
        }),
      );
      await detail.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useWorkbenchStore.getState()).toMatchObject({
      sessionPrompt: 'Current prompt',
      sessionTitle: null,
      status: 'running',
      stageId: 'stage-a',
    });
  });

  it.each([
    { name: 'rename', title: 'Pending title' },
    { name: 'clear', title: null },
  ])(
    'keeps a pending $name seeded before the detail request while bootstrapping other metadata',
    async ({ title }) => {
      const detail = deferred<Response>();
      vi.stubGlobal('fetch', vi.fn<typeof fetch>().mockReturnValueOnce(detail.promise));

      await act(async () =>
        root.render(
          createElement(Harness, {
            sessionId: 'session-a',
            seedTitle: { title },
          }),
        ),
      );
      expect(useWorkbenchStore.getState().sessionTitleRevision).toBe(1);

      await act(async () => {
        detail.resolve(
          jsonResponse({
            prompt: 'Current prompt',
            title: 'Old title',
            status: 'running',
            stageId: 'stage-a',
          }),
        );
        await detail.promise;
        await Promise.resolve();
        await Promise.resolve();
      });

      expect(useWorkbenchStore.getState()).toMatchObject({
        sessionId: 'session-a',
        sessionPrompt: 'Current prompt',
        sessionTitle: title,
        status: 'running',
        stageId: 'stage-a',
      });
    },
  );

  it('re-arms status polling for a follow-up run in the same attached session', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          prompt: 'Current prompt',
          title: 'Current title',
          status: 'running',
          stageId: 'stage-a',
          updatedAt: 100,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'failed',
          updatedAt: 101,
          error: 'first run failed',
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          status: 'failed',
          updatedAt: 202,
          error: 'second run failed',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(createElement(Harness, { sessionId: 'session-a' })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(useWorkbenchStore.getState().status).toBe('failed');

    act(() =>
      useWorkbenchStore.getState().applyEvent({
        id: 1,
        ts: 102,
        attempt: 2,
        type: 'session_resumed',
        data: { reason: 'follow_up' },
      }),
    );
    expect(useWorkbenchStore.getState().status).toBe('running');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(useWorkbenchStore.getState().status).toBe('failed');
    expect(
      useWorkbenchStore
        .getState()
        .chat.some((node) => node.kind === 'system' && node.detail === 'second run failed'),
    ).toBe(true);
  });

  it('ignores a terminal REST response that arrives after a newer run resumes', async () => {
    vi.useFakeTimers();
    const terminal = deferred<Response>();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          prompt: 'Current prompt',
          title: 'Current title',
          status: 'running',
          stageId: 'stage-a',
          updatedAt: 100,
        }),
      )
      .mockReturnValueOnce(terminal.promise);
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(createElement(Harness, { sessionId: 'session-a' })));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    act(() =>
      useWorkbenchStore.getState().applyEvent({
        id: 1,
        ts: 102,
        attempt: 2,
        type: 'session_resumed',
        data: { reason: 'follow_up' },
      }),
    );
    await act(async () => {
      terminal.resolve(
        jsonResponse({
          status: 'failed',
          updatedAt: 101,
          error: 'stale terminal status',
        }),
      );
      await terminal.promise;
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(useWorkbenchStore.getState().status).toBe('running');
    expect(
      useWorkbenchStore
        .getState()
        .chat.some((node) => node.kind === 'system' && node.detail === 'stale terminal status'),
    ).toBe(false);
  });

  it('reconciles a terminal status when the event stream stays silent', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          prompt: 'Current prompt',
          title: 'Current title',
          status: 'running',
          stageId: 'stage-a',
          updatedAt: 100,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          prompt: 'Current prompt',
          title: 'Current title',
          status: 'failed',
          stageId: 'stage-a',
          updatedAt: 101,
          error: 'model output hit the max token limit and was truncated; this run did not finish',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    await act(async () => root.render(createElement(Harness, { sessionId: 'session-a' })));
    expect(useWorkbenchStore.getState().status).toBe('running');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8_000);
    });

    expect(useWorkbenchStore.getState().status).toBe('failed');
    expect(
      useWorkbenchStore
        .getState()
        .chat.some(
          (node) =>
            node.kind === 'system' &&
            node.tone === 'error' &&
            node.detail?.includes('max token limit'),
        ),
    ).toBe(true);
  });
});
