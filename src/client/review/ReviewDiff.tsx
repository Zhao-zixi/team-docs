import { useMemo } from "react";

function compactDiff(before: string, after: string) {
  const oldLines = before.split("\n");
  const newLines = after.split("\n");
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  return {
    prefix: oldLines.slice(0, prefix),
    removed: oldLines.slice(prefix, oldLines.length - suffix),
    added: newLines.slice(prefix, newLines.length - suffix),
    suffix: suffix ? oldLines.slice(oldLines.length - suffix) : [],
  };
}

export function ReviewDiff({ before, after, beforeLabel, afterLabel }: { before: string; after: string; beforeLabel: string; afterLabel: string }) {
  const diff = useMemo(() => compactDiff(before, after), [before, after]);
  const cap = 100;
  const lines = (values: string[], kind: "same" | "removed" | "added") => <>{values.slice(0, cap).map((line, index) => <span className={`review-diff-line ${kind}`} key={`${index}-${line}`}>{line || " "}</span>)}{values.length > cap && <span className="review-diff-more">另有 {values.length - cap} 行未展开</span>}</>;
  return <div className="review-diff" aria-label="提案差异">
    <div className="review-diff-column"><strong>{beforeLabel}</strong><pre>{lines(diff.prefix, "same")}{lines(diff.removed, "removed")}{lines(diff.suffix, "same")}</pre></div>
    <div className="review-diff-column"><strong>{afterLabel}</strong><pre>{lines(diff.prefix, "same")}{lines(diff.added, "added")}{lines(diff.suffix, "same")}</pre></div>
  </div>;
}