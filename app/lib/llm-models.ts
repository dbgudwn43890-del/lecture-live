export const personalModelOptions = {
  openai: [
    { id: "gpt-5.6-sol", label: "GPT-5.6 Sol" },
    { id: "gpt-5.6-terra", label: "GPT-5.6 Terra" },
  ],
  anthropic: [
    { id: "claude-fable-5", label: "Claude Fable 5" },
    { id: "claude-opus-5", label: "Claude Opus 5" },
    { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  ],
  google: [
    { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro (Preview)" },
    { id: "gemini-3.7-flash", label: "Gemini 3.7 Flash" },
    { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" },
  ],
} as const;

export type PersonalProvider = keyof typeof personalModelOptions;

export function isPersonalProvider(value: unknown): value is PersonalProvider {
  return value === "openai" || value === "anthropic" || value === "google";
}

export function isAllowedPersonalModel(provider: PersonalProvider, model: string) {
  return personalModelOptions[provider].some((option) => option.id === model);
}
