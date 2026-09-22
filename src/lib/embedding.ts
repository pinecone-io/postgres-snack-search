// Shared by scripts/setupIndex.ts and embedSnackDocuments so a rebuilt
// document gets the same vector as the original. No imports, so the setup
// script can load it without `@/lib/env`.

export const EMBED_MODEL = "llama-text-embed-v2";
export const EMBED_DIMENSION = 1024;
// The model's documented max_batch_size per /embed call.
export const EMBED_BATCH_SIZE = 96;

export const PASSAGE_PARAMETERS = { inputType: "passage", truncate: "END" } as const;

// "name. text" so one vector carries both signals, the same pairing the
// BM25 side searches across two fields.
export function passageText(snack: { name: string; text: string }): string {
  return `${snack.name}. ${snack.text}`;
}
