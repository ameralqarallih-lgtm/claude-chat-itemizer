import './styles.css';

import { createRoot } from 'react-dom/client';

import { route, send, useSnapshot } from './api';
import { Editor } from './Editor';
import { Sidebar } from './Sidebar';

function App() {
  const snap = useSnapshot();
  if (!snap) return <div className="loading">Loading…</div>;
  return route === 'editor' ? <Editor snap={snap} /> : <Sidebar snap={snap} />;
}

createRoot(document.getElementById('root')!).render(<App />);
send({ op: 'ready' });
