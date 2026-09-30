#!/usr/bin/env node
// The human side: review pending plans and approve or reject them. The model never runs this.
import { Store, approve, reject, renderPlan } from "./engine.js";
import { dataPaths } from "./server.js";

const [cmd, id] = process.argv.slice(2);
const paths = dataPaths();
const store = new Store(paths.state, paths.audit);
const who = process.env.USER ?? process.env.USERNAME ?? "reviewer";

try {
  if (cmd === "approve" && id) console.log(renderPlan(approve(store, who, id), store.load()));
  else if (cmd === "reject" && id) console.log(renderPlan(reject(store, who, id), store.load()));
  else {
    const s = store.load();
    const pending = s.plans.filter((p) => p.status === "pending");
    console.log(pending.length ? pending.map((p) => renderPlan(p, s)).join("\n\n") : "Nothing waiting for approval.");
    console.log("\nUsage: npm run review -- [approve|reject] <plan-id>");
  }
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}
