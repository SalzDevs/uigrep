import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  canFinish,
  setupStep,
  type AgentOption,
  type ConfigResult,
  type SetupStatus,
} from "./setup-state";
import "./setup.css";

const steps = ["Browser", "Agent", "Test", "Ready"];

export function Setup() {
  const [status, setStatus] = useState<SetupStatus>();
  const [agents, setAgents] = useState<AgentOption[]>([]);
  const [agentId, setAgentId] = useState("vscode");
  const [visitedStep, setVisitedStep] = useState<number>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [connectionError, setConnectionError] = useState("");
  const [result, setResult] = useState<ConfigResult>();
  const [copied, setCopied] = useState(false);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [revokeId, setRevokeId] = useState<string>();

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const refresh = async () => {
      try {
        const next = await invoke<SetupStatus>("setup_status");
        if (!stopped) {
          setStatus(next);
          setConnectionError("");
        }
      } catch (cause) {
        if (!stopped) setConnectionError(String(cause));
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
        if (!stopped) {
          setAgents(options);
          setAgentId(
            options.find((a) => a.available)?.id ?? options[0]?.id ?? "vscode",
          );
        }
      })
      .catch((cause: unknown) => {
        if (!stopped) setError(String(cause));
      });
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  const act = useCallback(
    async (action: () => Promise<void>) => {
      if (busy) return;
      setBusy(true);
      setError("");
      try {
        await action();
      } catch (cause) {
        setError(String(cause));
      } finally {
        setBusy(false);
      }
    },
    [busy],
  );

  const command = (name: string, args?: Record<string, unknown>) =>
    act(async () => {
      setStatus(await invoke<SetupStatus>(name, args));
    });
  const current = status ? setupStep(status) : 0;
  const step = Math.min(visitedStep ?? current, current);
  const selected = agents.find((a) => a.id === agentId);
  const changeStep = (index: number) => {
    setVisitedStep(index);
    setError("");
    setConfirmRestore(false);
  };

  return (
    <div className="setup-shell">
      <aside className="setup-sidebar">
        <div className="setup-brand">
          <span className="brand-mark" aria-hidden="true">
            ⌖
          </span>{" "}
          uigrep
        </div>
        <nav aria-label="Installation progress">
          <ol>
            {steps.map((label, index) => (
              <li key={label}>
                <button
                  type="button"
                  disabled={index > current || busy}
                  onClick={() => changeStep(index)}
                  aria-current={step === index ? "step" : undefined}
                >
                  <span
                    className={`step-number ${index < current ? "done" : ""}`}
                  >
                    {index < current ? "✓" : index + 1}
                  </span>
                  {label}
                </button>
              </li>
            ))}
          </ol>
        </nav>
        <p className="local-note">Local only. No account. No cloud.</p>
      </aside>
      <main className="setup-main">
        <header className="setup-topbar">
          <span
            className={`connection-badge ${status?.daemonReady && !connectionError ? "online" : ""}`}
          >
            <i />
            {status?.daemonReady && !connectionError
              ? "Desktop running"
              : "Connecting…"}
          </span>
          <span>
            {step + 1} / {steps.length}
          </span>
        </header>
        <div className="setup-content">
          {(error || connectionError || status?.error) && (
            <div className="setup-alert" role="alert">
              {error || connectionError || status?.error}
            </div>
          )}
          {!status ? (
            <h1>Connecting…</h1>
          ) : (
            <>
              {step === 0 && (
                <>
                  <h1>Connect your browser</h1>
                  <div className="setup-card">
                    <p>
                      Install the Chrome companion, then click Connect in its
                      options.
                    </p>
                    <button
                      className="primary"
                      disabled={busy || !status.daemonReady || !status.storeUrl}
                      onClick={() => void command("begin_browser_setup")}
                    >
                      Open Chrome Web Store ↗
                    </button>
                    {status.developmentMode && (
                      <p className="setup-warning">
                        Dev build: load the unpacked companion (
                        <code>apps/extension/.output/chrome-mv3</code>), it
                        requests pairing automatically.
                      </p>
                    )}
                  </div>
                  {status.pendingPairings.map((request) => (
                    <div className="setup-card pairing-card" key={request.id}>
                      <h2>Approve {request.name}?</h2>
                      <div className="button-row">
                        <button
                          className="primary"
                          disabled={busy}
                          onClick={() => {
                            void command("approve_pairing", {
                              requestId: request.id,
                            });
                            setVisitedStep(undefined);
                          }}
                        >
                          Approve
                        </button>
                        <button
                          className="secondary"
                          disabled={busy}
                          onClick={() => {
                            void command("reject_pairing", {
                              requestId: request.id,
                            });
                          }}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  ))}
                  {status.pairedBrowsers.map((browser) => (
                    <div className="paired-row" key={browser.id}>
                      <span>✓ {browser.name}</span>
                      {revokeId === browser.id ? (
                        <div className="button-row">
                          <button
                            className="danger"
                            disabled={busy}
                            onClick={() => {
                              void command("revoke_browser", {
                                browserId: browser.id,
                              });
                              setRevokeId(undefined);
                            }}
                          >
                            Revoke
                          </button>
                          <button
                            className="quiet"
                            onClick={() => setRevokeId(undefined)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          className="quiet"
                          onClick={() => setRevokeId(browser.id)}
                        >
                          Revoke
                        </button>
                      )}
                    </div>
                  ))}
                  {current > 0 && (
                    <button
                      className="primary"
                      disabled={busy}
                      onClick={() => setVisitedStep(undefined)}
                    >
                      Continue →
                    </button>
                  )}
                </>
              )}
              {step === 1 && (
                <>
                  <h1>Configure your agent</h1>
                  <fieldset className="agent-options" disabled={busy}>
                    {agents.map((agent) => (
                      <label
                        className={`agent-option ${agent.id === agentId ? "selected" : ""}`}
                        key={agent.id}
                      >
                        <input
                          type="radio"
                          name="agent"
                          value={agent.id}
                          checked={agentId === agent.id}
                          onChange={() => {
                            setAgentId(agent.id);
                            setConfirmRestore(false);
                          }}
                        />
                        <span>
                          <strong>
                            {agent.id === "vscode"
                              ? "VS Code · GitHub Copilot"
                              : "Cursor"}
                          </strong>
                          {!agent.available && (
                            <small>Not detected on this device</small>
                          )}
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  {selected && (
                    <p className="config-path">
                      Adds one server to <code>{selected.configPath}</code>.
                      Backup is kept.
                    </p>
                  )}
                  <div className="button-row">
                    <button
                      className="primary"
                      disabled={busy || !selected || !status.daemonReady}
                      onClick={() => {
                        void act(async () => {
                          setResult(
                            await invoke<ConfigResult>("configure_agent", {
                              agentId,
                            }),
                          );
                          setStatus(await invoke<SetupStatus>("setup_status"));
                          setVisitedStep(undefined);
                        });
                      }}
                    >
                      {busy ? "Connecting…" : "Connect agent →"}
                    </button>
                    {status.agentConfigured && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => setVisitedStep(undefined)}
                      >
                        Continue →
                      </button>
                    )}
                  </div>
                  <details>
                    <summary>Restore previous configuration…</summary>
                    {confirmRestore ? (
                      <div className="button-row">
                        <button
                          className="danger"
                          disabled={busy}
                          onClick={() => {
                            void act(async () => {
                              await invoke("restore_agent_config", { agentId });
                              setResult(undefined);
                              setStatus(
                                await invoke<SetupStatus>("setup_status"),
                              );
                              setConfirmRestore(false);
                            });
                          }}
                        >
                          Confirm
                        </button>
                        <button
                          className="quiet"
                          onClick={() => setConfirmRestore(false)}
                        >
                          Cancel
                        </button>
                      </div>
                    ) : (
                      <button
                        className="secondary"
                        disabled={busy || !selected}
                        onClick={() => setConfirmRestore(true)}
                      >
                        Restore
                      </button>
                    )}
                  </details>
                </>
              )}
              {step === 2 && (
                <>
                  <h1>Test the connection</h1>
                  {result && (
                    <div className="setup-success" role="status">
                      ✓ Agent configured
                    </div>
                  )}
                  <div className="setup-card">
                    <ol className="test-steps">
                      <li>
                        <button
                          className="secondary"
                          disabled={busy || !status.daemonReady}
                          onClick={() => {
                            void command("open_test_capture");
                            setCopied(false);
                          }}
                        >
                          {status.testCaptureId
                            ? "Open test page again ↗"
                            : "Open test page ↗"}
                        </button>
                      </li>
                      <li>
                        On the test page: <kbd>Alt</kbd> + <kbd>Shift</kbd> +{" "}
                        <kbd>G</kbd>, drag a region, comment, send.
                      </li>
                      <li>
                        Ask your agent: <code>Read my uigrep capture.</code>
                      </li>
                    </ol>
                  </div>
                  <div className="check-row" role="status">
                    <span>{status.testCaptureId ? "✓" : "○"}</span>
                    {status.testCaptureId
                      ? "Capture received"
                      : "Waiting for capture"}
                  </div>
                  <div className="check-row" role="status">
                    <span>{status.mcpVerified ? "✓" : "○"}</span>
                    {status.mcpVerified ? "Agent read it" : "Waiting for agent"}
                  </div>
                  <details>
                    <summary>Not connecting?</summary>
                    <p>
                      Keep uigrep running. Use the approved Chrome profile.
                      Reload the editor if the MCP server is missing. Shortcut
                      taken? Change it in Chrome's extension shortcuts.
                    </p>
                  </details>
                  {canFinish(status) && (
                    <button
                      className="primary"
                      onClick={() => setVisitedStep(undefined)}
                    >
                      Continue →
                    </button>
                  )}
                </>
              )}
              {step === 3 && (
                <>
                  <h1>Ready</h1>
                  <ol className="test-steps">
                    <li>
                      Open any page, press <kbd>Alt</kbd> + <kbd>Shift</kbd> +{" "}
                      <kbd>G</kbd>, drag a region.
                    </li>
                    <li>Comment and send.</li>
                    <li>Ask your agent to read the uigrep capture.</li>
                  </ol>
                  <button
                    className="primary"
                    disabled={
                      busy || !canFinish(status) || Boolean(connectionError)
                    }
                    onClick={() => void command("finish_setup")}
                  >
                    Finish →
                  </button>
                </>
              )}
            </>
          )}
        </div>
        <footer className="setup-footer">
          <button
            className="quiet"
            disabled={busy}
            onClick={() => {
              void act(async () => {
                await getCurrentWindow().hide();
              });
            }}
          >
            Continue later
          </button>
        </footer>
      </main>
    </div>
  );
}
