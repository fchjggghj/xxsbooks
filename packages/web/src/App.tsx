import { AppShell } from './components/layout/AppShell';
import { Dashboard } from './pages/Dashboard';
import { Queue } from './pages/Queue';
import { Config } from './pages/Config';
import { Logs } from './pages/Logs';
import { Books } from './pages/Books';
import { useAppStore } from './store/app';

export default function App() {
  const tab = useAppStore((s) => s.tab);

  return (
    <AppShell>
      {tab === 'dash' && <Dashboard />}
      {tab === 'queue' && <Queue />}
      {tab === 'config' && <Config />}
      {tab === 'logs' && <Logs />}
      {tab === 'books' && <Books />}
    </AppShell>
  );
}
