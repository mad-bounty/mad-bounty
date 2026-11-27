import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import { discoverWallets, reconnect } from './ui/deps';
import { useRoute } from './ui/hooks';
import { AppShell } from './ui/shell';
import { Btn, EmptyState, ErrorBoundary } from './ui/components';
import { Browse } from './ui/pages/Browse';
import { BountyPage } from './ui/pages/Bounty';
import { PostPage } from './ui/pages/Post';
import { MePage } from './ui/pages/Me';
import { HelpPage } from './ui/pages/Help';

const TITLES: Record<string, string> = { browse: 'Bounties', post: 'Post a bounty', me: 'My bounties', help: 'Help', notfound: 'Not found' };

function App() {
  const route = useRoute();
  const key = route.name === 'bounty' ? `b${route.id}` : route.name;
  useEffect(() => {
    document.title = `${route.name === 'bounty' ? `Bounty #${route.id}` : TITLES[route.name]} — MAD Bounty`;
    if (route.name !== 'post') scrollTo(0, 0);
  }, [key]);
  let page;
  switch (route.name) {
    case 'browse': page = <Browse />; break;
    case 'bounty': page = <BountyPage id={route.id!} />; break;
    case 'post': page = <PostPage />; break;
    case 'me': page = <MePage />; break;
    case 'help': page = <HelpPage />; break;
    default: page = <div class="wrap page"><EmptyState title="Page not found" action={<Btn href="#/">All bounties</Btn>}><p>That link doesn't match anything in the app.</p></EmptyState></div>;
  }
  return <AppShell route={route}><ErrorBoundary key={key}>{page}</ErrorBoundary></AppShell>;
}

discoverWallets();
// silent re-connect (no popup) to the wallet used earlier in this tab, once discovery has had time to run
setTimeout(() => { reconnect().catch(() => undefined); }, 400);
const root = document.getElementById('app')!;
root.textContent = '';
render(<App />, root);
