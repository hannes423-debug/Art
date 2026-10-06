import { h } from './dom';

/** Small transient notifications, non-blocking and screen-reader friendly. */
export class Toasts {
  readonly el = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
  private last = '';
  private lastTime = 0;

  show(message: string, error = false, duration = 2600): void {
    const now = Date.now();
    if (message === this.last && now - this.lastTime < 1500) return;
    this.last = message;
    this.lastTime = now;
    const t = h('div', { class: `toast ${error ? 'error' : ''}`.trim() }, message);
    this.el.append(t);
    while (this.el.children.length > 3) this.el.firstElementChild?.remove();
    requestAnimationFrame(() => t.classList.add('show'));
    setTimeout(
      () => {
        t.classList.remove('show');
        setTimeout(() => t.remove(), 300);
      },
      error ? duration * 2 : duration,
    );
  }
}
