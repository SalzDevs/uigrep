import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { canFinish, type AgentOption, type SetupStatus } from "./setup-state";
import "./setup.css";

type PhaseState = "done" | "active" | "waiting" | "error";
type Phase = { state: PhaseState; text: string; detail?: string | undefined };

export function Setup() {
  const [status, setStatus] = useState<SetupStatus>();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [configuredAgent, setConfiguredAgent] = useState("");
  const running = useRef(false);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await invoke<SetupStatus>("setup_status");
        if (!stopped) setStatus(next);
      } catch {
        /* keep polling */
      } finally {
        if (!stopped)
          timer = setTimeout(() => {
            void refresh();
          }, 1_000);
      }
    };
    void refresh();
    void invoke<AgentOption[]>("agent_options")
      .then((options) => {
        if (!stopped) setAgents(options);
      })
      .catch((cause: unknown) => {
        if (!stopped) setError(String(cause));
      });
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const step = useCallback(async (action: () => Promise<unknown>) => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    try {
      await action();
    } catch (cause) {
      setError(String(cause));
      setAuto(false);
    } finally {
      running.current = false;
      setBusy(false);
    }
  }, []);

  // One-click engine: the backend auto-approves pairings while armed; the
  // frontend configures the agent, then finishes once everything is ready.
  useEffect(() => {
    if (!auto || !status) return;
    if (status.completed) return;
    const agent = agents.find((a) => a.available) ?? agents[0];
    if (!status.agentConfigured && agent) {
      void step(async () => {
        await invoke("configure_agent", { agentId: agent.id });
        setConfiguredAgent(
          agent.id === "vscode" ? "VS Code · GitHub Copilot" : agent.name,
        );
      });
      return;
    }
    if (canFinish(status)) {
      void step(() => invoke("finish_setup"));
    }
  }, [auto, status, agents, step]);

  // Phase 1 — desktop app.
  const desktopPhase: Phase = status?.daemonReady
    ? { state: "done", text: "Running" }
    : { state: "active", text: "Starting…" };

  // Phase 2 — coding agents. Starts only after the Set up button is pressed.
  const agentPhase: Phase = !auto
    ? { state: "waiting", text: "Waiting — starts when you press Set up" }
    : !agents.length
      ? { state: "error", text: "No supported coding agent found" }
      : status?.agentConfigured
        ? {
            state: "done",
            text: "Configured",
            detail: configuredAgent || "MCP server added",
          }
        : {
            state: "active",
            text: `Configuring ${agents.find((a) => a.available)?.name ?? agents[0]?.name ?? "agent"}…`,
          };

  // Phase 3 — browser companion. Runs after the agent phase.
  const browserPhase: Phase = !auto
    ? { state: "waiting", text: "Waiting — starts after the agent is set up" }
    : !status?.agentConfigured
      ? { state: "waiting", text: "Waiting for the agent setup to finish" }
      : status.pairedBrowsers.length
        ? {
            state: "done",
            text: "Paired",
            detail: status.pairedBrowsers.map((b) => b.name).join(", "),
          }
        : status.pendingPairings.length
          ? { state: "active", text: "Approving your browser…" }
          : {
              state: "active",
              text: "Waiting for the browser companion to connect",
              detail: status.developmentMode
                ? "Dev build: load the unpacked companion — it pairs by itself."
                : status.storeUrl
                  ? "Install the Chrome companion to continue."
                  : undefined,
            };

  const boxes: { title: string; phase: Phase }[] = [
    { title: "Desktop app", phase: desktopPhase },
    { title: "Coding agents", phase: agentPhase },
    { title: "Browser companion", phase: browserPhase },
  ];

  if (status?.completed) {
    return (
      <div className="setup-shell">
        <main className="setup-oneclick">
          <div className="setup-brand">
            <span className="brand-mark" aria-hidden="true">
              ⌖
            </span>{" "}
            uigrep
          </div>
          <div className="ready-mark" aria-hidden="true">
            ✓
          </div>
          <h1>All set</h1>
          <p className="setup-lead">
            Press <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd> on any page
            and drag a region to send context to your agent.
          </p>
          <button
            className="primary"
            onClick={() => void getCurrentWindow().hide()}
          >
            Close
          </button>
        </main>
      </div>
    );
  }

  return (
    <div className="setup-shell">
      <main className="setup-oneclick">
        <div className="setup-brand">
          <span className="brand-mark" aria-hidden="true">
            ⌖
          </span>{" "}
          uigrep
        </div>
        <p className="setup-lead">
          One click sets everything up. Local only — no account, no cloud.
        </p>
        {(error || status?.error) && (
          <div className="setup-alert" role="alert">
            {error || status?.error}
          </div>
        )}
        <div className="phase-stack">
          {boxes.map((box, index) => (
            <div
              key={box.title}
              className={`phase-card phase--${box.phase.state}`}
            >
              <span className="phase-marker" aria-hidden="true">
                {box.phase.state === "done"
                  ? "✓"
                  : box.phase.state === "active"
                    ? "…"
                    : box.phase.state === "error"
                      ? "✕"
                      : index + 1}
              </span>
              <div className="phase-body">
                <h2>
                  {index + 1}. {box.title}
                </h2>
                <p
                  className={`phase-text phase-text--${box.phase.state}`}
                  aria-live="polite"
                >
                  {box.phase.text}
                </p>
                {box.phase.detail && (
                  <p className="phase-detail">{box.phase.detail}</p>
                )}
              </div>
            </div>
          ))}
        </div>
        <button
          className="primary setup-button"
          disabled={auto || busy || !status || !status.daemonReady}
          onClick={() => {
            setAuto(true);
            void invoke("set_auto_pair", { enabled: true }).catch((cause) =>
              setError(String(cause)),
            );
          }}
        >
          {auto ? "Setting up…" : "Set up uigrep"}
        </button>
        <button
          className="quiet"
          disabled={busy}
          onClick={() => {
            void invoke("set_auto_pair", { enabled: false }).catch(
              () => undefined,
            );
            void getCurrentWindow().hide();
          }}
        >
          Continue later
        </button>
      </main>
    </div>
  );
}
