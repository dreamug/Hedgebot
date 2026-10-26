import { setTimeout as delay } from "node:timers/promises";
import { MockModel, type ModelRequest, type ModelEvent } from "../model.js";

/** Desktop-only deterministic fixture; never used for a live provider. */
export class PetMockModel extends MockModel {
  override async *stream(request: ModelRequest): AsyncGenerator<ModelEvent> {
    let text: string;
    if (request.purpose === "extract")
      text = JSON.stringify({ intent: "none", items: [] });
    else if (request.purpose === "judge") {
      let data: {
        task?: string;
        contractPart?: string;
        mentions?: { id: number }[];
      } = {};
      try {
        data = JSON.parse(request.messages[0]?.content ?? "{}");
      } catch {}
      text = JSON.stringify(
        data.task === "naming_references"
          ? {
              references: (data.mentions ?? []).map((m) => ({
                id: m.id,
                bearer: "other",
                use: "not_name",
              })),
            }
          : data.contractPart === "operations"
            ? { checks: [], requiredAction: "none", userEvidence: null }
            : { checks: [] },
      );
    } else
      text =
        "[本地模拟] 我在这儿，陪你一起慢慢来。正式聊天会使用你配置的模型。";
    for (const chunk of text.match(/.{1,12}/gs) ?? []) {
      if (this.delayMs)
        await delay(this.delayMs, undefined, { signal: request.signal });
      request.signal.throwIfAborted();
      yield { type: "text", text: chunk };
    }
    yield {
      type: "finish",
      reason: "stop",
      usage: {
        calls: 1,
        estimated: true,
        inputTokens: 30,
        outputTokens: text.length,
        totalTokens: 30 + text.length,
      },
    };
  }
}
