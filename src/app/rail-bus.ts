import type { DiscAction, RailEvents } from "../control-rail";
import type { PlateGroup } from "../rail/model";

/**
 * Who owns which plates. The control rail (see control-rail.ts) draws one flat list of plates, but each part of the app
 * (the view tabs, the music dock, the download row, …) knows only its own: it hands the bus its groups under its own name
 * and receives the presses on them. The bus prefixes every id with the part's name, merges all parts into one list for the
 * rail — in the order the parts first appeared, so the layout is stable — and routes each event back by that prefix.
 */

export interface RailPart {
  press?(id: string, cell?: number): void;
  slide?(id: string, amount: number): void;
  wheel?(id: string, direction: number): void;
  field?(id: string, text: string): void;
  submit?(id: string): void;
  /** A text plate took (id) or gave back (null) the keyboard. */
  focus?(id: string | null): void;
}

/** What the bus needs from the scene host. */
export interface RailHost {
  railEvents: Partial<RailEvents>;
  setRail(groups: PlateGroup[]): void;
  focusRailField(id: string): void;
}

const SEPARATOR = ":";

export class RailBus {
  private readonly parts = new Map<string, { groups: PlateGroup[]; handler: RailPart }>();
  private queued = false;
  private shown = "";
  private focused: string | null = null;
  private discHandler?: (action: DiscAction) => void;

  constructor(private readonly host: RailHost) {
    const route = (id: string, call: (part: RailPart, rest: string) => void) => {
      const at = id.indexOf(SEPARATOR);
      const part = this.parts.get(at < 0 ? id : id.slice(0, at));
      if (part) call(part.handler, at < 0 ? "" : id.slice(at + 1));
    };
    host.railEvents = {
      press: (id, cell) => route(id, (part, rest) => part.press?.(rest, cell)),
      slide: (id, amount) => route(id, (part, rest) => part.slide?.(rest, amount)),
      wheel: (id, direction) => route(id, (part, rest) => part.wheel?.(rest, direction)),
      field: (id, text) => route(id, (part, rest) => part.field?.(rest, text)),
      submit: (id) => route(id, (part, rest) => part.submit?.(rest)),
      disc: (action) => this.discHandler?.(action),
      focus: (id) => {
        if (id === null) {
          // Whoever had the keyboard is told that it is gone.
          const name = this.focused;
          this.focused = null;
          if (name !== null) this.parts.get(name)?.handler.focus?.(null);
          return;
        }
        const at = id.indexOf(SEPARATOR);
        this.focused = at < 0 ? id : id.slice(0, at);
        route(id, (part, rest) => part.focus?.(rest));
      },
    };
  }

  /** Who hears the music disc (it belongs to no part: it is one object on the rail). */
  onDisc(handler: (action: DiscAction) => void) {
    this.discHandler = handler;
  }

  /**
   * Set the plates of one part (ids as the part knows them, without the prefix). The handler is kept from the first call
   * if later calls leave it out, so a part can refresh its plates without passing itself again.
   */
  set(part: string, groups: PlateGroup[], handler?: RailPart) {
    const known = this.parts.get(part);
    this.parts.set(part, { groups, handler: handler ?? known?.handler ?? {} });
    this.schedule();
  }

  /** Take all plates of a part away (it stays registered, so that it can bring them back). */
  clear(part: string) {
    const known = this.parts.get(part);
    if (!known || known.groups.length === 0) return;
    known.groups = [];
    this.schedule();
  }

  /** Give a text plate of a part the keyboard. */
  focusField(part: string, id: string) {
    this.host.focusRailField(`${part}${SEPARATOR}${id}`);
  }

  /** The merged list of plates, ids prefixed (what the rail receives). */
  merged(): PlateGroup[] {
    const out: PlateGroup[] = [];
    for (const [name, part] of this.parts) {
      for (const group of part.groups) {
        out.push({ ...group, id: `${name}${SEPARATOR}${group.id}`, plates: group.plates.map((plate) => ({ ...plate, id: `${name}${SEPARATOR}${plate.id}` })) });
      }
    }
    return out;
  }

  /** Send the merged list to the rail now (normally this happens by itself after the current task). */
  flush() {
    this.queued = false;
    const groups = this.merged();
    const signature = JSON.stringify(groups);
    if (signature === this.shown) return;
    this.shown = signature;
    this.host.setRail(groups);
  }

  /** Send the plates again even if nothing changed (the scene was rebuilt, or the fonts arrived). */
  resend() {
    this.shown = "";
    this.flush();
  }

  private schedule() {
    if (this.queued) return;
    this.queued = true;
    queueMicrotask(() => this.flush());
  }
}
