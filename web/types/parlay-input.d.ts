// Type declarations for parlay-input (optional local dependency)
// This is a stub that allows TypeScript to compile when parlay-input is not available.
// The actual implementation is at web/local-deps/parlay-input (requires local symlink).
// Keep in sync with packages/input/src/index.ts + src/parlay-input/types.ts.

declare module "parlay-input" {
  export const PROTOCOL_V: number;
  export const ACTION_TTL_MS: number;

  export interface ParlayAction {
    verb: string;
    args?: {
      text?: string;
      requireTail?: string;
      [key: string]: unknown;
    };
  }

  export interface ActionEnvelope {
    v: number;
    streamId: string;
    seq: number;
    baseVersion: number;
    actions: ParlayAction[];
    timing?: {
      engineEvalNs?: number;
      relayMs?: number;
      serverOwnedFire?: boolean;
    };
  }

  export type ApplyResult =
    | "applied"
    | "rejected-stale"
    | "rejected-expired"
    | "rejected-protocol"
    | "resync";

  export interface Tab {
    id: string;
    name: string;
    nicknames: string[];
  }

  export type Unsubscribe = () => void;

  export interface ActionContext {
    element: Element;
    readValue: () => string;
    writeValue: (text: string) => void;
    submit: (text: string) => void;
    device: string;
    streamId: string;
  }

  export interface ParlayInputOptions {
    server: string;
    event?: string;
    settleMs?: number;
    voiceEnabled?: boolean;
    protocolVersion?: number;
    paVersion?: string;
    device?: string;
    streamId?: string;
    tabs?: () => Tab[];
    onAction?: (action: ParlayAction, ctx: ActionContext) => void;
    onSubmit?: (text: string) => void | Promise<void>;
    onApply?: (result: ApplyResult, env: ActionEnvelope) => void;
    onError?: (err: unknown) => void;
    subscribe?: (event: string, handler: (data: ActionEnvelope) => void) => Unsubscribe;
    reconnect?: { initialMs?: number; maxMs?: number };
    fetch?: typeof fetch;
    EventSource?: typeof EventSource;
  }

  export function getDeviceId(): string;
  export function parlayInput(element: Element, options: ParlayInputOptions): Unsubscribe;
}
