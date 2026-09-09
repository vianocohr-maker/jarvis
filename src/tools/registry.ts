/**
 * The bus. Holds the tools, and is the only thing that decides whether one runs.
 *
 * The guard lives here rather than in each tool for one reason: a tool added in
 * six months, by someone who has forgotten this conversation, is still governed
 * by it. Item 40 on the build sheet says the confirmation guard is architectural
 * and not a preference toggle — this file is what that means in practice.
 */

import type { Disposition, Tool, ToolCall } from "./types.ts";

/**
 * Words that must never be typed into a page by an automated agent, whatever
 * the model decides it needs. Checked against tool arguments before execution.
 *
 * This is deliberately blunt. The cost of a false positive is Jarvis saying "I
 * won't type that, do it yourself"; the cost of a false negative is a card
 * number in a form on a page that a model was talked into visiting.
 */
const CREDENTIAL_HINTS = [
  /\b(?:\d[ -]*?){13,19}\b/, // card numbers, spaced or hyphenated
  /\bcvv\b|\bcvc\b|\bsecurity code\b/i,
  /\bpassword\b|\bpasscode\b|\bpassphrase\b/i,
  /\bssn\b|\bsocial security\b|\bnational insurance\b/i,
  /\bsort code\b|\baccount number\b|\biban\b/i,
  /\bapi[_ -]?key\b|\bsecret\b|\btoken\b/i,
];

export interface RegistryEvents {
  /** Called whenever a tool actually runs, for the log. */
  onRan?: (name: string, args: Record<string, unknown>, ms: number) => void;
  onRefused?: (name: string, reason: string) => void;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private events: RegistryEvents;

  constructor(tools: Tool[] = [], events: RegistryEvents = {}) {
    this.events = events;
    for (const t of tools) this.add(t);
  }

  add(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  get size(): number {
    return this.tools.size;
  }

  /**
   * Decide what to do about a call the model wants to make. This never executes
   * a `confirm` tool — it hands back a prompt for the loop to speak, and the
   * loop calls {@link runConfirmed} only after a human says yes out loud.
   */
  async dispatch(call: ToolCall): Promise<Disposition> {
    const tool = this.tools.get(call.name);
    if (!tool) {
      return { kind: "refused", reason: `There is no tool called ${call.name}.` };
    }

    if (tool.risk === "never") {
      const reason = `${tool.name} is not something I will do automatically.`;
      this.events.onRefused?.(tool.name, reason);
      return { kind: "refused", reason };
    }

    const credential = findCredential(call.args);
    if (credential) {
      const reason =
        `That looks like ${credential}, and I will not type credentials or ` +
        `payment details into a page. Do that part yourself.`;
      this.events.onRefused?.(tool.name, reason);
      return { kind: "refused", reason };
    }

    if (tool.risk === "confirm") {
      const prompt =
        tool.confirmationPrompt?.(call.args) ??
        `I am about to run ${tool.name}. Shall I?`;
      return { kind: "needsConfirmation", prompt, call };
    }

    return { kind: "ran", result: await this.run(tool, call) };
  }

  /** Execute a call the user has just approved out loud. */
  async runConfirmed(call: ToolCall): Promise<Disposition> {
    const tool = this.tools.get(call.name);
    if (!tool) return { kind: "refused", reason: `There is no tool called ${call.name}.` };
    // Re-check: approval does not lift the credential rule.
    const credential = findCredential(call.args);
    if (credential) {
      return { kind: "refused", reason: `Still no — that contains ${credential}.` };
    }
    return { kind: "ran", result: await this.run(tool, call) };
  }

  private async run(tool: Tool, call: ToolCall) {
    const started = Date.now();
    try {
      const result = await tool.execute(call.args);
      this.events.onRan?.(tool.name, call.args, Date.now() - started);
      return result;
    } catch (err) {
      return { summary: `${tool.name} failed: ${(err as Error).message}`, failed: true };
    }
  }
}

/** Names the kind of secret spotted, or null. */
function findCredential(args: Record<string, unknown>): string | null {
  for (const value of Object.values(args)) {
    if (typeof value !== "string") continue;
    for (const pattern of CREDENTIAL_HINTS) {
      if (pattern.test(value)) {
        if (/\d{13,}/.test(value.replace(/[ -]/g, ""))) return "a card or account number";
        return "a password or secret";
      }
    }
  }
  return null;
}

/**
 * Did the user say yes? Deliberately strict: silence, a change of subject, or
 * anything ambiguous is a no. Approving something by accident is much worse
 * than having to repeat yourself.
 *
 * The qualifier check matters more than it looks. "Yes but not that one" opens
 * with a clear affirmative and means the opposite, and a naive prefix match
 * approves it — which is how an assistant ends up buying the wrong thing while
 * technically having been told yes.
 */
export function isAffirmative(said: string): boolean {
  const s = said.toLowerCase().trim().replace(/[.!,]/g, "");

  if (/\b(no|nope|cancel|stop|don'?t|do not|wait|abort|nevermind|never mind)\b/.test(s)) {
    return false;
  }

  const affirmative =
    /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|confirm|confirmed|please do|affirmative)\b/.test(
      s,
    );
  if (!affirmative) return false;

  // An affirmative carrying a caveat is a conversation, not consent.
  if (/\b(but|except|although|unless|instead|actually|rather|hold on|first)\b/.test(s)) {
    return false;
  }

  return true;
}
