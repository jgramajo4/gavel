/** Root app — navigation stack + global chrome (rewards banner, quit). */
import React, { useState } from 'react';
import { Box, useApp, useInput } from 'ink';
import { AppProvider, type AppServices } from './hooks/AppContext.js';
import { RewardsBanner } from './components/RewardsBanner.js';
import { ProposalList } from './screens/ProposalList.js';
import { ProposalDetail } from './screens/ProposalDetail.js';
import { DelegateLookup } from './screens/DelegateLookup.js';
import { DelegateSwitch } from './screens/DelegateSwitch.js';
import { PassportFeed } from './screens/PassportFeed.js';
import { PassportDetail } from './screens/PassportDetail.js';
import { PassportValidate } from './screens/PassportValidate.js';
import type { Route } from './navigation.js';

function Router({ stack, push, pop }: { stack: Route[]; push: (r: Route) => void; pop: () => void }) {
  const route = stack[stack.length - 1];
  switch (route.screen) {
    case 'list':
      return <ProposalList navigate={push} />;
    case 'detail':
      return <ProposalDetail proposal={route.proposal} onBack={pop} />;
    case 'delegateLookup':
      return <DelegateLookup navigate={push} onBack={pop} />;
    case 'delegateSwitch':
      return <DelegateSwitch onBack={pop} />;
    case 'passportFeed':
      return <PassportFeed navigate={push} onBack={pop} />;
    case 'passportDetail':
      return <PassportDetail attestation={route.attestation} onBack={pop} />;
    case 'passportValidate':
      return <PassportValidate onBack={pop} />;
    default:
      return null;
  }
}

export function App({ services }: { services: AppServices }) {
  const { exit } = useApp();
  const [stack, setStack] = useState<Route[]>([{ screen: 'list' }]);

  const push = (r: Route) => setStack((s) => [...s, r]);
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const atRoot = stack.length === 1;

  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
    else if (input === 'q' && atRoot) exit();
  });

  return (
    <AppProvider services={services}>
      <Box flexDirection="column" paddingX={1}>
        <RewardsBanner />
        <Box marginTop={1}>
          <Router stack={stack} push={push} pop={pop} />
        </Box>
      </Box>
    </AppProvider>
  );
}

