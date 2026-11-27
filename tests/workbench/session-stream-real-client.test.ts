// @vitest-environment jsdom
/**
 * `useWorkbenchStream` replay scheduling with the native transport held the way
 * the browser can hold an open connection before its backlog arrives.
 */
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { useWorkbenchStream } from '@/lib/workbench/use-workbench-session';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onerror: ((event: Event) => void) | null = null;
  readonly reconnect = vi.fn(() => {
    this.readyState = FakeEventSource.CONNECTING;
  });
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  open(): void {
    this.readyState = FakeEventSource.OPEN;
    this.emit('open', new Event('open'));
  }

  error(): void {
    this.readyState = FakeEventSource.CONNECTING;
    this.emit('error', new Event('error'));
    this.onerror?.(new Event('error'));
  }

  event(id: number, type: string, data: unknown): void {
    this.emit(
      type,
      new MessageEvent(type, {
        data: JSON.stringify({ id, seq: id, type, data, ts: id, sessionId: 's' }),
        lastEventId: String(id),
        origin: 'http://localhost',
      }),
    );
  }

  caughtUp(): void {
    this.emit('caught_up', new MessageEvent('caught_up', { data: '{}' }));
  }

  private emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  close(): void {
    this.readyState = FakeEventSource.CLOSED;
  }
}

function Harness({ sessionId }: { sessionId: string }) {
  const attach = useWorkbenchStore((state) => state.attach);
  useLayoutEffect(() => {
    attach(sessionId, null);
  }, [attach, sessionId]);
  useWorkbenchStream(sessionId);
  return null;
}

let root: Root;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  FakeEventSource.instances = [];
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
  vi.stubGlobal('EventSource', FakeEventSource);
  await act(async () => root.render(createElement(Harness, { sessionId: 's' })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  useWorkbenchStore.getState().detach();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
const open = () =>
  act(async () => {
    FakeEventSource.instances.at(-1)!.open();
  });
const send = (id: number, type: string, data: unknown) =>
  act(async () => {
    FakeEventSource.instances.at(-1)!.event(id, type, data);
  });
const caughtUp = () =>
  act(async () => {
    FakeEventSource.instances.at(-1)!.caughtUp();
  });
const store = () => useWorkbenchStore.getState();

describe('replay on a stream the browser holds back', () => {
  it.each([1_000, 20_001, 60_000, 119_000])(
    'an old course link stays history when the request waits %i ms',
    async (heldMs) => {
      await advance(heldMs);
      expect(store().replaying).toBe(true);
      await open();
      await send(1, 'stage_link', { stageId: 'old-course' });
      await caughtUp();
      expect(store().stageLinkStageIds).toEqual(['old-course']);
      expect(store().replayedStageLinkCount).toBe(1);
      expect(store().replaying).toBe(false);
      expect(store().attached).toBe(true);
    },
  );

  it('an old course link stays history when the reconnect waits in the queue', async () => {
    await open();
    await send(1, 'session_start', {});
    await act(async () => {
      FakeEventSource.instances.at(-1)!.error();
      await vi.advanceTimersByTimeAsync(0);
    });
    await advance(30_000);
    expect(store().replaying).toBe(true);
    await open();
    await send(2, 'stage_link', { stageId: 'old-course' });
    await caughtUp();
    expect(store().replayedStageLinkCount).toBe(1);
  });

  it('an old course link stays history while a slow replay is still arriving', async () => {
    await open();
    for (let id = 1; id <= 25; id++) {
      await send(id, 'session_start', {});
      await advance(999);
    }
    expect(store().replaying).toBe(true);
    await send(30, 'stage_link', { stageId: 'old-course' });
    await caughtUp();
    expect(store().replayedStageLinkCount).toBe(1);
  });

  it('reconnects 55 s after the last replay frame instead of finishing', async () => {
    await open();
    await advance(15_000);
    await send(1, 'session_start', {});
    await advance(54_998);
    expect(store().replaying).toBe(true);
    await advance(2);
    expect(FakeEventSource.instances.at(-1)!.reconnect).toHaveBeenCalledWith('1');
    expect(store().replaying).toBe(true);
  });

  it('keeps recovering instead of ending a replay that repeatedly drops', async () => {
    await open();
    for (let elapsed = 0; elapsed < 120_000; elapsed += 10_000) {
      await act(async () => {
        FakeEventSource.instances.at(-1)!.error();
        await vi.advanceTimersByTimeAsync(0);
      });
      await advance(4_000);
      await open();
      await advance(6_000);
    }
    expect(store().replaying).toBe(true);
    expect(FakeEventSource.instances.at(-1)!.reconnect).toHaveBeenCalled();
  });

  it('reconnects an open stream that never sends caught_up', async () => {
    await advance(30_000);
    await open();
    await advance(54_999);
    expect(store().replaying).toBe(true);
    await advance(1);
    expect(FakeEventSource.instances.at(-1)!.reconnect).toHaveBeenCalledWith('0');
    expect(store().replaying).toBe(true);
  });

  it('recovers a stream that never opens instead of declaring an empty replay finished', async () => {
    await advance(119_999);
    expect(store().replaying).toBe(true);
    await advance(1);
    expect(FakeEventSource.instances.at(-1)!.reconnect).toHaveBeenCalledWith('0');
    expect(store().replaying).toBe(true);
  });
});
