import type { IDecoration, IMarker, Terminal } from "@xterm/xterm";
import { decodeCommand, formatDuration, parseMark, signedBy } from "./marks.ts";

/** One command and its output, anchored to xterm markers so it survives resize and reflow. */
export type Block = {
  prompt: IMarker;
  output: IMarker;
  end: IMarker | null;
  command: string;
  exit: number | null;
  started: number;
  ended: number | null;
  decoration?: IDecoration;
};

/**
 * Turns OSC 133 marks into blocks, as in Warp. Marks inside full-screen programs (the alternate
 * screen) and inside a running command are ignored, so a whole agent session stays one block
 * and nothing is drawn into a program's own output. Shells without the integration send no
 * marks and simply get no blocks.
 */
export class Blocks {
  readonly list: Block[] = [];
  /** The shell is waiting at its prompt, so typing a command into it is safe. */
  atPrompt = false;
  /** Seen at least one mark: the shell has tine's integration. */
  integrated = false;
  private prompt: IMarker | null = null;
  private pending = "";
  private running: Block | null = null;

  /** `token` is the one given to this tab's shell; marks without it are ignored. */
  constructor(
    private readonly term: Terminal,
    token: string,
  ) {
    term.parser.registerOscHandler(133, (data) => {
      const mark = signedBy(data, token);
      if (mark !== null) this.mark(mark);
      return true;
    });
    term.parser.registerOscHandler(633, (data) => {
      const payload = signedBy(data, token);
      if (payload?.startsWith("E;")) this.pending = decodeCommand(payload.slice(2));
      return true;
    });
  }

  private mark(data: string) {
    const m = parseMark(data);
    if (!m || this.term.buffer.active.type === "alternate") return;
    this.integrated = true;
    if (m.kind === "A") {
      if (this.running) return;
      this.prompt?.dispose();
      this.prompt = this.term.registerMarker(0);
      this.atPrompt = true;
    } else if (m.kind === "C") {
      if (this.running) return;
      this.atPrompt = false;
      const prompt = this.prompt ?? this.term.registerMarker(0);
      this.prompt = null;
      const block: Block = {
        prompt,
        output: this.term.registerMarker(0),
        end: null,
        command: this.pending,
        exit: null,
        started: Date.now(),
        ended: null,
      };
      this.pending = "";
      this.running = block;
      this.list.push(block);
      // Cleared away (Cmd+K, scrollback limit): forget the block with its marker.
      prompt.onDispose(() => {
        const i = this.list.indexOf(block);
        if (i >= 0) this.list.splice(i, 1);
        block.output.dispose();
        block.end?.dispose();
      });
      this.decorate(block);
    } else if (m.kind === "D") {
      const block = this.running;
      if (!block) return;
      this.running = null;
      block.end = this.term.registerMarker(0);
      block.exit = m.exit;
      block.ended = Date.now();
      this.decorate(block);
    }
  }

  /** A separator above the prompt line, with exit status and duration once the command ends. */
  private decorate(block: Block) {
    block.decoration?.dispose();
    const decoration = this.term.registerDecoration({ marker: block.prompt, layer: "top", width: this.term.cols });
    if (!decoration) return;
    block.decoration = decoration;
    decoration.onRender((el) => {
      el.className = "block-sep" + (block.exit ? " failed" : "");
      el.style.width = "100%";
      if (block.ended === null) return el.replaceChildren();
      const label = document.createElement("span");
      label.className = "block-label";
      const time = formatDuration(block.ended - block.started);
      label.textContent = block.exit ? `exit ${block.exit} · ${time}` : time;
      el.replaceChildren(label);
    });
  }


  /** Scrolls to the previous or next block's prompt from the top of the viewport. */
  jump(direction: -1 | 1): void {
    const top = this.term.buffer.active.viewportY;
    const target =
      direction < 0
        ? this.list.findLast((b) => b.prompt.line < top)
        : this.list.find((b) => b.prompt.line > top);
    if (target) this.term.scrollToLine(target.prompt.line);
  }
}
