export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export interface ShownFile {
  path: string;
  exists: boolean;
  size?: number;
  summary?: string | null;
}

export interface Preview {
  kind: "text" | "image" | "pdf" | "other";
  path: string;
  name?: string;
  size: number;
  mtime?: number;
  text?: string;
  summary?: string | null;
}

export interface AppSettings {
  lang: "en" | "es";
  roots: string[];
  model: string;
  [k: string]: unknown;
}

export interface IndexStatus {
  exists: boolean;
  roots?: string[];
  built_at?: number;
  files?: number;
}
