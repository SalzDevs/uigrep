import { readFile } from "node:fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadToken, tokenPath } from "./token.js";

// Never read a developer's real token, even when these tests fail.
vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.mocked(readFile).mockReset();
});

describe("tokenPath", () => {
  it("uses Windows roaming app data and the desktop application identifier", () => {
    expect(
      tokenPath("win32", { APPDATA: "C:\\Users\\test\\Roaming" }, "C:\\home"),
    ).toBe("C:\\Users\\test\\Roaming\\dev.uigrep.app\\token");
  });

  it("falls back to the Windows home directory without APPDATA", () => {
    for (const env of [{}, { APPDATA: "" }]) {
      expect(tokenPath("win32", env, "C:\\Users\\test")).toBe(
        "C:\\Users\\test\\AppData\\Roaming\\dev.uigrep.app\\token",
      );
    }
  });

  it("uses macOS Application Support rather than XDG or Windows settings", () => {
    expect(
      tokenPath(
        "darwin",
        { XDG_CONFIG_HOME: "/ignored", APPDATA: "C:\\ignored" },
        "/Users/test",
      ),
    ).toBe("/Users/test/Library/Application Support/dev.uigrep.app/token");
  });

  it("uses the Linux XDG config directory", () => {
    expect(
      tokenPath("linux", { XDG_CONFIG_HOME: "/custom/config" }, "/home/test"),
    ).toBe("/custom/config/dev.uigrep.app/token");
  });

  it("falls back to ~/.config when XDG_CONFIG_HOME is unset or empty", () => {
    for (const env of [{}, { XDG_CONFIG_HOME: "" }]) {
      expect(tokenPath("linux", env, "/home/test")).toBe(
        "/home/test/.config/dev.uigrep.app/token",
      );
    }
  });

  it.each(["win32", "darwin", "linux"] as const)(
    "preserves an explicit path verbatim on %s",
    (platform) => {
      expect(
        tokenPath(platform, { UIGREP_TOKEN_PATH: "relative/test-token" }),
      ).toBe("relative/test-token");
    },
  );

  it("ignores an empty path override", () => {
    expect(tokenPath("linux", { UIGREP_TOKEN_PATH: "" }, "/home/test")).toBe(
      "/home/test/.config/dev.uigrep.app/token",
    );
  });
});

describe("loadToken", () => {
  beforeEach(() => {
    vi.stubEnv("UIGREP_TOKEN", "");
    vi.stubEnv("UIGREP_TOKEN_PATH", "test-only-token-file");
  });

  it("prefers a trimmed environment token without accessing disk", async () => {
    vi.stubEnv("UIGREP_TOKEN", "  fake-environment-token\r\n");
    await expect(loadToken()).resolves.toBe("fake-environment-token");
    expect(readFile).not.toHaveBeenCalled();
  });

  it.each([undefined, "", " \r\n\t "])(
    "reads and trims the file when the environment token is %j",
    async (value) => {
      vi.stubEnv("UIGREP_TOKEN", value);
      vi.mocked(readFile).mockResolvedValue("  fake-file-token\r\n");
      await expect(loadToken()).resolves.toBe("fake-file-token");
      expect(readFile).toHaveBeenCalledExactlyOnceWith(
        "test-only-token-file",
        "utf8",
      );
    },
  );

  it.each(["", " \r\n\t "])("rejects an empty token file %j", async (value) => {
    vi.mocked(readFile).mockResolvedValue(value);
    await expect(loadToken()).rejects.toThrow(
      "Open uigrep desktop first to create its local authentication token.",
    );
  });

  it("replaces filesystem errors with a safe onboarding message", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.mocked(readFile).mockRejectedValue(
      new Error("EACCES: fake-sensitive-path-and-token"),
    );

    await expect(loadToken()).rejects.toThrow(
      /^Open uigrep desktop first to create its local authentication token\.$/,
    );
    expect(log).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });
});
