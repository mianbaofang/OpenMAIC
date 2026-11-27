import { describe, expect, it } from 'vitest';

import {
  createInitialSessionState,
  foldEvent,
  reconcileTerminalSessionStatus,
} from '@/lib/workbench/session-store';

const cause = 'model output hit the max token limit and was truncated; this run did not finish';

function queuedState() {
  return {
    ...createInitialSessionState(),
    sessionId: 'session-1',
    status: 'queued' as const,
    lastEventId: 4,
    waitingKey: 'waiting-1',
    chat: [{ key: 'waiting-1', kind: 'waiting' as const, text: '', startedAt: 1 }],
  };
}

describe('terminal session status reconciliation', () => {
  it('replaces a stale queued fold with the failed status and one error notice', () => {
    const next = reconcileTerminalSessionStatus(queuedState(), {
      status: 'failed',
      error: cause,
      updatedAt: 100,
    });

    expect(next.status).toBe('failed');
    expect(next.lastEventId).toBe(4);
    expect(next.waitingKey).toBeNull();
    expect(next.chat.filter((node) => node.kind === 'waiting')).toHaveLength(0);
    expect(
      next.chat.filter((node) => node.kind === 'system' && node.tone === 'error'),
    ).toHaveLength(1);
    expect(next.chat.find((node) => node.kind === 'system' && node.tone === 'error')?.detail).toBe(
      cause,
    );
  });

  it('does not duplicate the failure when the durable session_end arrives later', () => {
    const reconciled = reconcileTerminalSessionStatus(queuedState(), {
      status: 'failed',
      error: cause,
      updatedAt: 100,
    });
    const next = foldEvent(reconciled, {
      id: 5,
      ts: 101,
      attempt: 1,
      type: 'session_end',
      data: { status: 'failed', error: cause },
    });

    expect(next.lastEventId).toBe(5);
    expect(
      next.chat.filter((node) => node.kind === 'system' && node.tone === 'error'),
    ).toHaveLength(1);
  });

  it('fills in the durable cause without duplicating a REST notice that had no error', () => {
    const reconciled = reconcileTerminalSessionStatus(queuedState(), {
      status: 'failed',
      updatedAt: 100,
    });
    const next = foldEvent(reconciled, {
      id: 5,
      ts: 101,
      attempt: 1,
      type: 'session_end',
      data: { status: 'failed', error: cause },
    });

    const errors = next.chat.filter((node) => node.kind === 'system' && node.tone === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.detail).toBe(cause);
  });

  it('keeps one failure notice when REST and SSE error text differ', () => {
    const reconciled = reconcileTerminalSessionStatus(queuedState(), {
      status: 'failed',
      error: 'REST summary',
      updatedAt: 100,
    });
    const next = foldEvent(reconciled, {
      id: 5,
      ts: 101,
      attempt: 1,
      type: 'session_end',
      data: { status: 'failed', error: cause },
    });

    const errors = next.chat.filter((node) => node.kind === 'system' && node.tone === 'error');
    expect(errors).toHaveLength(1);
    expect(errors[0]?.detail).toBe('REST summary');
  });

  it('does not let an earlier run failure hide a later follow-up failure', () => {
    let next = reconcileTerminalSessionStatus(queuedState(), {
      status: 'failed',
      error: 'first run failed',
      updatedAt: 100,
    });
    next = foldEvent(next, {
      id: 5,
      ts: 102,
      attempt: 2,
      type: 'user_message',
      data: { text: 'try again', delivery: 'queued' },
    });
    next = foldEvent(next, {
      id: 6,
      ts: 103,
      attempt: 2,
      type: 'session_resumed',
      data: { reason: 'follow_up' },
    });
    next = foldEvent(next, {
      id: 7,
      ts: 104,
      attempt: 2,
      type: 'session_end',
      data: { status: 'failed', error: 'second run failed' },
    });

    expect(
      next.chat.filter((node) => node.kind === 'system' && node.tone === 'error'),
    ).toHaveLength(2);
  });

  it('is idempotent after the first terminal reconciliation', () => {
    const reconciled = reconcileTerminalSessionStatus(queuedState(), {
      status: 'failed',
      error: cause,
      updatedAt: 100,
    });
    expect(
      reconcileTerminalSessionStatus(reconciled, {
        status: 'failed',
        error: cause,
        updatedAt: 100,
      }),
    ).toBe(reconciled);
  });

  it('unlocks a succeeded run without inventing an error notice', () => {
    const next = reconcileTerminalSessionStatus(queuedState(), {
      status: 'succeeded',
      updatedAt: 100,
    });
    expect(next.status).toBe('succeeded');
    expect(next.lastEventId).toBe(4);
    expect(next.chat.some((node) => node.kind === 'system' && node.tone === 'error')).toBe(false);
  });
});
