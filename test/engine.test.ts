import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Store, approve, reject, proposeBudget, proposeUndo, PlanError } from "../src/engine.ts";
import { buildServer } from "../src/server.ts";

function freshStore() {
  const dir = mkdtempSync(join(tmpdir(), "agm-"));
  return { store: new Store(join(dir, "state.json"), join(dir, "audit.jsonl")), audit: join(dir, "audit.jsonl") };
}
const budget = (s: Store, id: string) => s.load().campaigns.find((c) => c.id === id)!.dailyBudget;

test("a proposed change does nothing until a person approves it", () => {
  const { store } = freshStore();
  const plan = proposeBudget(store, "claude", "1001", 65);
  assert.equal(plan.status, "pending");
  assert.equal(budget(store, "1001"), 40);
  approve(store, "austin", plan.id);
  assert.equal(budget(store, "1001"), 65);
});

test("budget caps block a plan at proposal time", () => {
  const { store } = freshStore();
  assert.throws(() => proposeBudget(store, "claude", "1001", 500), PlanError);
  assert.equal(store.load().plans.length, 0);
});

test("drift: a plan whose 'before' no longer matches live state is refused, not applied", () => {
  const { store } = freshStore();
  const stale = proposeBudget(store, "claude", "1001", 65);
  approve(store, "austin", proposeBudget(store, "claude", "1001", 90).id);
  assert.throws(() => approve(store, "austin", stale.id), /Drift/);
  assert.equal(budget(store, "1001"), 90);
  assert.equal(store.load().plans.find((p) => p.id === stale.id)!.status, "failed");
});

test("undo is a plan too, and it restores the original value once approved", () => {
  const { store } = freshStore();
  const plan = proposeBudget(store, "claude", "1001", 65);
  approve(store, "austin", plan.id);
  const undo = proposeUndo(store, "claude", plan.id);
  assert.equal(undo.status, "pending");
  assert.equal(budget(store, "1001"), 65);
  approve(store, "austin", undo.id);
  assert.equal(budget(store, "1001"), 40);
});

test("rejected plans can't be approved later, and everything is audited", () => {
  const { store, audit } = freshStore();
  const plan = proposeBudget(store, "claude", "1002", 100);
  reject(store, "austin", plan.id);
  assert.throws(() => approve(store, "austin", plan.id), /rejected/);
  const types = readFileSync(audit, "utf8").trim().split("\n").map((l) => JSON.parse(l).type);
  assert.deepEqual(types, ["plan.created", "plan.rejected"]);
});

test("over MCP: reads work, writes return pending plans, and there is no approve tool", async () => {
  const { store } = freshStore();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await buildServer(store, "test-client").connect(a);
  const client = new Client({ name: "test", version: "1.0.0" });
  await client.connect(b);

  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  assert.ok(names.includes("list_campaigns") && names.includes("propose_budget_change"));
  assert.ok(!names.some((n) => /approve|apply/.test(n)), "the model must not be able to approve its own plans");

  const list: any = await client.callTool({ name: "list_campaigns", arguments: {} });
  assert.match(list.content[0].text, /Brand – US/);

  const proposed: any = await client.callTool({ name: "propose_budget_change", arguments: { campaign_id: "1001", daily_budget: 65 } });
  assert.match(proposed.content[0].text, /Status: pending/);
  assert.equal(budget(store, "1001"), 40);

  const blocked: any = await client.callTool({ name: "propose_budget_change", arguments: { campaign_id: "1001", daily_budget: 999 } });
  assert.equal(blocked.isError, true);
  assert.match(blocked.content[0].text, /budget cap/i);
  await client.close();
});
