# Compaction

## Why Relay Compaction Exists

Long-running agents frequently need more than naive truncation. When you simply drop old messages, the model loses:

- why the task exists
- what has already been decided
- which constraints are non-negotiable
- what evidence has already been gathered

Relay compaction preserves that continuity in a structured summary.

## Trigger Types

`createAISDKCompactionPrepareStep()` can trigger compaction for four families of reasons:

- `token-soft`
- `token-hard`
- `token-emergency`
- `message-count`
- `large-tool-result`
- `periodic`

## Default Thresholds

Defaults are tuned to be conservative:

- `tokenSoftRatio: 0.32`
- `tokenHardRatio: 0.45`
- `tokenEmergencyRatio: 0.6`
- `messageCountCompactThreshold: 18`
- `largeToolResultChars: 4000`
- `minStepsBetweenCompaction: 2`
- `periodicInterval: 4`
- `hardMessageWindow: 14`
- `emergencyMessageWindow: 10`

## Summary Generation

If you provide a model, `RelayCompactor` will try to generate a structured relay summary with these sections:

- `[Task]`
- `[Decisions]`
- `[Constraints]`
- `[Open Questions]`
- `[Key Evidence]`
- `[Next Actions]`

If LLM summarization fails, the compactor falls back to a deterministic rule-based summary that extracts signals from prior history.

## Output Shape

`compact()` returns:

- `finalMessages`
- `nextState`
- `summaryGenerated`
- `usedFallbackSummary`
- `summaryTokens`
- `historyTokens`
- `retainedMessageCount`

## Tuning Advice

Raise thresholds when:

- you have cheaper models and want more verbatim history
- you mostly run short tool outputs

Lower thresholds when:

- tool payloads are large
- models have smaller context windows
- you prioritize latency and cost stability over longer raw history

## Important Distinction

Compaction is not memory extraction.

- Compaction protects short-term execution continuity.
- Structured memory protects durable facts and decisions.

A robust agent system usually needs both.
