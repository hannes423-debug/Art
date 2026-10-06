import { Emitter } from './emitter';

/** An undoable operation. */
export interface Command {
  readonly label: string;
  /** Approximate memory held by this command, used to cap history size. */
  readonly bytes: number;
  undo(): void;
  redo(): void;
}

/** Runs a list of commands as one undo step. */
export class CompoundCommand implements Command {
  readonly label: string;
  readonly commands: Command[];

  constructor(label: string, commands: Command[]) {
    this.label = label;
    this.commands = commands;
  }

  get bytes(): number {
    return this.commands.reduce((s, c) => s + c.bytes, 0);
  }

  undo(): void {
    for (let i = this.commands.length - 1; i >= 0; i--) this.commands[i].undo();
  }

  redo(): void {
    for (const c of this.commands) c.redo();
  }
}

/** A command built from two closures; handy for small property changes. */
export class FnCommand implements Command {
  readonly label: string;
  readonly bytes: number;
  private readonly doFn: () => void;
  private readonly undoFn: () => void;

  constructor(label: string, doFn: () => void, undoFn: () => void, bytes = 64) {
    this.label = label;
    this.doFn = doFn;
    this.undoFn = undoFn;
    this.bytes = bytes;
  }

  undo(): void {
    this.undoFn();
  }

  redo(): void {
    this.doFn();
  }
}

interface HistoryEvents {
  change: void;
}

/**
 * Linear undo/redo stack with step and memory limits. Brush strokes and other
 * pixel edits are recorded as tile patches (see tiles.ts), so a stroke costs
 * memory proportional to the area it touched, not the canvas size.
 */
export class History extends Emitter<HistoryEvents> {
  private undoStack: Command[] = [];
  private redoStack: Command[] = [];
  maxSteps: number;
  maxBytes: number;
  /** Monotonic counter bumped on every change; used for "unsaved changes" tracking. */
  version = 0;
  /**
   * Called before undo/redo/execute so in-progress operations (e.g. a
   * floating selection being moved) can be committed first.
   */
  beforeChange: (() => void) | null = null;
  private busy = false;

  constructor(maxSteps = 200, maxBytes = 256 * 1024 * 1024) {
    super();
    this.maxSteps = maxSteps;
    this.maxBytes = maxBytes;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  get undoLabel(): string | null {
    return this.undoStack.at(-1)?.label ?? null;
  }

  get redoLabel(): string | null {
    return this.redoStack.at(-1)?.label ?? null;
  }

  get totalBytes(): number {
    let n = 0;
    for (const c of this.undoStack) n += c.bytes;
    for (const c of this.redoStack) n += c.bytes;
    return n;
  }

  get undoCount(): number {
    return this.undoStack.length;
  }

  private flushPending(): void {
    if (this.busy || !this.beforeChange) return;
    this.busy = true;
    try {
      this.beforeChange();
    } finally {
      this.busy = false;
    }
  }

  /** Records an already-applied command. */
  push(cmd: Command): void {
    this.redoStack = [];
    this.undoStack.push(cmd);
    this.trim();
    this.version++;
    this.emit('change');
  }

  /** Applies a command and records it. */
  execute(cmd: Command): void {
    this.flushPending();
    cmd.redo();
    this.push(cmd);
  }

  undo(): boolean {
    this.flushPending();
    const cmd = this.undoStack.pop();
    if (!cmd) return false;
    cmd.undo();
    this.redoStack.push(cmd);
    this.version++;
    this.emit('change');
    return true;
  }

  redo(): boolean {
    this.flushPending();
    const cmd = this.redoStack.pop();
    if (!cmd) return false;
    cmd.redo();
    this.undoStack.push(cmd);
    this.version++;
    this.emit('change');
    return true;
  }

  clear(): void {
    this.undoStack = [];
    this.redoStack = [];
    this.version++;
    this.emit('change');
  }

  private trim(): void {
    while (this.undoStack.length > this.maxSteps) this.undoStack.shift();
    let total = this.totalBytes;
    // Always keep at least the most recent step, even if it alone exceeds the budget.
    while (total > this.maxBytes && this.undoStack.length > 1) {
      total -= this.undoStack.shift()!.bytes;
    }
  }
}
