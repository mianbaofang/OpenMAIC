import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class FakeNativeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeNativeEventSource[] = [];

  readyState = 0;
  readonly close = vi.fn(() => {
    this.readyState = FakeNativeEventSource.CLOSED;
  });
  private readonly listeners = new Map<string, Set<(event: Event) => void>>();

  constructor(readonly url: string) {
    FakeNativeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  emit(type: string, event: Event): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }

  open(): void {
    this.readyState = FakeNativeEventSource.OPEN;
    this.emit('open', new Event('open'));
  }

  message(type: string, data: string, lastEventId: string): void {
    this.emit(type, new MessageEvent(type, { data, lastEventId, origin: 'https://app.example' }));
  }
}

const actual = await vi.importActual<typeof import('@/lib/utils/native-event-source')>(
  '@/lib/utils/native-event-source',
);
const NativeEventSource = actual.NativeEventSource;

beforeEach(() => {
  FakeNativeEventSource.instances = [];
  vi.stubGlobal('EventSource', FakeNativeEventSource);
  vi.stubGlobal('location', { href: 'https://app.example/workspace' });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('NativeEventSource', () => {
  it('forwards named frames and records transport activity', () => {
    const source = new NativeEventSource('/events?lastEventId=0');
    const seen: MessageEvent<string>[] = [];
    let activity = 0;
    source.addEventListener('user_message', (event) => seen.push(event as MessageEvent<string>));
    source.addEventListener('activity', () => {
      activity += 1;
    });

    FakeNativeEventSource.instances[0]!.open();
    FakeNativeEventSource.instances[0]!.message('user_message', '{"text":"hello"}', '7');

    expect(source.readyState).toBe(NativeEventSource.OPEN);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ data: '{"text":"hello"}', lastEventId: '7' });
    expect(activity).toBe(1);
    source.close();
  });

  it('treats the server heartbeat as activity without painting a product frame', () => {
    const source = new NativeEventSource('/events');
    let activity = 0;
    let messages = 0;
    source.addEventListener('activity', () => {
      activity += 1;
    });
    source.addEventListener('message', () => {
      messages += 1;
    });

    FakeNativeEventSource.instances[0]!.message('activity', '{}', '');
    expect(activity).toBe(1);
    expect(messages).toBe(0);
    source.close();
  });

  it('reconnects from the supplied applied cursor and keeps named listeners', () => {
    const source = new NativeEventSource('/events?lastEventId=0');
    const seen: string[] = [];
    source.addEventListener('caught_up', (event) => seen.push((event as MessageEvent).data));
    source.addEventListener('activity', () => {});

    FakeNativeEventSource.instances[0]!.message('user_message', '{}', '99');
    source.reconnect('42');

    expect(FakeNativeEventSource.instances[0]!.close).toHaveBeenCalledOnce();
    expect(FakeNativeEventSource.instances).toHaveLength(2);
    expect(FakeNativeEventSource.instances[1]!.url).toBe(
      'https://app.example/events?lastEventId=42',
    );
    FakeNativeEventSource.instances[1]!.message('caught_up', '{"replayed":1}', '42');
    expect(seen).toEqual(['{"replayed":1}']);
    source.close();
  });

  it('forwards errors to the assigned handler and stays closed after close', () => {
    const source = new NativeEventSource('/events');
    const onerror = vi.fn();
    source.onerror = onerror;
    FakeNativeEventSource.instances[0]!.emit('error', new Event('error'));
    expect(onerror).toHaveBeenCalledOnce();

    source.close();
    source.reconnect('5');
    expect(FakeNativeEventSource.instances).toHaveLength(1);
    expect(source.readyState).toBe(NativeEventSource.CLOSED);
  });
});
