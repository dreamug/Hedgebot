import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import { DomainError } from "./domain.js";
import { writePrivateJson } from "./files.js";

export const ProviderSchema = z.enum(["deepseek", "grok"]);
export type ModelProvider = z.infer<typeof ProviderSchema>;
export function providerForModel(model: string): ModelProvider {
  return model.startsWith("grok-") ? "grok" : "deepseek";
}

export const ApiKeySchema = z
  .string()
  .trim()
  .min(1)
  .max(4096)
  .regex(/^[\x21-\x7e]+$/, "API Key 不能包含空格、换行或非 ASCII 字符");
const KeysSchema = z
  .object({
    deepseek: ApiKeySchema.optional(),
    grok: ApiKeySchema.optional(),
    fishAudio: ApiKeySchema.optional(),
  })
  .strict();

/** Secrets live outside SQLite, exports, traces and database backups. */
export class ModelCredentials {
  readonly path: string;
  constructor(private readonly config: AppConfig) {
    this.path = join(config.dataDir, "model-keys.json");
  }
  private read(): z.infer<typeof KeysSchema> {
    if (!existsSync(this.path)) return {};
    try {
      return KeysSchema.parse(JSON.parse(readFileSync(this.path, "utf8")));
    } catch {
      throw new DomainError("model_credentials_invalid", 500);
    }
  }
  key(provider: ModelProvider): string | undefined {
    return this.read()[provider] ?? this.environmentKey(provider);
  }
  private environmentKey(provider: ModelProvider) {
    return provider === "grok" ? this.config.grokApiKey : this.config.apiKey;
  }
  status(provider: ModelProvider) {
    const byok = Boolean(this.read()[provider]);
    const configured = byok || Boolean(this.environmentKey(provider));
    return {
      configured,
      source: byok ? "byok" : configured ? "environment" : "missing",
      hasByok: byok,
    };
  }
  fishAudioKey(): string | undefined {
    return this.read().fishAudio ?? this.config.fishAudioApiKey;
  }
  petSetupStatus() {
    const keys = this.read();
    return {
      ready: Boolean(keys.deepseek && keys.fishAudio),
      deepseekConfigured: Boolean(keys.deepseek),
      fishAudioConfigured: Boolean(keys.fishAudio),
    };
  }
  savePetKeys(deepseek?: string, fishAudio?: string) {
    // Both services are committed in one private-file replacement. Never store
    // these secrets in the conversation, database, exports or browser storage.
    const previous = this.read();
    if (!(deepseek || previous.deepseek) || !(fishAudio || previous.fishAudio))
      throw new DomainError("pet_both_keys_required", 400);
    const keys = {
      ...previous,
      deepseek: ApiKeySchema.parse(deepseek || previous.deepseek),
      fishAudio: ApiKeySchema.parse(fishAudio || previous.fishAudio),
    };
    writePrivateJson(this.path, keys);
    return this.petSetupStatus();
  }
  save(provider: ModelProvider, key: string) {
    const keys = this.read();
    keys[provider] = ApiKeySchema.parse(key);
    writePrivateJson(this.path, keys);
    return this.status(provider);
  }
  remove(provider: ModelProvider) {
    const keys = this.read();
    delete keys[provider];
    writePrivateJson(this.path, keys);
    return this.status(provider);
  }
}
