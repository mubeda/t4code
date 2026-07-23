import { collectComposerInlineTokens } from "./composerInlineTokens.ts";

const SIMPLE_MENTION_PATH_REGEX = /^[^\s@"\\]+$/;

export function serializeComposerMentionPath(path: string): string {
  if (SIMPLE_MENTION_PATH_REGEX.test(path)) {
    return path;
  }
  return `"${path.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function serializeComposerReference(value: string): string {
  return `@${serializeComposerMentionPath(value)}`;
}

export function canonicalizeLegacyComposerFileReferences(text: string): string {
  const legacy = collectComposerInlineTokens(text).filter(
    (token) => token.type === "mention" && token.source.startsWith("["),
  );
  return legacy.reduceRight(
    (current, token) =>
      `${current.slice(0, token.start)}${serializeComposerReference(token.value)}${current.slice(token.end)}`,
    text,
  );
}
