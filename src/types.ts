export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  shown?: ShownFile[];
}

export interface ShownFile {
  path: string;
  exists: boolean;
  size?: number;
  summary?: string | null;
}

export interface DocBlock {
  level: number; // 0 = body paragraph, 1..6 = heading depth
  text: string;
}

export interface Preview {
  kind: "text" | "image" | "pdf" | "other";
  path: string;
  name?: string;
  size: number;
  mtime?: number;
  text?: string;
  html?: string; // faithful rendered document (docx: formatting/tables/images)
  blocks?: DocBlock[];
  summary?: string | null;
}

export interface AppSettings {
  lang: "en" | "es" | "fr";
  roots: string[];
  model: string;
  [k: string]: unknown;
}

export interface IndexStatus {
  exists: boolean;
  roots?: string[];
  built_at?: number;
  files?: number;
  /** files left out of the index entirely (hidden, or a secret-ish name) */
  skipped_sensitive?: number;
  /** files indexed by name only, because their content matched a secret pattern */
  secret_files?: number;
}
