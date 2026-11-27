// @vitest-environment jsdom
/**
 * The stream hook's caught-up state machine. Before `caught_up` every frame
 * waits in the client backlog; a silent replay applies its received prefix and
 * reconnects from that applied cursor without pretending the history is done.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useWorkbenchStream } from '@/lib/workbench/use-workbench-session';
import {
  createInitialSessionState,
  useWorkbenchStore,
  type WorkbenchEvent,
} from '@/lib/workbench/session-store';
import { useQuestionAutoConfirm } from '@/lib/workbench/question-auto-confirm';
import { sessionScopedKey } from '@/lib/workbench/request-scope';

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
    this.emit('caught_up', new MessageEvent('caught_up', { data: '{"type":"caught_up"}' }));
  }

  drop(): void {
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

const event = (
  id: number,
  ts: number,
  type: string,
  data: Record<string, unknown>,
  phase: 'live' | 'backlog',
): WorkbenchEvent & { phase: string } => ({ id, ts, attempt: 1, type, data, phase });

const RUN_START = (phase: 'live' | 'backlog') =>
  event(1, 30_000, 'session_start', { prompt: 'Make a course' }, phase);
const QUESTION = (phase: 'live' | 'backlog') =>
  event(4, 31_200, 'user_question', { question: 'Build this plan?' }, phase);

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('location', { href: 'https://app.example/page' });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response('{}', { status: 404 })),
  );
  FakeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeEventSource);
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  useWorkbenchStore.setState(createInitialSessionState() as never);
  useQuestionAutoConfirm.setState({ live: [], stopped: [], autoConfirmed: [] });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** Attach the stream to a session, as the workspace does. */
async function attachStream(sessionId: string) {
  await act(async () => {
    useWorkbenchStore.setState({
      ...createInitialSessionState(),
      sessionId,
      status: 'connecting',
      replaying: true,
    } as never);
  });
  await act(async () => {
    root.render(createElement(Host, { sessionId }));
  });
  await act(async () => vi.advanceTimersByTimeAsync(0));
}

function Host({ sessionId }: { sessionId: string }) {
  useWorkbenchStream(sessionId);
  return null;
}

const foldHasQuestion = () =>
  useWorkbenchStore.getState().chat.some((node) => node.kind === 'question');
const questionLiveMarked = (sessionId: string) =>
  useQuestionAutoConfirm.getState().live.includes(sessionScopedKey(sessionId, 'e4'));
const source = () => FakeEventSource.instances.at(-1)!;

describe('a question on the live tail', () => {
  it('folds the moment the frame arrives, and is marked live for auto-confirm', async () => {
    await attachStream('s1');
    await act(async () => source().caughtUp());
    await act(async () => source().send(RUN_START('live')));
    await act(async () => source().send(QUESTION('live')));
    expect(foldHasQuestion()).toBe(true);
    expect(questionLiveMarked('s1')).toBe(true);
    expect(useWorkbenchStore.getState().replaying).toBe(false);
  });
});

describe('a question that lands before caught_up', () => {
  it('waits in the client backlog until the silent replay flushes its prefix', async () => {
    await attachStream('s1');
    await act(async () => {
      source().send(RUN_START('live'));
      source().send(QUESTION('live'));
    });
    expect(foldHasQuestion()).toBe(false);
    await act(async () => vi.advanceTimersByTimeAsync(55_000));
    expect(foldHasQuestion()).toBe(true);
    expect(source().reconnect).toHaveBeenCalledWith('4');
    expect(useWorkbenchStore.getState().replaying).toBe(true);
  });
});

describe('a question replayed over a reconnect', () => {
  it('applies at once and is history, not live', async () => {
    await attachStream('s1');
    await act(async () => source().caughtUp());
    await act(async () => source().send(RUN_START('live')));
    await act(async () => source().drop());
    await act(async () => vi.advanceTimersByTimeAsync(4_000));
    await act(async () => source().reconnect('1'));
    await act(async () => {
      source().send(QUESTION('backlog'));
      source().caughtUp();
    });
    expect(foldHasQuestion()).toBe(true);
    expect(questionLiveMarked('s1')).toBe(false);
  });
});

describe('a watchdog that fired mid-replay', () => {
  it('keeps replaying and treats later backlog as history', async () => {
    await attachStream('s1');
    await act(async () => source().send(RUN_START('backlog')));
    await act(async () => vi.advanceTimersByTimeAsync(55_000));
    expect(source().reconnect).toHaveBeenCalledWith('1');
    expect(useWorkbenchStore.getState().replaying).toBe(true);

    await act(async () => source().send(QUESTION('backlog')));
    expect(foldHasQuestion()).toBe(false);
    await act(async () => source().caughtUp());
    expect(foldHasQuestion()).toBe(true);
    expect(questionLiveMarked('s1')).toBe(false);
  });
});
