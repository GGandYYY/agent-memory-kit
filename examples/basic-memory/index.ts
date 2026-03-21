import { InMemoryStore } from "../../src/stores/in-memory-store";
import { StructuredMemoryEngine } from "../../src/core/memory-engine";
import { genericPreset } from "../../src/presets/generic";
import type { ScopeRef } from "../../src/types";

function textMessage(id: string, role: "user" | "assistant", text: string) {
  return {
    id,
    role,
    parts: [{ type: "text", text }],
  } as const;
}

export async function runBasicMemoryExample() {
  const store = new InMemoryStore();
  const engine = new StructuredMemoryEngine(store, {
    preset: genericPreset,
  });
  const scope: ScopeRef = {
    tenantId: "tenant-demo",
    scopeId: "scope-demo",
    namespace: "basic-memory",
  };

  await engine.processTurn({
    ...scope,
    messages: [
      textMessage("m1", "user", "We will deploy the worker runtime with Bun."),
      textMessage("m2", "user", "We must keep tenant isolation strict across all tools."),
      textMessage("m3", "assistant", "I will remember Bun as the runtime and tenant isolation as a hard constraint."),
    ],
  });

  return engine.buildContext({
    ...scope,
    modelId: "openai:gpt-4o-mini",
    systemPrompt: "You are a reliable coding agent.",
    modelMessages: [
      {
        role: "user",
        content: "What runtime and non-negotiable constraints have we already established?",
      },
    ],
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runBasicMemoryExample().then((result) => {
    console.log(result.memoryPrompt);
  });
}
