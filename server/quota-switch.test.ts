// Quota-switch card lifecycle, mirroring peer-approval.test.ts: a real
// Store (so message/task/bot writes go through the genuine code paths) with
// a fake instance registry and a spy dispatch standing in for
// server/index.ts's startTurn.
import { rmSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DATA_DIR } from "./config.ts";
import type { ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { closeMessageDb } from "./message-db.ts";
import {
  maybeRaiseQuotaCard,
  resolveQuotaSwitch,
  type QuotaSwitchDeps,
  type QuotaSwitchInstance,
} from "./quota-switch.ts";
import { Store, type BotRecord } from "./store.ts";

const defaultSelection = (): ModelSelection => ({ instanceId: "claude", model: "claude-default" });

function fakeInstance(
  instanceId: string,
  driverKind: string,
  displayName: string,
  overrides: Partial<QuotaSwitchInstance> = {},
): QuotaSwitchInstance {
  return {
    instanceId,
    driverKind,
    displayName,
    models: { default: `${instanceId}-default`, options: [{ id: `${instanceId}-default`, label: "Default" }] },
    adapter: { capabilities: {} },
    snapshot: async () => ({ state: "available", authenticated: true }) satisfies ProviderSnapshot,
    ...overrides,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function pendingQuotaCard(store: Store, threadId: string) {
  return store
    .messagesFor(threadId)
    .find((m) => m.kind === "options" && m.card?.requestId && !m.card.answered && !m.card.dismissed);
}

describe("quota-switch card lifecycle", () => {
  let store: Store;
  let bot: BotRecord;
  let dispatch: ReturnType<typeof vi.fn<(botId: string, threadId: string, text: string) => void>>;
  let deps: QuotaSwitchDeps;
  let instances: QuotaSwitchInstance[];

  beforeEach(() => {
    store = new Store(defaultSelection);
    bot = store.patchBot(store.createBot().id, { name: "Wren", modelSelection: { instanceId: "claude", model: "claude-default" } })!;
    store.patchTask(bot.id, bot.threadId, { modelSelection: { instanceId: "claude", model: "claude-default" } });
    instances = [
      fakeInstance("claude", "claudeAgent", "Claude"),
      fakeInstance("codex", "codex", "Codex"),
      fakeInstance("grok", "grok", "Grok"),
    ];
    dispatch = vi.fn<(botId: string, threadId: string, text: string) => void>();
    deps = { store, instances: () => instances, dispatch };
  });

  afterEach(() => {
    closeMessageDb();
    rmSync(DATA_DIR, { recursive: true, force: true });
  });

  it("raises a card offering the other configured engines, and not the current one", () => {
    const card = maybeRaiseQuotaCard(deps, bot, bot.threadId, "402 quota exceeded, upgrade your billing plan");
    expect(card).toBeTruthy();
    expect(card!.card!.title).toContain("Claude");
    expect(card!.card!.options).toEqual(["Codex", "Grok", "Not now"]);
    expect(pendingQuotaCard(store, bot.threadId)?.id).toBe(card!.id);
  });

  it("caps the offered engines at three plus Not now", () => {
    instances.push(fakeInstance("pi", "pi", "Pi"), fakeInstance("antigravity", "antigravity", "Antigravity"));
    const card = maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded");
    expect(card!.card!.options).toEqual(["Codex", "Grok", "Pi", "Not now"]);
  });

  it("raises no second card on the same thread while one is already pending", () => {
    const first = maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded");
    const second = maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded");
    expect(first).toBeTruthy();
    expect(second).toBeNull();
    expect(
      store.messagesFor(bot.threadId).filter((m) => m.kind === "options" && m.card?.requestId).length,
    ).toBe(1);
  });

  it("raises no card for a non-quota runtime error", () => {
    const card = maybeRaiseQuotaCard(deps, bot, bot.threadId, "500 internal server error");
    expect(card).toBeNull();
    expect(pendingQuotaCard(store, bot.threadId)).toBeUndefined();
  });

  it("raises no card when no alternatives are configured", () => {
    instances = [fakeInstance("claude", "claudeAgent", "Claude")];
    const card = maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded");
    expect(card).toBeNull();
  });

  it("choosing an engine switches the bot's modelSelection and re-dispatches the last user message", async () => {
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "how's the weather" });
    const card = maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded")!;

    expect(resolveQuotaSwitch(deps, card.card!.requestId!, "Codex")).toBe(true);
    await flush();

    expect(store.bot(bot.id)?.modelSelection).toEqual({ instanceId: "codex", model: "codex-default" });
    expect(dispatch).toHaveBeenCalledWith(bot.id, bot.threadId, "how's the weather");

    const settled = store.messagesFor(bot.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answered).toBeTruthy();
    expect(settled?.card?.answeredText).toBe("Codex");

    const chip = store.messagesFor(bot.threadId).find((m) => m.kind === "activity" && m.tool?.name.includes("Codex"));
    expect(chip).toBeTruthy();
  });

  it("does not switch when the chosen engine is no longer available", async () => {
    instances[1] = fakeInstance("codex", "codex", "Codex", {
      snapshot: async () => ({ state: "unavailable", reason: "signed out" }) satisfies ProviderSnapshot,
    });
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    const card = maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded")!;

    resolveQuotaSwitch(deps, card.card!.requestId!, "Codex");
    await flush();

    expect(store.bot(bot.id)?.modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("'Not now' settles the card, leaves modelSelection untouched, and dispatches nothing", async () => {
    store.appendMessage(bot.threadId, { role: "user", kind: "text", text: "hi" });
    const card = maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded")!;

    expect(resolveQuotaSwitch(deps, card.card!.requestId!, "Not now")).toBe(true);
    await flush();

    const settled = store.messagesFor(bot.threadId).find((m) => m.id === card.id);
    expect(settled?.card?.answered).toBeTruthy();
    expect(settled?.card?.answeredText).toBe("Not now");
    expect(store.bot(bot.id)?.modelSelection).toEqual({ instanceId: "claude", model: "claude-default" });
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("frees the thread for a new card once the pending one is resolved", () => {
    const first = maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded")!;
    resolveQuotaSwitch(deps, first.card!.requestId!, "Not now");
    const second = maybeRaiseQuotaCard(deps, bot, bot.threadId, "quota exceeded");
    expect(second).toBeTruthy();
  });

  it("answers an unknown requestId as not-ours, so provider and peer cards still route", () => {
    expect(resolveQuotaSwitch(deps, "not-a-quota-request", "Codex")).toBe(false);
  });
});
