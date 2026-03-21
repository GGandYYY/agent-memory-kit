# Preset Design

## Why Presets Exist

The core engine is intentionally generic. Presets provide domain-oriented sentence classification and slot-policy defaults without coupling the engine to a single business workflow.

## Included Presets

### `genericPreset`

Best for:

- demos
- general assistants
- code copilots with lightweight memory needs

It recognizes broad categories such as:

- facts
- decisions
- constraints
- preferences
- questions

### `platformPreset`

Best for:

- infrastructure assistants
- internal platform agents
- DevOps or architecture planning flows

It adds richer slot policies around:

- cloud provider
- database
- identity provider
- MFA posture
- repository platform
- monitoring stack
- incident process

## Writing Your Own Preset

A preset only needs two things:

1. `slotPolicies`
2. `classifySentence(sentence)`

Optional:

- `summarizeEpisode(messages)`

Example skeleton:

```ts
import type { MemoryPreset } from "agent-memory-kit";

export const productPreset: MemoryPreset = {
  name: "product",
  slotPolicies: {
    "product.decision": { cardinality: "multi", ttlDays: 365 },
  },
  classifySentence(sentence) {
    if (/roadmap|milestone|launch/i.test(sentence)) {
      return {
        slotKey: "product.decision",
        memoryType: "DECISION",
        confidence: 0.7,
        importance: 0.7,
        weight: 0.6,
        isPinned: false,
        ttlDays: 365,
        overrideSignal: false,
      };
    }
    return null;
  },
};
```

## Guidance

- keep slot names stable over time
- reserve single-value slots for truly canonical facts
- use high-risk single slots when overwrites should remain user-visible
- prefer app-local presets over expanding the default package presets indefinitely
