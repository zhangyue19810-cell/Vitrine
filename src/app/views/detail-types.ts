import type { InstanceSummary } from "../types";

/** What a tab of the instance page gets to work with, and what it hands back. */

export type TabId = "overview" | "mods" | "worlds" | "servers" | "resources" | "config" | "logs";

export interface TabContext {
  readonly body: HTMLElement;
  /** Aborted when the tab is left or the page closes: pass it to RPC calls and check it after awaits. */
  readonly signal: AbortSignal;
  /** The current record of the instance (changes as the core reports updates). */
  instance(): InstanceSummary;
  /** Show a count next to the tab's label. */
  setCount(count: number | undefined): void;
  /** Switch to another tab. */
  go(tab: TabId): void;
}

export interface TabHandle {
  /** The instance or its game changed. */
  update?(): void;
  dispose?(): void;
}

export interface TabDefinition {
  id: TabId;
  label: string;
  load(): Promise<{ mount(context: TabContext): TabHandle | void | Promise<TabHandle | void> }>;
}
