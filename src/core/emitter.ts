/** Minimal typed event emitter. Handlers are called synchronously in subscription order. */
export class Emitter<Events extends object> {
  private handlers = new Map<keyof Events, Set<(payload: never) => void>>();

  on<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): () => void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(fn as (payload: never) => void);
    return () => this.off(type, fn);
  }

  off<K extends keyof Events>(type: K, fn: (payload: Events[K]) => void): void {
    this.handlers.get(type)?.delete(fn as (payload: never) => void);
  }

  emit<K extends keyof Events>(type: K, ...payload: Events[K] extends void ? [] : [Events[K]]): void {
    const set = this.handlers.get(type);
    if (!set) return;
    for (const fn of [...set]) (fn as (p: unknown) => void)(payload[0]);
  }
}
