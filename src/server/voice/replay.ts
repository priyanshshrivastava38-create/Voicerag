// Buffers an async stream so it can start before its consumer exists (speculative generation)
// and be consumed later from the beginning. Errors and completion are replayed too.
export class ReplayStream<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private done = false;
  private error: unknown = null;
  private waiters: (() => void)[] = [];

  constructor(src: AsyncIterable<T>) {
    void this.pump(src);
  }

  private async pump(src: AsyncIterable<T>) {
    try {
      for await (const x of src) {
        this.items.push(x);
        this.wake();
      }
    } catch (e) {
      this.error = e;
    } finally {
      this.done = true;
      this.wake();
    }
  }

  private wake() {
    this.waiters.splice(0).forEach((w) => w());
  }

  get buffered() {
    return this.items.length;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    let i = 0;
    for (;;) {
      if (i < this.items.length) {
        yield this.items[i++];
        continue;
      }
      if (this.done) {
        if (this.error) throw this.error;
        return;
      }
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}
