import type { AppSettings, ProviderId } from "./types";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /** what an API key from this provider looks like, shown as placeholder */
  keyPlaceholder: string;
  defaultModel: string;
}

export const PROVIDERS: ProviderInfo[] = [
  {
    id: "anthropic",
    label: "Claude",
    keyPlaceholder: "sk-ant-…",
    defaultModel: "claude-sonnet-5",
  },
  {
    id: "openai",
    label: "ChatGPT",
    keyPlaceholder: "sk-…",
    defaultModel: "gpt-4.1",
  },
  {
    id: "kimi",
    label: "Kimi",
    keyPlaceholder: "sk-…",
    defaultModel: "kimi-latest",
  },
];

export function providerInfo(id: ProviderId | undefined): ProviderInfo {
  return PROVIDERS.find((p) => p.id === id) ?? PROVIDERS[0];
}

/** Mirrors the backend: per-provider model, legacy flat key for Claude only. */
export function modelFor(settings: AppSettings | null, id: ProviderId): string {
  const info = providerInfo(id);
  const chosen =
    settings?.models?.[id] ?? (id === "anthropic" ? settings?.model : undefined);
  return chosen?.trim() || info.defaultModel;
}
