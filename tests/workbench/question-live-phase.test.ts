// @vitest-environment jsdom
/**
 * Which questions may auto-confirm: only one the server delivered as LIVE
 * (`phase: 'live'`). A question replayed on attach, or replayed again after a
 * dropped connection reconnects, is history and never starts a countdown.
 */
import { act, createElement, useLayoutEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkbenchStore } from '@/lib/workbench/session-store';
import { useWorkbenchStream } from '@/lib/workbench/use-workbench-session';
import { useQuestionAutoConfirm } from '@/lib/workbench/question-auto-confirm';
import { sessionScopedKey } from '@/lib/workbench/request-scope';
import type { WorkbenchEvent } from '@/lib/workbench/session-store';

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];

  readyState = FakeEventSource.CONNECTING;
  onerror: ((event: Event) => void) | null = null;
  readonly reconnect = vi.fn((_lastEventId?: string) => {
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

  send(event: WorkbenchEvent & { phase?: string }): void {
    this.emit(
      event.type,
      new MessageEvent(event.type, {
        data: JSON.stringify(event),
        lastEventId: String(event.id),
        origin: 'https://app.example',
      }),
    );
  }

  caughtUp(): void {
    this.emit('caught_up', new MessageEvent('caught_up', { data: '{}' }));
  }

  emitOpen(): void {
    this.readyState = FakeEventSource.OPEN;
    this.emit('open', new Event('open'));
  }

  cut(): void {
    this.readyState = FakeEventSource.CONNECTING;
    const event = new Event('error');
    this.emit('error', event);
    this.onerror?.(event);
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

const event = (
  id: number,
  type: string,
  data: Record<string, unknown>,
  phase?: 'live' | 'backlog',
): WorkbenchEvent & { phase?: string } => ({
  id,
  type,
  ts: id,
  attempt: 1,
  data,
  ...(phase ? { phase } : {}),
});
const question = (id: number, phase?: 'live' | 'backlog') =>
  event(id, 'user_question', { question: 'Build it?' }, phase);
const start = (id: number, phase: 'live' | 'backlog') => event(id, 'session_start', {}, phase);

let root: Root;

beforeEach(async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.useFakeTimers();
  useQuestionAutoConfirm.setState({ live: [], stopped: [], autoConfirmed: [] });
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { headers: { 'content-type': 'application/json' } })),
  );
  const container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root.render(createElement(Harness, { sessionId: 's' })));
});

afterEach(async () => {
  await act(async () => root.unmount());
  useWorkbenchStore.getState().detach();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const source = () => FakeEventSource.instances.at(-1)!;
const open = () => act(async () => source().emitOpen());
const send = (value: WorkbenchEvent & { phase?: string }) => act(async () => source().send(value));
const caughtUp = () => act(async () => source().caughtUp());
const cut = () => act(async () => source().cut());
const live = () => useQuestionAutoConfirm.getState().live;

describe('a question may auto-confirm only when it arrived live', () => {
  it('not when it is replayed on attach', async () => {
    await open();
    await send(question(1, 'backlog'));
    await caughtUp();
    expect(useWorkbenchStore.getState().chat.some((n) => n.kind === 'question')).toBe(true);
    expect(live()).toEqual([]);
  });

  it('yes for a new question after caught_up', async () => {
    await open();
    await send(start(1, 'backlog'));
    await caughtUp();
    await send(question(2, 'live'));
    expect(live()).toEqual([sessionScopedKey('s', 'e2')]);
  });

  it('not when a reconnect replays a pending question before its caught_up', async () => {
    await open();
    await send(start(1, 'backlog'));
    await caughtUp();
    await cut();
    await act(async () => source().reconnect('1'));
    await send(question(2, 'backlog'));
    expect(useWorkbenchStore.getState().chat.some((n) => n.kind === 'question')).toBe(true);
    expect(live()).toEqual([]);
    await caughtUp();
    expect(live()).toEqual([]);
  });

  it('not for a frame without the server marker', async () => {
    await open();
    await send(start(1, 'backlog'));
    await caughtUp();
    await send(question(2));
    expect(live()).toEqual([]);
  });

  const leave = (detach: boolean) =>
    act(async () => {
      root.render(null);
      if (detach) useWorkbenchStore.getState().detach();
      await vi.advanceTimersByTimeAsync(0);
    });
  const comeBack = () =>
    act(async () => {
      root.render(createElement(Harness, { sessionId: 's' }));
      await vi.advanceTimersByTimeAsync(0);
    });

  it.each([
    ['kept in memory', false],
    ['replayed from scratch', true],
  ])('not when the same session is left unanswered and opened again (%s)', async (_how, detach) => {
    await open();
    await send(start(1, 'backlog'));
    await caughtUp();
    await send(question(2, 'live'));
    expect(live()).toEqual([sessionScopedKey('s', 'e2')]);
    await leave(detach);
    expect(live()).toEqual([]);
    await comeBack();
    await open();
    if (detach) {
      await send(start(1, 'backlog'));
      await send(question(2, 'backlog'));
    }
    await caughtUp();
    expect(
      useWorkbenchStore.getState().chat.some((n) => n.kind === 'question' && !n.questionAnswered),
    ).toBe(true);
    expect(live()).toEqual([]);
  });

  it('yes for a question asked live after coming back', async () => {
    await open();
    await send(start(1, 'backlog'));
    await caughtUp();
    await send(question(2, 'live'));
    await leave(false);
    await comeBack();
    await open();
    await caughtUp();
    await send(question(3, 'live'));
    expect(live()).toEqual([sessionScopedKey('s', 'e3')]);
  });
});
