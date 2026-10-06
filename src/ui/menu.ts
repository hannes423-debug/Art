import type { Action, ActionRegistry, MenuDef } from '../actions';
import { formatShortcut, h, icon } from './dom';

export interface PopupItem {
  label: string;
  run: () => void;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
  shortcut?: string;
}

let activePopup: { el: HTMLElement; close: () => void } | null = null;

export function closePopup(): void {
  activePopup?.close();
}

/** Shows a popup menu anchored to an element (or a point). */
export function popupMenu(anchor: HTMLElement | { x: number; y: number }, items: (PopupItem | '-')[], className = ''): void {
  closePopup();
  const list = h('div', { class: `popup-menu ${className}`.trim(), role: 'menu' });
  for (const it of items) {
    if (it === '-') {
      list.append(h('div', { class: 'menu-sep', role: 'separator' }));
      continue;
    }
    const b = h(
      'button',
      { type: 'button', class: `menu-item ${it.danger ? 'danger' : ''}`.trim(), role: 'menuitem', disabled: it.disabled },
      h('span', { class: 'menu-check' }, it.checked ? icon('check', 14) : null),
      h('span', { class: 'menu-label' }, it.label),
      h('span', { class: 'menu-shortcut' }, it.shortcut ? formatShortcut(it.shortcut) : ''),
    );
    b.addEventListener('click', () => {
      closePopup();
      it.run();
    });
    list.append(b);
  }
  document.body.append(list);
  // Position within the viewport.
  const r = anchor instanceof HTMLElement ? anchor.getBoundingClientRect() : { left: anchor.x, right: anchor.x, top: anchor.y, bottom: anchor.y };
  const mw = list.offsetWidth;
  const mh = list.offsetHeight;
  let x = r.left;
  let y = r.bottom + 2;
  if (x + mw > innerWidth - 4) x = Math.max(4, innerWidth - mw - 4);
  if (y + mh > innerHeight - 4) y = Math.max(4, r.top - mh - 2);
  list.style.left = `${x}px`;
  list.style.top = `${y}px`;
  const onDown = (e: PointerEvent) => {
    if (!list.contains(e.target as Node) && !(anchor instanceof HTMLElement && anchor.contains(e.target as Node))) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    }
  };
  const close = () => {
    list.remove();
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    if (activePopup?.el === list) activePopup = null;
  };
  setTimeout(() => document.addEventListener('pointerdown', onDown, true));
  document.addEventListener('keydown', onKey, true);
  activePopup = { el: list, close };
  (list.querySelector('button:not(:disabled)') as HTMLElement | null)?.focus({ preventScroll: true });
}

function actionItem(a: Action): PopupItem {
  return {
    label: a.label,
    run: () => void a.run(),
    checked: a.checked?.(),
    disabled: a.enabled ? !a.enabled() : false,
    shortcut: a.keys?.[0],
  };
}

export function menuItems(registry: ActionRegistry, ids: string[]): (PopupItem | '-')[] {
  const out: (PopupItem | '-')[] = [];
  for (const id of ids) {
    if (id === '-') {
      if (out.length && out[out.length - 1] !== '-') out.push('-');
      continue;
    }
    const a = registry.get(id);
    if (!a || (a.available && !a.available())) continue;
    out.push(actionItem(a));
  }
  while (out[out.length - 1] === '-') out.pop();
  return out;
}

/** Classic desktop menu bar: click opens, hovering moves between open menus. */
export function menuBar(registry: ActionRegistry, menus: MenuDef[]): HTMLElement {
  const bar = h('nav', { class: 'menubar', 'aria-label': 'Main menu' });
  let openId: string | null = null;
  const open = (m: MenuDef, btn: HTMLElement) => {
    openId = m.id;
    bar.querySelectorAll('.menubar-btn').forEach((b) => b.classList.toggle('open', b === btn));
    popupMenu(btn, menuItems(registry, m.items), 'menubar-popup');
    const watch = () => {
      if (!document.querySelector('.menubar-popup')) {
        openId = null;
        bar.querySelectorAll('.menubar-btn').forEach((b) => b.classList.remove('open'));
      } else requestAnimationFrame(watch);
    };
    requestAnimationFrame(watch);
  };
  for (const m of menus) {
    const btn = h('button', { type: 'button', class: 'menubar-btn' }, m.label);
    btn.addEventListener('click', () => {
      if (openId === m.id) closePopup();
      else open(m, btn);
    });
    btn.addEventListener('pointerenter', () => {
      if (openId && openId !== m.id) open(m, btn);
    });
    bar.append(btn);
  }
  return bar;
}

/** Mobile menu: grouped, full-width rows inside a drawer. */
export function mobileMenu(registry: ActionRegistry, menus: MenuDef[], onRun: () => void): HTMLElement {
  const root = h('div', { class: 'mobile-menu' });
  const render = () => {
    root.replaceChildren();
    for (const m of menus) {
      const items = menuItems(registry, m.items);
      if (!items.length) continue;
      const section = h('details', { class: 'mm-section', open: m.id === 'file' }, h('summary', null, m.label));
      for (const it of items) {
        if (it === '-') {
          section.append(h('div', { class: 'menu-sep' }));
          continue;
        }
        const b = h(
          'button',
          { type: 'button', class: 'mm-item', disabled: it.disabled },
          h('span', { class: 'menu-check' }, it.checked ? icon('check', 16) : null),
          h('span', { class: 'menu-label' }, it.label),
        );
        b.addEventListener('click', () => {
          onRun();
          it.run();
        });
        section.append(b);
      }
      root.append(section);
    }
  };
  render();
  (root as HTMLElement & { refresh?: () => void }).refresh = render;
  return root;
}
