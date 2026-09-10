import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { win32, posix } from "node:path";

export function tokenPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
): string {
  if (env.UIGREP_TOKEN_PATH) return env.UIGREP_TOKEN_PATH;
  const paths = platform === "win32" ? win32 : posix;
  const base =
    platform === "win32"
      ? env.APPDATA || paths.join(home, "AppData", "Roaming")
      : platform === "darwin"
        ? paths.join(home, "Library", "Application Support")
        : env.XDG_CONFIG_HOME || paths.join(home, ".config");
  return paths.join(base, "dev.uigrep.app", "token");
}

export async function loadToken(): Promise<string> {
  const supplied = process.env.UIGREP_TOKEN?.trim();
  if (supplied) return supplied;
  try {
    const value = (await readFile(tokenPath(), "utf8")).trim();
    if (value) return value;
  } catch {
    // Never print token contents or environment values.
  }
  throw new Error(
    "Open uigrep desktop first to create its local authentication token.",
  );
}
