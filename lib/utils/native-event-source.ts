/**
 * Native EventSource with the one extension the workbench needs: reconnect from
 * the cursor the UI actually applied, not the cursor the transport happened to
 * receive. Chrome's fetch-based SSE reader can leave a large backlog pending
 * indefinitely behind other requests; the native transport replays it promptly.
 */
export class NativeEventSource extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;

  readyState = NativeEventSource.CONNECTING;
  readonly url: string;

  private inner: EventSource | null = null;
  private lastEventId = '';
  private readonly forwardedTypes = new Set<string>();
  private readonly innerForwardedTypes = new Set<string>();
  private errorListenerAttached = false;
  private errorHandler: ((event: Event) => void) | null = null;

  constructor(url: string) {
    super();
    this.url = new URL(url, location.href).href;
    this.connect(this.lastEventId);
  }

  get onerror(): ((event: Event) => void) | null {
    return this.errorHandler;
  }

  set onerror(handler: ((event: Event) => void) | null) {
    if (!this.errorListenerAttached) {
      this.errorListenerAttached = true;
      this.addEventListener('error', (event) => this.errorHandler?.call(this, event));
    }
    this.errorHandler = handler;
  }

  override addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject | null,
    options?: boolean | AddEventListenerOptions,
  ): void {
    super.addEventListener(type, listener, options);
    if (type !== 'open' && type !== 'error' && type !== 'message') {
      this.forwardedTypes.add(type);
      this.forwardOnInner(type);
    }
  }

  close(): void {
    this.readyState = NativeEventSource.CLOSED;
    const inner = this.inner;
    this.inner = null;
    inner?.close();
  }

  reconnect(lastEventId?: string): void {
    if (this.readyState === NativeEventSource.CLOSED) return;
    if (lastEventId !== undefined) this.lastEventId = lastEventId;
    this.readyState = NativeEventSource.CONNECTING;
    const inner = this.inner;
    this.inner = null;
    inner?.close();
    this.connect(this.lastEventId);
  }

  private connect(lastEventId: string): void {
    const target = new URL(this.url);
    target.searchParams.set('lastEventId', lastEventId);
    const inner = new EventSource(target.href);
    this.inner = inner;
    this.innerForwardedTypes.clear();
    inner.addEventListener('open', () => {
      if (this.inner !== inner) return;
      this.readyState = NativeEventSource.OPEN;
      this.dispatchEvent(new Event('open'));
    });
    inner.addEventListener('error', () => {
      if (this.inner !== inner) return;
      this.readyState = inner.readyState;
      this.dispatchEvent(new Event('error'));
    });
    inner.addEventListener('message', (event) => this.forwardMessage('message', event));
    for (const type of this.forwardedTypes) this.forwardOnInner(type);
  }

  private forwardOnInner(type: string): void {
    const inner = this.inner;
    if (!inner || !this.forwardedTypes.has(type) || this.innerForwardedTypes.has(type)) return;
    this.innerForwardedTypes.add(type);
    inner.addEventListener(type, (event) => {
      if (this.inner !== inner) return;
      if (type === 'activity') {
        this.dispatchEvent(new Event('activity'));
        return;
      }
      this.forwardMessage(type, event);
    });
  }

  private forwardMessage(type: string, event: MessageEvent<string>): void {
    this.lastEventId = event.lastEventId || this.lastEventId;
    this.dispatchEvent(new Event('activity'));
    this.dispatchEvent(
      new MessageEvent(type, {
        data: event.data,
        lastEventId: event.lastEventId,
        origin: event.origin,
      }),
    );
  }
}
