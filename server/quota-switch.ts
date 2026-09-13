// Quota-switch card: when a bot's provider quota runs out mid-conversation,
// offer to continue the same thread on another configured engine instead of
// leaving the person to notice, change the model by hand, and start the new
// engine cold.
//
// Follows the harness-native card pattern from peer-approval.ts: a card
// pushed straight into the bot's own thread, tracked by requestId in an
// in-memory pending map, and settled through the same respond-endpoint
// intercept peer comms uses — so nothing front-end has to learn a new card
// shape. This card carries no `tool`, so the client treats it like a
// question (src/lib/card-answer.ts): the option label the user pressed comes
// back verbatim as `message`, with `behavior: "answer"`. That is exactly
// what lets a card with more than an allow/deny answer carry an engine name.
import { newId } from "./contracts.ts";
import type { EffortLevel, ModelCatalog, ModelSelection, ProviderSnapshot } from "./contracts.ts";
import { selectDefaultModelSelection } from "./default-model-selection.ts";
import { classifyError } from "./drivers/retry.ts";
import type { BotRecord, Message, Store } from "./store.ts";

/** What quota-switch needs from a provider instance — a narrow, structural
 * slice of ProviderInstance (mirrors default-model-selection.ts's own
 * SelectableInstance) so tests can hand it plain fakes instead of standing
 * up the real registry. */
export interface QuotaSwitchInstance {
  instanceId: string;
  driverKind: string;
  displayName?: string;
  models: ModelCatalog;
  adapter: { capabilities: { effortLevels?: readonly EffortLevel[] } };
  snapshot: () => Promise<ProviderSnapshot>;
}

/** What quota-switch needs from the outside world. `dispatch` is the one
 * side effect server/index.ts owns that this module cannot: actually
 * launching a turn (server/index.ts's startTurn, with all its admission and
 * lifecycle bookkeeping). Everything else here is store reads/writes. */
export interface QuotaSwitchDeps {
  store: Store;
  /** Every engine currently configured for this workspace (registry.instances()). */
  instances: () => QuotaSwitchInstance[];
  /** Re-dispatch the turn that failed, on the bot's now-switched engine. */
  dispatch: (botId: string, threadId: string, text: string) => void;
}

const MAX_ALTERNATIVES = 3;
const NOT_NOW = "Not now";

interface PendingQuotaCard {
  threadId: string;
  messageId: string;
  botId: string;
  /** the options offered, in the order shown on the card — matched back
   * against the label the user pressed (the card carries no `tool`, so the
   * wire answer is the label text itself, never an instanceId). */
  alternatives: Array<{ instanceId: string; displayName: string }>;
}

/** requestId → pending quota-switch offer. In memory only, like peer
 * comms — a restart cancels every in-flight offer along with everything
 * else a live turn was holding. */
const pendingQuotaCards = new Map<string, PendingQuotaCard>();
/** threadId → requestId, so at most one quota card is ever pending per
 * thread — a bot that keeps hitting quota must not stack offers. */
const pendingQuotaThreadIds = new Map<string, string>();

function displayNameOf(instance: QuotaSwitchInstance): string {
  return instance.displayName ?? instance.driverKind;
}

/** Raise a quota-switch card in `bot`'s thread, offering the other engines
 * this workspace has configured, when `errorMessage` classifies as a quota
 * failure (server/drivers/retry.ts's classifyError — the same terminal
 * reason a driver's own retry policy already recognizes as unretryable).
 * Returns the card message, or null when the error was not a quota error,
 * there is nothing to offer (no alternatives), or a card is already pending
 * on this thread — a caller never has to check any of that itself. */
export function maybeRaiseQuotaCard(deps: QuotaSwitchDeps, bot: BotRecord, threadId: string, errorMessage: string): Message | null {
  if (classifyError({ text: errorMessage }).reason !== "quota") return null;
  if (pendingQuotaThreadIds.has(threadId)) return null;
  const instances = deps.instances();
  const currentInstanceId = bot.modelSelection.instanceId;
  const alternatives = instances
    .filter((instance) => instance.instanceId !== currentInstanceId)
    .slice(0, MAX_ALTERNATIVES)
    .map((instance) => ({ instanceId: instance.instanceId, displayName: displayNameOf(instance) }));
  if (alternatives.length === 0) return null;
  const current = instances.find((instance) => instance.instanceId === currentInstanceId);
  const currentName = current ? displayNameOf(current) : "This engine";
  const requestId = newId();
  const card = deps.store.appendMessage(threadId, {
    role: "bot",
    kind: "options",
    card: {
      title: `${currentName} is out of quota`,
      subtitle: "Continue this conversation on another engine?",
      options: [...alternatives.map((alt) => alt.displayName), NOT_NOW],
      requestId,
    },
  });
  pendingQuotaCards.set(requestId, { threadId, messageId: card.id, botId: bot.id, alternatives });
  pendingQuotaThreadIds.set(threadId, requestId);
  return card;
}

/** Mark the card answered so the UI stops treating it as pending — the same
 * hand-back peer-approval's settleCard does. `answered` stays the generic
 * "answer" verdict and `answeredText` carries the actual words, matching how
 * every other question-shaped card (no `tool`) remembers its reply — see
 * server/index.ts's answerRequest, which does the same for provider asks. */
function settleQuotaCard(store: Store, pending: PendingQuotaCard, chosenText: string): void {
  const existing = store.messagesFor(pending.threadId).find((m) => m.id === pending.messageId);
  if (!existing?.card || existing.card.answered) return;
  store.patchMessage(pending.threadId, pending.messageId, {
    card: { ...existing.card, answered: "answer", answeredText: chosenText },
  });
}

/** Pick a valid model for `instance`, reusing the exact same logic new bots
 * get their default model from (server/default-model-selection.ts) instead
 * of inventing a second "what's a safe model for this engine" rule. Handing
 * it only this one instance means it either returns that instance with its
 * default model, or — if the instance is no longer available — the empty
 * selection selectDefaultModelSelection uses to say "nothing to offer". */
async function pickSelection(instance: QuotaSwitchInstance): Promise<ModelSelection> {
  const snapshot = await instance.snapshot();
  return selectDefaultModelSelection([
    {
      instanceId: instance.instanceId,
      driverKind: instance.driverKind,
      snapshot,
      models: instance.models,
      capabilities: { effortLevels: instance.adapter.capabilities.effortLevels },
    },
  ]);
}

/** Switch the bot onto `chosen` and re-dispatch the turn that failed. Runs
 * after the card is already settled, so a slow snapshot() never leaves the
 * card looking pending. */
async function switchAndRedispatch(
  deps: QuotaSwitchDeps,
  pending: PendingQuotaCard,
  chosen: { instanceId: string; displayName: string },
): Promise<void> {
  const instance = deps.instances().find((candidate) => candidate.instanceId === chosen.instanceId);
  if (!instance) return; // configured a moment ago; gone now — nothing to switch to
  const selection = await pickSelection(instance);
  if (!selection.instanceId) return; // no longer available — no valid model to switch to
  deps.store.patchBot(pending.botId, { modelSelection: selection });
  deps.store.patchTask(pending.botId, pending.threadId, { modelSelection: selection });
  deps.store.appendMessage(pending.threadId, {
    role: "bot",
    kind: "activity",
    tool: { name: `continuing on ${chosen.displayName} after hitting quota`, ok: true },
  });
  const lastUserMessage = [...deps.store.activePath(pending.threadId)]
    .reverse()
    .find((m) => m.role === "user" && m.kind === "text" && m.text);
  if (lastUserMessage?.text) deps.dispatch(pending.botId, pending.threadId, lastUserMessage.text);
}

/** Called by the respond endpoints BEFORE forwarding to the provider
 * adapter, exactly where resolvePeerComms is (server/index.ts). Returns
 * true if the requestId belonged to a pending quota offer (and resolves
 * it); false if it was someone else's card and the endpoint should keep
 * looking. The switch + re-dispatch happen after returning — this stays
 * synchronous so it slots into the same `if (... && resolveX(...))` chain
 * resolvePeerComms already sits in. */
export function resolveQuotaSwitch(deps: QuotaSwitchDeps, requestId: string, message: string | undefined): boolean {
  const pending = pendingQuotaCards.get(requestId);
  if (!pending) return false;
  pendingQuotaCards.delete(requestId);
  if (pendingQuotaThreadIds.get(pending.threadId) === requestId) pendingQuotaThreadIds.delete(pending.threadId);
  const chosen = pending.alternatives.find((alt) => alt.displayName === message);
  settleQuotaCard(deps.store, pending, chosen ? chosen.displayName : NOT_NOW);
  if (chosen) void switchAndRedispatch(deps, pending, chosen);
  return true;
}
