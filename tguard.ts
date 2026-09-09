import { ToolRegistry, isAffirmative } from "./src/tools/registry.ts";
import { browserTools } from "./src/tools/browser.ts";

const reg = new ToolRegistry(browserTools);
const call = (name: string, args: Record<string, unknown> = {}) =>
  reg.dispatch({ id: "t", name, args });

console.log("loaded tools:", reg.list().map((t) => `${t.name}[${t.risk}]`).join(" "));
console.log("");

// A safe tool with a bad host is still safe to attempt — it fails inside.
console.log("1 read_page (safe)       ->", (await call("read_page")).kind);

// Anything that changes something must come back needing a yes.
const cart = await call("add_to_cart", { item: "USB-C cable", price: "£8.99" });
console.log("2 add_to_cart (confirm)  ->", cart.kind, cart.kind === "needsConfirmation" ? `| asks: "${cart.prompt}"` : "");

const click = await call("click", { text: "Buy now" });
console.log("3 click (confirm)        ->", click.kind, click.kind === "needsConfirmation" ? `| asks: "${click.prompt}"` : "");

// Purchase must be refused outright, whatever is asked.
const buy = await call("checkout");
console.log("4 checkout (never)       ->", buy.kind, buy.kind === "refused" ? `| ${buy.reason}` : "");

// Credentials must be blocked even on an otherwise-safe tool.
const card = await call("search_site", { query: "4111 1111 1111 1111" });
console.log("5 card number in args    ->", card.kind, card.kind === "refused" ? `| ${card.reason.slice(0, 60)}...` : "");
const pw = await call("search_site", { query: "my password is hunter2" });
console.log("6 password in args       ->", pw.kind);

// Approval must not lift the credential rule.
const after = await reg.runConfirmed({ id: "t", name: "search_site", args: { query: "cvv 123" } });
console.log("7 approved but credential->", after.kind, after.kind === "refused" ? `| ${after.reason}` : "");

console.log("");
console.log("affirmative parsing:");
for (const s of ["yes", "yeah do it", "go ahead", "no", "no wait", "cancel", "actually stop", "what's the price", "yes but not that one"]) {
  console.log(`  ${isAffirmative(s) ? "YES " : "no  "} <- "${s}"`);
}
