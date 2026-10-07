import { toCss } from '../core/color';
import type { Editor } from '../editor';
import type { ToolId } from '../tools/tool';
import { h, icon } from './dom';
import type { IconName } from './icons';
import { popupMenu } from './menu';

interface Slot {
  /** Tools sharing this button (first = default). */
  tools: ToolId[];
}

const DESKTOP_GROUPS: ToolId[][] = [
  ['brush', 'pencil', 'eraser', 'shade'],
  ['line', 'rect', 'ellipse'],
  ['fill', 'gradient', 'picker'],
  ['select-rect', 'select-ellipse', 'lasso', 'wand'],
  ['move', 'hand'],
];

const MOBILE_SLOTS: Slot[] = [
  { tools: ['brush'] },
  { tools: ['pencil', 'shade'] },
  { tools: ['eraser'] },
  { tools: ['fill', 'gradient'] },
  { tools: ['picker'] },
  { tools: ['line', 'rect', 'ellipse'] },
  { tools: ['select-rect', 'select-ellipse', 'lasso', 'wand'] },
  { tools: ['move'] },
];

/**
 * Tool buttons. Desktop: a compact vertical column with every tool.
 * Mobile: a bottom bar where related tools share one slot (tap an active
 * slot to switch within its group) plus the color swatch.
 */
export class Toolbar {
  readonly el = h('div', { class: 'toolbar', role: 'toolbar', 'aria-label': 'Tools' });
  private readonly editor: Editor;
  private mobile = false;
  private lastInGroup = new Map<number, ToolId>();
  private swatch: HTMLElement;
  onColorClick: (anchor: HTMLElement) => void = () => {};
  onToolReselect: (id: ToolId) => void = () => {};

  constructor(editor: Editor) {
    this.editor = editor;
    this.swatch = this.buildSwatch();
    editor.on('tool', () => this.update());
    editor.on('colors', () => this.updateSwatch());
    this.render();
  }

  setMobile(mobile: boolean): void {
    if (mobile === this.mobile) return;
    this.mobile = mobile;
    this.render();
  }

  private buildSwatch(): HTMLElement {
    const fg = h('span', { class: 'sw fg' });
    const bg = h('span', { class: 'sw bg' });
    const b = h('button', { type: 'button', class: 'color-swatch-btn', title: 'Colors (X swaps, D resets)', 'aria-label': 'Colors' }, bg, fg);
    b.addEventListener('click', () => this.onColorClick(b));
    return b;
  }

  private updateSwatch(): void {
    const fg = this.swatch.querySelector<HTMLElement>('.fg')!;
    const bg = this.swatch.querySelector<HTMLElement>('.bg')!;
    fg.style.setProperty('--c', toCss(this.editor.fg));
    bg.style.setProperty('--c', toCss(this.editor.bg));
  }

  private toolButton(id: ToolId, slotTools?: ToolId[], slotIndex?: number): HTMLButtonElement {
    const t = this.editor.tools[id];
    const title = t.shortcut ? `${t.label} (${t.shortcut})` : t.label;
    const b = h(
      'button',
      { type: 'button', class: 'tool-btn', title, 'aria-label': t.label, dataset: { tool: id } },
      icon(id as IconName),
      slotTools && slotTools.length > 1 ? h('span', { class: 'group-mark', 'aria-hidden': 'true' }) : null,
    );
    b.addEventListener('click', () => {
      const current = this.editor.tool.id;
      if (slotTools && slotTools.length > 1) {
        if (slotTools.includes(current)) {
          // Active group: offer the other tools of the group.
          popupMenu(
            b,
            slotTools.map((tid) => ({
              label: this.editor.tools[tid].label,
              checked: tid === current,
              run: () => {
                this.lastInGroup.set(slotIndex!, tid);
                this.editor.setTool(tid);
                this.onToolReselect(tid);
              },
            })),
          );
          return;
        }
        this.editor.setTool(this.lastInGroup.get(slotIndex!) ?? slotTools[0]);
        return;
      }
      if (current === id) this.onToolReselect(id);
      else this.editor.setTool(id);
    });
    return b;
  }

  private render(): void {
    this.el.replaceChildren();
    this.el.classList.toggle('mobile', this.mobile);
    if (this.mobile) {
      const strip = h('div', { class: 'tool-strip' });
      MOBILE_SLOTS.forEach((slot, i) => strip.append(this.toolButton(slot.tools[0], slot.tools, i)));
      this.el.append(strip, this.swatch);
    } else {
      DESKTOP_GROUPS.forEach((group, gi) => {
        if (gi) this.el.append(h('div', { class: 'tool-sep' }));
        for (const id of group) this.el.append(this.toolButton(id));
      });
      this.el.append(h('div', { class: 'tool-spacer' }), this.swatch);
    }
    this.update();
    this.updateSwatch();
  }

  private update(): void {
    const current = this.editor.tool.id;
    if (this.mobile) {
      this.el.querySelectorAll<HTMLButtonElement>('.tool-btn').forEach((b, i) => {
        const slot = MOBILE_SLOTS[i];
        const active = slot.tools.includes(current);
        if (active && slot.tools.length > 1) {
          this.lastInGroup.set(i, current);
          b.dataset.tool = current;
          b.querySelector('svg')?.replaceWith(icon(current as IconName));
          b.title = this.editor.tools[current].label;
        }
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
    } else {
      this.el.querySelectorAll<HTMLButtonElement>('.tool-btn').forEach((b) => {
        const active = b.dataset.tool === current;
        b.classList.toggle('active', active);
        b.setAttribute('aria-pressed', String(active));
      });
    }
  }
}
