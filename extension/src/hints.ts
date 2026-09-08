/**
 * Framework hints — probe well-known globals. Cheap, best-effort.
 * Decision 4: presence booleans + versions when exposed.
 */

import type { FrameworkHints } from "@uigrep/schema";

declare global {
  interface Window {
    __NEXT_DATA__?: unknown;
    __NUXT__?: unknown;
    __remixContext?: unknown;
  }
}

interface ReactRoot extends HTMLElement {
  _reactRootContainer?: unknown;
  _reactListening?: unknown;
}

interface VueApp extends HTMLElement {
  __vue_app__?: { version?: string };
}

interface NgElement extends HTMLElement {
  __ngContext__?: unknown;
}

export function detectFrameworkHints(): FrameworkHints {
  const body = document.body as HTMLElement;
  const anyWindow = window as unknown as {
    React?: { version?: string };
    Vue?: { version?: string };
  };

  const react =
    !!document.querySelector<ReactRoot>("[data-reactroot]") ||
    Object.keys(body).some((k) => k.startsWith("_reactListening")) ||
    !!document.querySelector<ReactRoot>("#__next, [id^='__react']");

  const vueApp = document.querySelector<VueApp>("[data-v-app]");
  const vue = !!vueApp?.__vue_app__ || "Vue" in anyWindow;

  const svelte = !!document.body.innerHTML.match(/class="[^"]*svelte-/);

  const angularEl = document.querySelector<NgElement>("[ng-version], app-root");
  const angular = !!angularEl;
  const angularVersion =
    document.querySelector("[ng-version]")?.getAttribute("ng-version") ?? undefined;

  let metaFramework: string | undefined;
  if (window.__NEXT_DATA__) metaFramework = "next";
  else if (window.__NUXT__) metaFramework = "nuxt";
  else if (window.__remixContext) metaFramework = "remix";

  return {
    react,
    reactVersion: react ? anyWindow.React?.version : undefined,
    vue,
    vueVersion: vue && typeof anyWindow.Vue?.version === "string" ? anyWindow.Vue.version : undefined,
    svelte: !!svelte,
    angular: !!angularEl,
    angularVersion: angular && angularVersion ? angularVersion : undefined,
    metaFramework,
  };
}
