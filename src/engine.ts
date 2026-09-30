// The change engine: the model can only propose plans. A person approves them outside the chat,
// and applying re-checks budget caps and live state so a stale plan never lands.
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface Campaign {
  id: string;
  name: string;
  status: "ENABLED" | "PAUSED";
  dailyBudget: number;
  spend30d: number;
  conversions30d: number;
}

export type Op =
  | { kind: "set_budget"; campaignId: string; before: number; after: number }
  | { kind: "set_status"; campaignId: string; before: Campaign["status"]; after: Campaign["status"] };

export type PlanStatus = "pending" | "applied" | "rejected" | "failed";

export interface Plan {
  id: string;
  title: string;
  ops: Op[];
  status: PlanStatus;
  proposedBy: string;
  createdAt: string;
  decidedBy?: string;
  decidedAt?: string;
  undoes?: string;
  error?: string;
}

export interface State {
  campaigns: Campaign[];
  plans: Plan[];
  /** Highest daily budget any single campaign may have. Checked when a plan is made and again at apply. */
  maxDailyBudget: number;
}

export const SANDBOX: State = {
  maxDailyBudget: 150,
  plans: [],
  campaigns: [
    { id: "1001", name: "Brand – US", status: "ENABLED", dailyBudget: 40, spend30d: 1150.4, conversions30d: 212 },
    { id: "1002", name: "Emergency Plumber – Denver", status: "ENABLED", dailyBudget: 80, spend30d: 2390.1, conversions30d: 131 },
    { id: "1003", name: "Water Heater Install", status: "ENABLED", dailyBudget: 60, spend30d: 1799.9, conversions30d: 64 },
  ],
};

export class PlanError extends Error {}

/** A tiny JSON-file store so the MCP server and the human review CLI share state. */
export class Store {
  constructor(private file: string, private auditFile: string, private now: () => Date = () => new Date()) {}

  load(): State {
    if (!existsSync(this.file)) return structuredClone(SANDBOX);
    return JSON.parse(readFileSync(this.file, "utf8")) as State;
  }

  save(state: State): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(state, null, 2));
  }

  audit(actor: string, type: string, data: Record<string, unknown>): void {
    mkdirSync(dirname(this.auditFile), { recursive: true });
    appendFileSync(this.auditFile, JSON.stringify({ at: this.now().toISOString(), actor, type, ...data }) + "\n");
  }

  stamp(): string {
    return this.now().toISOString();
  }
}

function campaign(state: State, id: string): Campaign {
  const c = state.campaigns.find((x) => x.id === id);
  if (!c) throw new PlanError(`No campaign with id ${id}`);
  return c;
}

function checkCaps(state: State, ops: Op[]): void {
  for (const op of ops) {
    if (op.kind === "set_budget" && op.after > state.maxDailyBudget) {
      throw new PlanError(`Blocked by budget cap: $${op.after}/day exceeds the $${state.maxDailyBudget}/day limit`);
    }
  }
}

export function describe(op: Op, state: State): string {
  const name = campaign(state, op.campaignId).name;
  return op.kind === "set_budget"
    ? `Budget for "${name}": $${op.before.toFixed(2)} → $${op.after.toFixed(2)}/day`
    : `Status of "${name}": ${op.before} → ${op.after}`;
}

export function propose(store: Store, proposedBy: string, title: string, build: (s: State) => Op[], undoes?: string): Plan {
  const state = store.load();
  const ops = build(state);
  checkCaps(state, ops);
  const plan: Plan = { id: randomUUID(), title, ops, status: "pending", proposedBy, createdAt: store.stamp(), undoes };
  state.plans.push(plan);
  store.save(state);
  store.audit(proposedBy, "plan.created", { plan: plan.id, title });
  return plan;
}

export function proposeBudget(store: Store, proposedBy: string, campaignId: string, dailyBudget: number): Plan {
  return propose(store, proposedBy, `Set budget to $${dailyBudget.toFixed(2)}/day`, (s) => {
    const c = campaign(s, campaignId);
    if (c.dailyBudget === dailyBudget) throw new PlanError("Budget is already that amount; nothing to change");
    return [{ kind: "set_budget", campaignId, before: c.dailyBudget, after: dailyBudget }];
  });
}

export function proposeStatus(store: Store, proposedBy: string, campaignId: string, status: Campaign["status"]): Plan {
  return propose(store, proposedBy, `Set status to ${status}`, (s) => {
    const c = campaign(s, campaignId);
    if (c.status === status) throw new PlanError(`Campaign is already ${status}`);
    return [{ kind: "set_status", campaignId, before: c.status, after: status }];
  });
}

function getPlan(state: State, id: string): Plan {
  const p = state.plans.find((x) => x.id === id);
  if (!p) throw new PlanError(`No plan with id ${id}`);
  return p;
}

/** Human-only: approve and apply. Refuses on drift or a cap breach, and never half-applies. */
export function approve(store: Store, reviewer: string, planId: string): Plan {
  const state = store.load();
  const plan = getPlan(state, planId);
  if (plan.status !== "pending") throw new PlanError(`Plan is ${plan.status}, not pending`);
  try {
    checkCaps(state, plan.ops);
    for (const op of plan.ops) {
      const c = campaign(state, op.campaignId);
      const live = op.kind === "set_budget" ? c.dailyBudget : c.status;
      if (live !== op.before) throw new PlanError(`Drift: "${c.name}" is now ${live}, but the plan expected ${op.before}. Propose a fresh plan.`);
    }
  } catch (err) {
    plan.status = "failed";
    plan.error = (err as Error).message;
    plan.decidedBy = reviewer;
    plan.decidedAt = store.stamp();
    store.save(state);
    store.audit(reviewer, "plan.failed", { plan: plan.id, error: plan.error });
    throw err;
  }
  for (const op of plan.ops) {
    const c = campaign(state, op.campaignId);
    if (op.kind === "set_budget") c.dailyBudget = op.after;
    else c.status = op.after;
  }
  plan.status = "applied";
  plan.decidedBy = reviewer;
  plan.decidedAt = store.stamp();
  store.save(state);
  store.audit(reviewer, "plan.applied", { plan: plan.id });
  return plan;
}

export function reject(store: Store, reviewer: string, planId: string): Plan {
  const state = store.load();
  const plan = getPlan(state, planId);
  if (plan.status !== "pending") throw new PlanError(`Plan is ${plan.status}, not pending`);
  plan.status = "rejected";
  plan.decidedBy = reviewer;
  plan.decidedAt = store.stamp();
  store.save(state);
  store.audit(reviewer, "plan.rejected", { plan: plan.id });
  return plan;
}

/** Undo is itself a plan: the reverse ops, which also need approval. */
export function proposeUndo(store: Store, proposedBy: string, planId: string): Plan {
  const original = getPlan(store.load(), planId);
  if (original.status !== "applied") throw new PlanError("Only applied plans can be undone");
  return propose(
    store,
    proposedBy,
    `Undo: ${original.title}`,
    () => original.ops.map((op) => ({ ...op, before: op.after, after: op.before }) as Op).reverse(),
    original.id,
  );
}

export function renderPlan(plan: Plan, state: State): string {
  const lines = [`Plan ${plan.id}: ${plan.title}`, `Status: ${plan.status}${plan.error ? ` (${plan.error})` : ""}`, ""];
  for (const op of plan.ops) lines.push(`  ~ ${describe(op, state)}`);
  if (plan.status === "pending") lines.push("", `Waiting for a person to approve: npm run review -- approve ${plan.id}`);
  return lines.join("\n");
}
