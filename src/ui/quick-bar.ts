import type { Editor } from '../editor';
import type { OptionSpec } from '../tools/tool';
import { h } from './dom';
import { fmt, fromPos, toPos } from './options-bar';

type SliderSpec = Extract<OptionSpec, { type: 'slider' }>;

/**
 * Vertical size and opacity sliders (plus undo/redo) floating on the edge
 * of the canvas, within thumb or off-hand reach on tablets. They follow
 * the active tool's own size/opacity options.
 */
export class QuickBar {
  readonly el = h('div', { class: 'quickbar', role: 'group', 'aria-label': 'Quick sliders' });
  private readonly editor: Editor;
  private readonly sliders: { key: 'size' | 'opacity'; wrap: HTMLElement; input: HTMLInputElement; value: HTMLElement; spec: SliderSpec | null }[];
  private dragging = false;

  constructor(editor: Editor, undo: HTMLElement, redo: HTMLElement) {
    this.editor = editor;
    this.sliders = (['size', 'opacity'] as const).map((key) => {
      const input = h('input', {
        type: 'range',
        min: '0',
        max: '1000',
        step: '1',
        class: 'quick-range',
        'aria-label': key === 'size' ? 'Brush size' : 'Opacity',
      });
      const value = h('span', { class: 'quick-value' });
      const wrap = h('label', { class: `quick-slider quick-${key}`, title: key === 'size' ? 'Size' : 'Opacity' }, value, input);
      return { key, wrap, input, value, spec: null };
    });
    for (const s of this.sliders) {
      s.input.addEventListener('pointerdown', () => (this.dragging = true));
      s.input.addEventListener('pointerup', () => (this.dragging = false));
      s.input.addEventListener('change', () => (this.dragging = false));
      s.input.addEventListener('input', () => {
        const tool = this.editor.tool;
        if (!s.spec) return;
        const v = fromPos(s.spec, Number(s.input.value));
        this.editor.setOption(tool.optionsKey, s.spec.key, v);
        s.value.textContent = fmt(s.spec, v);
      });
    }
    this.el.append(...this.sliders.map((s) => s.wrap), h('div', { class: 'quick-buttons' }, undo, redo));
    editor.on('tool', () => this.update());
    editor.on('options', () => {
      if (!this.dragging) this.update();
    });
    this.update();
  }

  /** Shows the active tool's size/opacity (hidden when the tool has none). */
  update(): void {
    const tool = this.editor.tool;
    const group = (this.editor.options as unknown as Record<string, Record<string, unknown>>)[tool.optionsKey];
    for (const s of this.sliders) {
      const spec = tool.optionSpecs.find((o): o is SliderSpec => o.type === 'slider' && o.key === s.key && !o.group) ?? null;
      s.spec = spec;
      s.wrap.hidden = !spec || !group;
      if (!spec || !group) continue;
      const v = Number(group[spec.key]);
      s.input.value = String(toPos(spec, v));
      s.value.textContent = fmt(spec, v);
    }
  }
}
