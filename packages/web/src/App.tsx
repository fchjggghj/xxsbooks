import { AppShell } from './components/layout/AppShell';
import { Dashboard } from './pages/Dashboard';
import { Queue } from './pages/Queue';
import { Config } from './pages/Config';
import { Logs } from './pages/Logs';
import { Books } from './pages/Books';
import Library from './pages/Library';
import Direction from './pages/Direction';
import Pool from './pages/Pool';
import Composer from './pages/Composer';
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
      {tab === 'library' && <Library />}
      {tab === 'direction' && <Direction />}
      {tab === 'pool' && <Pool />}
      {tab === 'composer' && <Composer />}
    </AppShell>
  );
}
