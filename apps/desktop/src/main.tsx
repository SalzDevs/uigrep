import React from 'react';
import ReactDOM from 'react-dom/client';
import { listen } from '@tauri-apps/api/event';
import { invoke } from '@tauri-apps/api/core';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { isRegistered, register } from '@tauri-apps/plugin-global-shortcut';
import './styles.css';

type PillState =
  | { kind: 'starting' }
  | { kind: 'ready' }
  | { kind: 'selecting' }
  | { kind: 'annotated'; count: number }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'error' }
  | { kind: 'paused' };

const labels: Record<Exclude<PillState['kind'], 'annotated'>, string> = {
  starting: 'Starting…',
  ready: 'uigrep ready',
  selecting: 'Select UI',
  sending: 'Sending…',
  sent: 'Sent to agent',
  error: 'Needs attention',
  paused: 'uigrep paused',
};

function Pill(): React.JSX.Element {
  const [state, setState] = React.useState<PillState>({ kind: 'starting' });

  React.useEffect(() => {
    const shortcut = 'Alt+Shift+G';
    const initialize = async (): Promise<void> => {
      const unlisten = await listen<PillState>('pill-state', (event) => setState(event.payload));
      if (!(await isRegistered(shortcut))) {
        await register(shortcut, () => void invoke('start_capture'));
      }
      setState({ kind: 'ready' });
      return void unlisten;
    };
    void initialize().catch(() => setState({ kind: 'error' }));
  }, []);

  const label = state.kind === 'annotated' ? `${state.count} annotations` : labels[state.kind];

  return (
    <button
      className={`pill pill--${state.kind}`}
      type="button"
      aria-label={`${label}. Drag to reposition.`}
      onMouseDown={() => void getCurrentWindow().startDragging()}
    >
      <span className="pill__dot" aria-hidden="true" />
      <span className="pill__label">{label}</span>
    </button>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <Pill />
  </React.StrictMode>,
);
