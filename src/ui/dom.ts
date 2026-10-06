import { ICONS, type IconName } from './icons';

type Child = Node | string | number | null | undefined | false;
type Props = Record<string, unknown> & {
  class?: string;
  style?: string;
  dataset?: Record<string, string>;
};

/**
 * Minimal element factory: h('button', { class: 'x', onClick: fn, title: 't' }, 'Label').
 * `on*` props become event listeners; other props become attributes, except
 * for a few DOM properties (value, checked, disabled...).
 */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: (Child | Child[])[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') {
        el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      } else if (k === 'dataset') {
        Object.assign(el.dataset, v);
      } else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected' || k === 'indeterminate') {
        (el as unknown as Record<string, unknown>)[k] = v;
      } else {
        el.setAttribute(k === 'className' ? 'class' : k, v === true ? '' : String(v));
      }
    }
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? String(c) : c);
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function icon(name: IconName, size = 20): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('icon');
  svg.innerHTML = ICONS[name];
  return svg;
}

/** Icon button with tooltip and accessible label. */
export function iconButton(name: IconName, title: string, onClick: (e: MouseEvent) => void, extraClass = ''): HTMLButtonElement {
  const b = h('button', { class: `icon-btn ${extraClass}`.trim(), type: 'button', title, 'aria-label': title, onClick }, icon(name));
  return b;
}

export function clearChildren(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

/** True when keyboard focus is in a text field (shortcuts must not fire). */
export function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return true;
  if (el.tagName === 'INPUT') {
    const t = (el as HTMLInputElement).type;
    return t !== 'checkbox' && t !== 'radio' && t !== 'range' && t !== 'button';
  }
  return false;
}

/** Formats a shortcut for the current platform (mod → ⌘ on Apple, Ctrl elsewhere). */
export const isApple =
  typeof navigator !== 'undefined' &&
  (/Mac|iPhone|iPad|iPod/.test(navigator.platform) || (navigator.userAgent.includes('Mac') && typeof document !== 'undefined' && 'ontouchend' in document));

export function formatShortcut(s: string): string {
  if (!s) return '';
  return s
    .split('+')
    .map((p) => {
      const k = p.toLowerCase();
      if (k === 'mod') return isApple ? '⌘' : 'Ctrl';
      if (k === 'shift') return isApple ? '⇧' : 'Shift';
      if (k === 'alt') return isApple ? '⌥' : 'Alt';
      if (k === 'delete') return 'Del';
      if (k === 'escape') return 'Esc';
      return p.length === 1 ? p.toUpperCase() : p;
    })
    .join(isApple ? '' : '+');
}
