import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { canFinish, type AgentOption, type SetupStatus } from "./setup-state";
import "./setup.css";

export function Setup() {
  const [status, setStatus] = useState<SetupStatus>();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [auto, setAuto] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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

  // One-click engine: after the user presses the button, every remaining
  // step runs automatically as soon as its precondition is met.
  useEffect(() => {
    if (!auto || !status) return;
    if (status.completed) return;
    const agent = agents.find((a) => a.available) ?? agents[0];
    if (!status.agentConfigured && agent) {
      void step(() => invoke("configure_agent", { agentId: agent.id }));
      return;
    }
    const pending = status.pendingPairings[0];
    if (pending) {
      void step(() => invoke("approve_pairing", { requestId: pending.id }));
      return;
    }
    if (canFinish(status)) {
      void step(() => invoke("finish_setup"));
    }
  }, [auto, status, agents, step]);

  const rows: { label: string; state: "done" | "active" | "waiting" }[] = [
    {
      label: "Desktop app running",
      state: status?.daemonReady ? "done" : "active",
    },
    {
      label: "Browser companion paired",
      state: status?.pairedBrowsers.length
        ? "done"
        : status?.pendingPairings.length
          ? "active"
          : "waiting",
    },
    {
      label: "Coding agent configured",
      state: status?.agentConfigured ? "done" : auto ? "active" : "waiting",
    },
  ];

  if (status?.completed) {
    return (
      <div className="setup-shell">
        <main className="setup-main oneclick">
          <div className="ready-mark" aria-hidden="true">
            ✓
          </div>
          <h1>uigrep is ready</h1>
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
      <main className="setup-main oneclick">
        <div className="setup-brand">
          <span className="brand-mark" aria-hidden="true">
            ⌖
          </span>{" "}
          uigrep
        </div>
        <h1>One click. That's it.</h1>
        <p className="setup-lead">
          uigrep configures your coding agent and pairs your browser
          automatically. Local only — no account, no cloud.
        </p>
        {(error || status?.error) && (
          <div className="setup-alert" role="alert">
            {error || status?.error}
          </div>
        )}
        {status?.developmentMode && !status.pairedBrowsers.length && (
          <p className="setup-warning">
            Dev build: load the unpacked companion (
            <code>apps/extension/.output/chrome-mv3</code>) first — it pairs
            automatically.
          </p>
        )}
        <ul className="setup-checks">
          {rows.map((row) => (
            <li key={row.label} className={`check-row ${row.state}`}>
              <span aria-hidden="true">
                {row.state === "done"
                  ? "✓"
                  : row.state === "active"
                    ? "…"
                    : "○"}
              </span>
              {row.label}
            </li>
          ))}
        </ul>
        <button
          className="primary setup-button"
          disabled={auto || busy || !status || !status.daemonReady}
          onClick={() => setAuto(true)}
        >
          {auto ? "Setting up…" : "Set up uigrep"}
        </button>
        <button
          className="quiet"
          disabled={busy}
          onClick={() => void getCurrentWindow().hide()}
        >
          Continue later
        </button>
      </main>
    </div>
  );
}
