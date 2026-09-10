import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  canFinish,
  setupStep,
  testPrompt,
  type AgentOption,
  type ConfigResult,
  type SetupStatus,
} from "./setup-state";
import "./setup.css";

const steps = ["Connect browser", "Choose agent", "Test capture", "Ready"];

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
  const prompt = status?.testCaptureId ? testPrompt(status.testCaptureId) : "";
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
        <p className="setup-eyebrow">FROM PIXELS TO CONTEXT</p>
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
        <div className="local-note">
          <span aria-hidden="true">◈</span>
          <strong>Local by design.</strong>
          <p>
            No uigrep account. No cloud upload. Your agent controls what it
            retrieves.
          </p>
        </div>
      </aside>
      <main className="setup-main">
        <header className="setup-topbar">
          <span
            className={`connection-badge ${status?.daemonReady && !connectionError ? "online" : ""}`}
          >
            <i />
            {status?.daemonReady && !connectionError
              ? "Desktop running"
              : "Connecting to desktop…"}
          </span>
          <span>Setup · {step + 1} / 4</span>
        </header>
        <div className="setup-content">
          {(error || connectionError || status?.error) && (
            <div className="setup-alert" role="alert">
              {error || connectionError || status?.error}
            </div>
          )}
          {!status ? (
            <>
              <h1>Getting your workspace ready.</h1>
              <p>
                Checking the local daemon. If this takes a while, reopen Setup
                from the tray menu.
              </p>
            </>
          ) : (
            <>
              {step === 0 && (
                <>
                  <p className="setup-eyebrow">ONE BROWSER APPROVAL</p>
                  <h1>
                    Your browser.
                    <br />
                    Now agent-aware.
                  </h1>
                  <p className="setup-lead">
                    Add the Chrome companion to select UI and attach precise
                    context. Keep this window open—we will detect it
                    automatically.
                  </p>
                  <div className="setup-card">
                    <div className="card-heading">
                      <span className="app-glyph">C</span>
                      <div>
                        <h2>Chrome companion</h2>
                        <p>The first supported browser for guided setup.</p>
                      </div>
                    </div>
                    <p>
                      Chrome will ask you to approve the extension. Then approve
                      its connection here. No passwords, tokens or terminal
                      commands.
                    </p>
                    <button
                      className="primary"
                      disabled={busy || !status.daemonReady || !status.storeUrl}
                      onClick={() => {
                        void command("begin_browser_setup");
                      }}
                    >
                      Open Chrome Web Store ↗
                    </button>
                    {!status.storeUrl && (
                      <p className="setup-warning">
                        This build has no published Chrome listing configured.
                        Store installation is not available yet.
                      </p>
                    )}
                    {status.developmentMode && (
                      <details>
                        <summary>
                          Development build: test before store publication
                        </summary>
                        <p>
                          Load the built companion as an unpacked Chrome
                          extension. It requests approval automatically on
                          installation. For an existing installation, open
                          companion options and select Connect. Debug builds
                          accept unpacked Chrome extension IDs.
                        </p>
                      </details>
                    )}
                  </div>
                  {status.pendingPairings.map((request) => (
                    <div className="setup-card pairing-card" key={request.id}>
                      <h2>Approve {request.name}?</h2>
                      <p>
                        Only approve if you just installed or connected this
                        companion. Approval expires after five minutes.
                      </p>
                      <code className="wrap-code">{request.origin}</code>
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
                          Approve browser
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
                      <span>✓ {browser.name} approved</span>
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
                            Confirm revoke
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
                  <p className="setup-eyebrow">KEEP THE TOOLS YOU LOVE</p>
                  <h1>Choose your coding agent.</h1>
                  <p className="setup-lead">
                    We will add the local uigrep MCP server to your client. Its
                    existing servers stay intact, and the runtime is included.
                  </p>
                  <fieldset className="agent-options" disabled={busy}>
                    <legend className="sr-only">Coding client</legend>
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
                          <small>
                            {agent.available
                              ? "Configuration directory found"
                              : "Not detected; configure only if you use this client"}
                          </small>
                        </span>
                      </label>
                    ))}
                  </fieldset>
                  {selected && (
                    <div className="setup-card">
                      <h2>One safe configuration change</h2>
                      <p>With your approval, add only the uigrep server to:</p>
                      <code className="wrap-code">{selected.configPath}</code>
                      <p>
                        Existing files are backed up. Conflicting uigrep entries
                        and unsupported configuration formats are never silently
                        overwritten.
                      </p>
                    </div>
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
                      {busy ? "Connecting…" : "Approve & connect agent →"}
                    </button>
                    {status.agentConfigured && (
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => setVisitedStep(undefined)}
                      >
                        Continue to test
                      </button>
                    )}
                  </div>
                  <details>
                    <summary>Restore a previous configuration</summary>
                    <p>
                      Restores the selected client's exact pre-setup contents
                      only if it has not changed since setup. You will need to
                      reconnect an agent and repeat verification.
                    </p>
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
                          Confirm restore
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
                        Restore selected client…
                      </button>
                    )}
                  </details>
                </>
              )}
              {step === 2 && (
                <>
                  <p className="setup-eyebrow">PROVE THE WHOLE CONNECTION</p>
                  <h1>One capture. Real context.</h1>
                  <p className="setup-lead">
                    We only mark setup ready after a browser capture reaches the
                    daemon and the MCP adapter retrieves it.
                  </p>
                  {result && (
                    <div className="setup-success" role="status">
                      ✓ Agent configuration saved. {result.message}
                    </div>
                  )}
                  <div className="setup-card">
                    <h2>1. Capture the practice card</h2>
                    <p>
                      Open the test page in your approved Chrome profile. Press{" "}
                      <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>G</kbd>, drag
                      around the card, add a comment, and select{" "}
                      <strong>Send to agent</strong>.
                    </p>
                    <p>
                      On macOS use Option + Shift + G. The page opens in your
                      default browser; use the paired Chrome profile.
                    </p>
                    <button
                      className="secondary"
                      disabled={busy || !status.daemonReady}
                      onClick={() => {
                        void command("open_test_capture");
                        setCopied(false);
                      }}
                    >
                      {status.testCaptureId
                        ? "Start a fresh test"
                        : "Open test page ↗"}
                    </button>
                  </div>
                  <div className="check-row" role="status">
                    <span>{status.testCaptureId ? "✓" : "○"}</span>
                    {status.testCaptureId
                      ? "Browser capture received"
                      : "Waiting for your browser capture"}
                  </div>
                  {status.testCaptureId && (
                    <div className="setup-card">
                      <h2>2. Let your agent read it</h2>
                      <p>
                        Reload your coding client if needed, enable the uigrep
                        MCP server, and approve any client trust prompt. Send
                        this in agent chat:
                      </p>
                      <textarea
                        className="test-prompt"
                        aria-label="Test prompt to send to your agent"
                        readOnly
                        value={prompt}
                        onFocus={(event) => event.target.select()}
                      />
                      <button
                        className="secondary"
                        disabled={busy}
                        onClick={() => {
                          void act(async () => {
                            await navigator.clipboard.writeText(prompt);
                            setCopied(true);
                          });
                        }}
                      >
                        {copied ? "Copied ✓" : "Copy test prompt"}
                      </button>
                      <p>
                        This asks the agent to read the capture, not change your
                        project. Client trust approvals cannot be bypassed by
                        the installer.
                      </p>
                    </div>
                  )}
                  <div className="check-row" role="status">
                    <span>{status.mcpVerified ? "✓" : "○"}</span>
                    {status.mcpVerified
                      ? "MCP retrieval confirmed"
                      : "Waiting for the MCP read receipt"}
                  </div>
                  <details>
                    <summary>Something not connecting?</summary>
                    <p>
                      Keep uigrep running. Check you are using the approved
                      browser profile and the configured editor. Reload the
                      editor and approve its MCP server. If the shortcut is
                      taken, change the companion command in Chrome's extension
                      shortcuts. Setup never requires disabling browser
                      security.
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
                  <div className="ready-mark" aria-hidden="true">
                    ✓
                  </div>
                  <p className="setup-eyebrow">CONNECTED END TO END</p>
                  <h1>Point. Explain. Build.</h1>
                  <p className="setup-lead">
                    Your browser is approved, your agent is configured, and the
                    test capture has been retrieved through MCP.
                  </p>
                  <div className="setup-card ready-card">
                    <h2>Your everyday workflow</h2>
                    <ol>
                      <li>Open the UI you want to change.</li>
                      <li>
                        Press <strong>Alt + Shift + G</strong> and drag a
                        region.
                      </li>
                      <li>Add a comment and send the capture.</li>
                      <li>
                        Ask your coding agent to read the uigrep feedback.
                      </li>
                    </ol>
                  </div>
                  <p>
                    “Sent” means saved locally for retrieval—not that an agent
                    has started a fix. Your coding client controls its model,
                    permissions and data handling.
                  </p>
                  <button
                    className="primary"
                    disabled={
                      busy || !canFinish(status) || Boolean(connectionError)
                    }
                    onClick={() => {
                      void command("finish_setup");
                    }}
                  >
                    Finish setup →
                  </button>
                  <p className="fine-print">
                    The small status pill stays available. Reopen this window
                    from the uigrep tray menu at any time.
                  </p>
                </>
              )}
            </>
          )}
        </div>
        <footer className="setup-footer">
          <span>Your progress is saved on this device.</span>
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
