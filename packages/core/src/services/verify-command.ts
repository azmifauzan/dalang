function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Verify commands run inside the task worktree, but agents sometimes write the project's absolute path
 * (`cd /abs/project && ...`), which would check the user's real checkout instead. Rewrite it to relative paths.
 */
export function localizeVerifyCommand(
  command: string,
  projectPath: string,
): string {
  const root = projectPath.replace(/[\\/]+$/, "");
  if (!root || !command.includes(root)) return command;
  const r = escapeRegExp(root);
  return command
    .replace(
      new RegExp(`(^|[;&|]\\s*)cd\\s+(["']?)${r}/?\\2\\s*(?:&&|;)\\s*`, "g"),
      "$1",
    )
    .replace(new RegExp(`${r}/`, "g"), "")
    .replace(new RegExp(`${r}(?![\\w.-])`, "g"), ".");
}
