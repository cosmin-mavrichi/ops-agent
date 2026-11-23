import type Anthropic from "@anthropic-ai/sdk";

/** Dollars per million tokens. */
interface Price {
  readonly input: number;
  readonly output: number;
  /** Defaults to Anthropic's: cache writes cost 1.25x input, cache reads 0.1x. */
  readonly cacheWrite?: number;
  readonly cacheRead?: number;
  /** Haiku 5.5 charges more for a request whose prompt is over 100K tokens. */
  readonly longPrompt?: { readonly overTokens: number; readonly input: number; readonly output: number };
}

const PRICES: Readonly<Record<string, Price>> = {
  // Anthropic price list, 2026-11.
  "claude-haiku-5-5": { input: 0.1, output: 0.5, longPrompt: { overTokens: 100_000, input: 0.5, output: 2.5 } },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-opus-5-5": { input: 4, output: 20 },
  // DeepSeek price list, 2026-11, at peak rates (off-peak is half): an upper bound. No cache-write premium.
  "deepseek-flash": { input: 0.3, output: 1.2, cacheWrite: 0.3, cacheRead: 0.006 },
};

const CACHE_WRITE_FACTOR = 1.25;
const CACHE_READ_FACTOR = 0.1;
const PER_TOKEN = 1 / 1_000_000;

/** The cost of one response, from the model asked for and the usage it reports. */
export function costOf(model: string, usage: Anthropic.Usage): number {
  const price = PRICES[model];
  if (price === undefined) throw new Error(`no price for model ${model}; add it to packages/watcher/src/pricing.ts`);

  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const promptTokens = usage.input_tokens + cacheRead + cacheWrite;
  const long = price.longPrompt && promptTokens > price.longPrompt.overTokens ? price.longPrompt : undefined;
  const input = long?.input ?? price.input;
  const output = long?.output ?? price.output;
  const cacheWriteRate = price.cacheWrite ?? input * CACHE_WRITE_FACTOR;
  const cacheReadRate = price.cacheRead ?? input * CACHE_READ_FACTOR;

  const dollars =
    usage.input_tokens * input + cacheWrite * cacheWriteRate + cacheRead * cacheReadRate + usage.output_tokens * output;
  return dollars * PER_TOKEN;
}
