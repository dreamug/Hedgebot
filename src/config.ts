import { z } from "zod";
import { config as dotenv } from "dotenv";
import { resolve } from "node:path";
import { mkdirSync, chmodSync, readFileSync } from "node:fs";

export type AppConfig = {
  /** Requires an explicitly migrated schema3 store, or a genuinely new empty store. */
  memoryV3?: boolean;
  /** Accepted CM3-3 fast path; selected explicitly by the stable entry point. */
  memoryFastPath?: boolean;
  /** Deadline for one complete publication-check batch; timeout never grants approval. */
  memoryReviewTimeoutMs?: number;
  /** Isolated conversation experiment only; the stable entry point forces it off. */
  conversationExperiment?: boolean;
  memoryV2?: boolean;
  memorySummaries?: boolean;
  memoryVectors?: boolean;
  /** Opt-in grounded answer profile; no embedding or schema changes. */
  memoryAnswerReasoning?: boolean;
  /** Optional isolated-trial facts reviewer. Chat and operation review keep the captured chat model. */
  memoryFactsModel?: string;
  /** Validate save commitments, read scope and delivered memory constraints before publication. */
  memoryReplyGuard?: boolean;
  memoryPython?: string;
  memoryModelPath?: string;
  trafficOrigin?: "natural" | "synthetic" | "unknown";
  dataDir: string;
  host: "127.0.0.1";
  port: number;
  apiKey?: string;
  baseURL: string;
  model: string;
  modelMode: "deepseek" | "grok" | "mock";
  grokApiKey?: string;
  grokBaseURL?: string;
  maxRunMs: number;
  maxOutputTokens: number;
  schedulerMs: number;
  sdkVersion?: string;
  fishAudioApiKey?: string;
  fishAudioBaseURL?: string;
  fishAudioModel?: string;
  fishAudioVoiceId?: string;
  fishAudioVoiceName?: string;
  transcriptionMode?: "fish" | "local";
  localAsrPython?: string;
  localAsrModel?: string;
  localAsrFfmpeg?: string;
};
export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  dotenv({ path: resolve("env.local"), quiet: true });
  const port = z
    .number()
    .int()
    .min(0)
    .max(65535)
    .parse(overrides.port ?? Number(process.env.PORT ?? 4317));
  const mode = z
    .enum(["deepseek", "grok", "mock"])
    .parse(overrides.modelMode ?? process.env.HARNESS_MODEL ?? "deepseek");
  const dataDir =
    overrides.dataDir ?? resolve(process.env.HARNESS_DATA_DIR ?? "data");
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  chmodSync(dataDir, 0o700);
  return {
    memorySummaries: process.env.HARNESS_MEMORY_SUMMARIES !== "0",
    memoryV2: process.env.HARNESS_MEMORY_V2 === "1",
    memoryVectors: process.env.HARNESS_MEMORY_VECTORS === "1",
    memoryAnswerReasoning: process.env.HARNESS_MEMORY_ANSWER_REASONING === "1",
    memoryReplyGuard: mode !== "mock",
    memoryPython: process.env.MEMORY_PYTHON,
    memoryModelPath: process.env.MEMORY_MODEL_PATH,
    trafficOrigin: z
      .enum(["natural", "synthetic", "unknown"])
      .parse(
        overrides.trafficOrigin ??
          process.env.HARNESS_TRAFFIC_ORIGIN ??
          (mode === "mock" ? "synthetic" : "unknown"),
      ),
    dataDir,
    host: "127.0.0.1",
    port,
    apiKey: process.env.DEEPSEEK_API_KEY,
    baseURL: process.env.DEEPSEEK_BASE_URL ?? "https://api.deepseek.com",
    model:
      mode === "grok"
        ? "grok-4.3"
        : (process.env.DEEPSEEK_MODEL ?? "deepseek-flash"),
    modelMode: mode,
    grokApiKey: process.env.XAI_API_KEY ?? process.env.GROK_API_KEY,
    grokBaseURL: process.env.XAI_BASE_URL ?? "https://api.x.ai/v1",
    maxRunMs: 60000,
    maxOutputTokens: 1500,
    schedulerMs: 2000,
    fishAudioApiKey: process.env.FISH_AUDIO_API_KEY,
    fishAudioBaseURL:
      process.env.FISH_AUDIO_BASE_URL ?? "https://api.fish.audio",
    fishAudioModel: process.env.FISH_AUDIO_MODEL ?? "s2.1-pro",
    fishAudioVoiceId:
      process.env.FISH_AUDIO_VOICE_ID ?? "5b50d7ae59f24c0cb447599df8ae34ab",
    transcriptionMode: z
      .enum(["fish", "local"])
      .parse(process.env.TRANSCRIPTION_MODE ?? "fish"),
    localAsrPython: process.env.LOCAL_ASR_PYTHON,
    localAsrModel: process.env.LOCAL_ASR_MODEL,
    localAsrFfmpeg: process.env.LOCAL_ASR_FFMPEG,
    ...overrides,
    sdkVersion: (
      JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { dependencies: { ai: string } }
    ).dependencies.ai,
  };
}
