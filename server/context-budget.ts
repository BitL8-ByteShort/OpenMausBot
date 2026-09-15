// Context budget (docs/superpowers/specs/2026-09-15-phase-1-long-threads-design.md).
//
// How much context a thread may carry before the harness compacts it, and
// whether the last turn crossed that line. The size is the input tokens the
// engine reported for the last turn (Phase 0 books them per task); only an
// engine that reports nothing falls back to a byte estimate. The window and
// the share-of-window rule are lifted from #759 (closed): a share rather
// than a subtraction keeps an 8k local model above water, and an unknown
// model is assumed mid-sized rather than frontier — over-estimating a window
// overflows, under-estimating only compacts earlier.
import type { ModelCatalog } from "./contracts.ts";

export const DEFAULT_CONTEXT_WINDOW = 128_000;
export const DEFAULT_COMPACT_SHARE = 0.6;
export const COMPACT_FLOOR = 8_000;

/** Pattern table over the model id for the engines OpenMausBot ships with;
 * a catalog-declared window always wins. */
const WINDOWS: Array<[RegExp, number]> = [
  [/gemini/i, 1_000_000],
  [/claude/i, 200_000],
  [/^(gpt-5|o[34]|codex)/i, 200_000],
  [/^gpt-4\.1/i, 1_000_000],
  [/^gpt-4o/i, 128_000],
  [/grok-4/i, 256_000],
  [/grok/i, 128_000],
  [/kimi|moonshot/i, 128_000],
  [/minimax/i, 200_000],
  [/qwen|deepseek|llama|mistral|gemma|phi/i, 32_000],
];

export interface ContextWindow {
  contextWindow: number;
  source: "forced" | "catalog" | "pattern" | "default";
}

export function contextWindowFor(modelId: string | undefined, catalog?: ModelCatalog): ContextWindow {
  const forced = Number(process.env.OMB_CONTEXT_WINDOW) || 0;
  if (forced > 0) return { contextWindow: forced, source: "forced" };
  if (!modelId) return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "default" };
  const declared = catalog?.options.find((option) => option.id === modelId)?.contextWindow;
  if (declared) return { contextWindow: declared, source: "catalog" };
  // injected local models carry the host in the id; match the model part too
  const bare = modelId.split("/").pop() ?? modelId;
  for (const [pattern, size] of WINDOWS) {
    if (pattern.test(modelId) || pattern.test(bare)) return { contextWindow: size, source: "pattern" };
  }
  return { contextWindow: DEFAULT_CONTEXT_WINDOW, source: "default" };
}

/** `compactAt` below 1 is a share of the window; at or above 1 it is an
 * absolute token count. Never under the floor. */
export function compactBudget(compactAt: number | undefined, contextWindow: number): number {
  const raw = compactAt === undefined ? contextWindow * DEFAULT_COMPACT_SHARE
    : compactAt < 1 ? contextWindow * compactAt
    : compactAt;
  return Math.max(COMPACT_FLOOR, Math.floor(raw));
}

/** ~4 bytes per token: a fallback for engines that report no usage. */
export function estimateTokens(bytes: number): number {
  return Math.ceil(bytes / 4);
}

export function shouldCompact(input: { lastInput?: number; estimatedTokens: number; budget: number }): boolean {
  const size = input.lastInput && input.lastInput > 0 ? input.lastInput : input.estimatedTokens;
  return size >= input.budget;
}
