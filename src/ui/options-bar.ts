import type { Editor } from '../editor';
import type { OptionSpec } from '../tools/tool';
import { openDialog } from './dialog';
import { h, icon } from './dom';

function fmt(spec: Extract<OptionSpec, { type: 'slider' }>, v: number): string {
  if (spec.percent) return `${Math.round(v * 100)}%`;
  return `${Math.round(v)}${spec.unit ?? ''}`;
}

/** Slider positions are 0..1000; log sliders give fine control at small sizes. */
function toPos(spec: Extract<OptionSpec, { type: 'slider' }>, v: number): number {
  if (spec.log) return (Math.log(v / spec.min) / Math.log(spec.max / spec.min)) * 1000;
  return ((v - spec.min) / (spec.max - spec.min)) * 1000;
}

function fromPos(spec: Extract<OptionSpec, { type: 'slider' }>, pos: number): number {
  const t = pos / 1000;
  let v = spec.log ? spec.min * Math.pow(spec.max / spec.min, t) : spec.min + t * (spec.max - spec.min);
  const step = spec.step ?? 1;
  v = Math.round(v / step) * step;
  return Math.max(spec.min, Math.min(spec.max, +v.toFixed(4)));
}

/** Builds the control for one option spec bound to editor.options[key]. */
export function optionControl(editor: Editor, key: string, spec: OptionSpec, large = false): HTMLElement {
  const group = (editor.options as unknown as Record<string, Record<string, unknown>>)[key];
  if (spec.type === 'slider') {
    const value = Number(group[spec.key]);
    const range = h('input', { type: 'range', min: '0', max: '1000', step: '1', value: String(toPos(spec, value)), 'aria-label': spec.label });
    const num = h('input', {
      type: 'number',
      class: 'opt-num',
      min: String(spec.percent ? Math.round(spec.min * 100) : spec.min),
      max: String(spec.percent ? Math.round(spec.max * 100) : spec.max),
      value: String(spec.percent ? Math.round(value * 100) : Math.round(value)),
      'aria-label': `${spec.label} value`,
      inputmode: 'numeric',
    });
    const sync = (v: number) => {
      range.value = String(toPos(spec, v));
      num.value = String(spec.percent ? Math.round(v * 100) : Math.round(v));
      num.title = fmt(spec, v);
    };
    range.addEventListener('input', () => {
      const v = fromPos(spec, Number(range.value));
      editor.setOption(key, spec.key, v);
      num.value = String(spec.percent ? Math.round(v * 100) : Math.round(v));
    });
    num.addEventListener('change', () => {
      let v = Number(num.value);
      if (!Number.isFinite(v)) return sync(Number(group[spec.key]));
      if (spec.percent) v /= 100;
      v = Math.max(spec.min, Math.min(spec.max, v));
      editor.setOption(key, spec.key, v);
      sync(v);
    });
    return h('label', { class: `opt opt-slider ${large ? 'large' : ''}`.trim(), title: spec.label }, h('span', { class: 'opt-label' }, spec.label), range, num, spec.percent ? h('span', { class: 'opt-unit' }, '%') : null);
  }
  if (spec.type === 'toggle') {
    const on = Boolean(group[spec.key]);
    const b = h('button', { type: 'button', class: `opt opt-toggle ${on ? 'on' : ''}`, 'aria-pressed': String(on), title: spec.title ?? spec.label }, spec.label);
    b.addEventListener('click', () => {
      const v = !group[spec.key];
      editor.setOption(key, spec.key, v);
      b.classList.toggle('on', v);
      b.setAttribute('aria-pressed', String(v));
    });
    return b;
  }
  const seg = h('div', { class: 'opt opt-choice', role: 'radiogroup', 'aria-label': spec.label });
  for (const c of spec.choices) {
    const b = h('button', { type: 'button', class: `seg ${group[spec.key] === c.value ? 'on' : ''}`, role: 'radio', 'aria-checked': String(group[spec.key] === c.value), title: c.title ?? c.label }, c.label);
    b.addEventListener('click', () => {
      editor.setOption(key, spec.key, c.value);
      seg.querySelectorAll('.seg').forEach((s) => {
        s.classList.toggle('on', s === b);
        s.setAttribute('aria-checked', String(s === b));
      });
    });
    seg.append(b);
  }
  return seg;
}

/**
 * Context-sensitive options for the active tool. Desktop shows every option
 * inline; mobile shows the primary sliders and an "all options" sheet.
 */
export class OptionsBar {
  readonly el = h('div', { class: 'optionsbar', role: 'group', 'aria-label': 'Tool options' });
  private readonly editor: Editor;
  private mobile = false;
  private extras: HTMLElement = h('div', { class: 'opt-extras' });

  constructor(editor: Editor) {
    this.editor = editor;
    let unsub = editor.doc.on('selection', () => this.renderExtras());
    editor.on('document', () => {
      unsub();
      unsub = editor.doc.on('selection', () => this.renderExtras());
      this.render();
    });
    editor.on('tool', () => this.render());
    editor.on('hint', (t) => this.setHint(t));
    editor.on('modified', () => this.renderExtras());
    this.render();
  }

  setMobile(mobile: boolean): void {
    if (mobile === this.mobile) return;
    this.mobile = mobile;
    this.render();
  }

  private hintEl = h('span', { class: 'opt-hint' });

  private setHint(t: string): void {
    this.hintEl.textContent = t;
    this.renderExtras();
  }

  render(): void {
    const tool = this.editor.tool;
    this.el.replaceChildren();
    this.el.append(h('span', { class: 'opt-title' }, tool.label));
    let specs = tool.optionSpecs;
    let more = false;
    if (this.mobile) {
      const primary = specs.filter((s) => s.type === 'slider' && (s.key === 'size' || s.key === 'opacity' || s.key === 'tolerance'));
      more = specs.length > primary.length;
      specs = primary.length ? primary : specs.slice(0, 2);
      more = more || specs.length < tool.optionSpecs.length;
    }
    for (const spec of specs) this.el.append(optionControl(this.editor, tool.optionsKey, spec));
    if (more) {
      const b = h('button', { type: 'button', class: 'icon-btn opt-more', title: 'All tool options', 'aria-label': 'All tool options' }, icon('settings'));
      b.addEventListener('click', () => this.openSheet());
      this.el.append(b);
    }
    this.el.append(this.extras, this.hintEl);
    this.renderExtras();
  }

  /** Full option list in a dialog (mobile). */
  openSheet(): void {
    const tool = this.editor.tool;
    if (!tool.optionSpecs.length) return;
    const list = h('div', { class: 'opt-sheet' }, ...tool.optionSpecs.map((s) => optionControl(this.editor, tool.optionsKey, s, true)));
    openDialog({ title: `${tool.label} options`, content: list, className: 'sheet', onClose: () => this.render() });
  }

  /** Contextual buttons: apply/cancel a floating move, deselect, crop to selection. */
  private renderExtras(): void {
    const e = this.editor;
    const x = this.extras;
    x.replaceChildren();
    if (e.floating) {
      const apply = h('button', { type: 'button', class: 'btn small primary' }, 'Apply');
      apply.addEventListener('click', () => {
        e.commitFloating();
        this.renderExtras();
      });
      const cancel = h('button', { type: 'button', class: 'btn small' }, 'Cancel');
      cancel.addEventListener('click', () => {
        e.cancelFloating();
        this.renderExtras();
      });
      x.append(apply, cancel);
    } else if (e.doc.selection.active && (e.tool.id.startsWith('select') || e.tool.id === 'lasso' || e.tool.id === 'wand')) {
      const des = h('button', { type: 'button', class: 'btn small' }, 'Deselect');
      des.addEventListener('click', () => e.deselect());
      x.append(des);
    }
  }
}
