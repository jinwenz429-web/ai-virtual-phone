import assert from "node:assert/strict";
import test from "node:test";

import { resolveEnabledGenerationParameters } from "../lib/generation-parameters.ts";

function sortedParameters(preset) {
    return [...resolveEnabledGenerationParameters(preset)].sort();
}

test("preset=null uses the portable sampling baseline", () => {
    assert.deepEqual(sortedParameters(null), [
        "temperature",
        "top_p",
    ]);
});

test("legacy presets retain their historical generation parameters", () => {
    const legacyPreset = {
        temperature: 0.8,
        top_p: 1,
        top_k: 40,
        min_p: 0.05,
        top_a: 0.1,
        repetition_penalty: 1.1,
        frequency_penalty: 0,
        presence_penalty: 0,
        openai_max_tokens: 4096,
    };

    assert.deepEqual(sortedParameters(legacyPreset), [
        "frequency_penalty",
        "max_tokens",
        "min_p",
        "presence_penalty",
        "repetition_penalty",
        "temperature",
        "top_a",
        "top_k",
        "top_p",
    ]);
});

test("explicit generation parameter allow-lists remain authoritative", () => {
    const preset = {
        temperature: 0.8,
        top_p: 1,
        top_k: 40,
        min_p: 0.05,
        top_a: 0.1,
        repetition_penalty: 1.1,
        frequency_penalty: 0.4,
        presence_penalty: 0.2,
        openai_max_tokens: 4096,
        enabled_generation_parameters: [
            "temperature",
            "frequency_penalty",
            "presence_penalty",
        ],
    };

    assert.deepEqual(sortedParameters(preset), [
        "frequency_penalty",
        "presence_penalty",
        "temperature",
    ]);
});
