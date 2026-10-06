import { h, icon } from './dom';

export interface DialogButton {
  label: string;
  primary?: boolean;
  danger?: boolean;
  /** Return false to keep the dialog open. */
  onClick?: () => boolean | void | Promise<boolean | void>;
}

export interface DialogHandle {
  el: HTMLDialogElement;
  close(): void;
  closed: Promise<void>;
}

let openCount = 0;

/** True while any modal dialog is open (keyboard shortcuts are suspended). */
export function dialogOpen(): boolean {
  return openCount > 0;
}

/**
 * Opens a modal dialog (native <dialog>). On narrow screens CSS turns it
 * into a bottom sheet. Enter triggers the primary button.
 */
export function openDialog(opts: { title: string; content: Node | Node[]; buttons?: DialogButton[]; className?: string; onClose?: () => void; wide?: boolean }): DialogHandle {
  const body = h('div', { class: 'dialog-body' }, ...(Array.isArray(opts.content) ? opts.content : [opts.content]));
  const footer = h('div', { class: 'dialog-footer' });
  const closeBtn = h('button', { class: 'icon-btn dialog-close', type: 'button', title: 'Close', 'aria-label': 'Close' }, icon('close'));
  const titleId = `dlg-${Math.random().toString(36).slice(2, 8)}`;
  const dlg = h(
    'dialog',
    { class: `dialog ${opts.className ?? ''} ${opts.wide ? 'wide' : ''}`.trim(), 'aria-labelledby': titleId },
    h('form', { method: 'dialog', class: 'dialog-form' }, h('header', { class: 'dialog-header' }, h('h2', { id: titleId }, opts.title), closeBtn), body, footer),
  );
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => (resolveClosed = r));
  let isClosed = false;
  const close = () => {
    if (isClosed) return;
    isClosed = true;
    openCount--;
    dlg.close();
    dlg.remove();
    opts.onClose?.();
    resolveClosed();
  };
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    close();
  });
  dlg.addEventListener('cancel', (e) => {
    e.preventDefault();
    close();
  });
  // Click on the backdrop closes.
  dlg.addEventListener('pointerdown', (e) => {
    if (e.target === dlg) close();
  });
  let primary: HTMLButtonElement | null = null;
  for (const b of opts.buttons ?? []) {
    const btn = h('button', { type: 'button', class: `btn ${b.primary ? 'primary' : ''} ${b.danger ? 'danger' : ''}`.trim() }, b.label);
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const keep = (await b.onClick?.()) === false;
        if (!keep) close();
      } finally {
        btn.disabled = false;
      }
    });
    if (b.primary) primary = btn;
    footer.append(btn);
  }
  if (!opts.buttons?.length) footer.remove();
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && primary && !(e.target instanceof HTMLButtonElement) && !(e.target instanceof HTMLTextAreaElement)) {
      e.preventDefault();
      primary.click();
    }
    e.stopPropagation();
  });
  document.body.append(dlg);
  openCount++;
  dlg.showModal();
  // Focus the first field on desktop; avoid popping the keyboard on phones.
  if (!matchMedia('(pointer: coarse)').matches) {
    const first = body.querySelector<HTMLElement>('input:not([type=checkbox]):not([type=radio]), select, textarea');
    first?.focus();
    if (first instanceof HTMLInputElement) first.select();
  }
  return { el: dlg, close, closed };
}

export function confirmDialog(title: string, message: string, okLabel = 'OK', danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let result = false;
    openDialog({
      title,
      content: h('p', { class: 'dialog-message' }, message),
      buttons: [
        { label: 'Cancel' },
        {
          label: okLabel,
          primary: !danger,
          danger,
          onClick: () => {
            result = true;
          },
        },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function promptDialog(title: string, label: string, value: string, okLabel = 'OK'): Promise<string | null> {
  return new Promise((resolve) => {
    const input = h('input', { type: 'text', value, class: 'input', 'aria-label': label });
    let result: string | null = null;
    openDialog({
      title,
      content: field(label, input),
      buttons: [{ label: 'Cancel' }, { label: okLabel, primary: true, onClick: () => void (result = input.value) }],
      onClose: () => resolve(result),
    });
    if (matchMedia('(pointer: coarse)').matches) setTimeout(() => input.focus(), 50);
  });
}

// ---- form helpers

export function field(label: string, control: HTMLElement, hint?: string): HTMLElement {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), control, hint ? h('span', { class: 'field-hint' }, hint) : null);
}

export function numberInput(value: number, min: number, max: number, step = 1): HTMLInputElement {
  return h('input', { type: 'number', class: 'input', value: String(value), min: String(min), max: String(max), step: String(step), inputmode: 'numeric' });
}

export function readNumber(input: HTMLInputElement, min: number, max: number, fallback: number): number {
  const v = Number(input.value);
  if (!Number.isFinite(v)) return fallback;
  return Math.max(min, Math.min(max, Math.round(v)));
}

export function selectInput(options: { value: string; label: string }[], value: string): HTMLSelectElement {
  const s = h('select', { class: 'input' }, ...options.map((o) => h('option', { value: o.value, selected: o.value === value }, o.label)));
  s.value = value;
  return s;
}

export function checkbox(label: string, checked: boolean, title?: string): { el: HTMLElement; input: HTMLInputElement } {
  const input = h('input', { type: 'checkbox', checked });
  return { el: h('label', { class: 'check', title }, input, h('span', null, label)), input };
}
