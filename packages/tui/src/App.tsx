/** Root app — onboarding gate, navigation stack, and global chrome. */
import React, { useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { daoSupports, type GavelConfig } from '@gavel/core';
import { AppProvider, type AppServices } from './hooks/AppContext.js';
import { StatusBar } from './components/StatusBar.js';
import { SetupWizard } from './wizard/SetupWizard.js';
import { Inbox } from './screens/Inbox.js';
import { DaoProposals } from './screens/DaoProposals.js';
import { ProposalDetail } from './screens/ProposalDetail.js';
import { Settings } from './screens/Settings.js';
import { DelegateLookup } from './screens/DelegateLookup.js';
import { DelegateSwitch } from './screens/DelegateSwitch.js';
import { PassportFeed } from './screens/PassportFeed.js';
import { PassportDetail } from './screens/PassportDetail.js';
import { PassportValidate } from './screens/PassportValidate.js';
import type { Route } from './navigation.js';

function Router({ stack, push, pop }: { stack: Route[]; push: (r: Route) => void; pop: () => void }) {
  const route = stack[stack.length - 1];
  if (!route) return null;
  switch (route.screen) {
    case 'inbox':
      return <Inbox navigate={push} />;
    case 'daoProposals':
      return <DaoProposals dao={route.dao} navigate={push} onBack={pop} />;
    case 'detail':
      return <ProposalDetail proposal={route.proposal} onBack={pop} />;
    case 'settings':
      return <Settings onBack={pop} />;
    case 'delegateLookup':
      return <DelegateLookup dao={route.dao} navigate={push} onBack={pop} />;
    case 'delegateSwitch':
      return <DelegateSwitch dao={route.dao} onBack={pop} />;
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

/**
 * Migration notices, shown once.
 *
 * A config that came from the Nouns-only format may have had authority
 * reduced -- a signer that has to be reconnected, a plaintext secret that was
 * removed. That is exactly the kind of change a user must be told about
 * rather than discovering when a vote will not sign.
 */
function MigrationNotice({ notes }: { notes: Array<{ code: string; message: string }> }) {
  if (notes.length === 0) return null;
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} marginBottom={1}>
      <Text color="yellow" bold>
        Your configuration was migrated
      </Text>
      {notes.map((note) => (
        <Text key={note.code} dimColor>
          · {note.message}
        </Text>
      ))}
    </Box>
  );
}

export function App({ services }: { services: AppServices }) {
  const { exit } = useApp();
  const [stack, setStack] = useState<Route[]>([{ screen: 'inbox' }]);
  const [onboarded, setOnboarded] = useState(services.config.gavel.onboarding.completed);
  const [notesDismissed, setNotesDismissed] = useState(false);

  const push = (r: Route) => setStack((s) => [...s, r]);
  const pop = () => setStack((s) => (s.length > 1 ? s.slice(0, -1) : s));
  const atRoot = stack.length === 1;

  useInput((input, key) => {
    if (key.ctrl && input === 'c') exit();
    else if (input === 'q' && atRoot && onboarded) exit();
    else if (input === 'p' && atRoot && daoSupports('nouns', 'proposals') && services.config.gavel.followedDaos.includes('nouns')) {
      // The Nouns passport feed is a Nouns-specific surface, reachable only
      // when Nouns is one of the followed DAOs.
      push({ screen: 'passportFeed' });
    } else if (input !== 'q') {
      setNotesDismissed(true);
    }
  });

  const complete = async (next: GavelConfig) => {
    await services.updateConfig(next);
    setOnboarded(true);
  };

  return (
    <AppProvider services={services}>
      <Box flexDirection="column" paddingX={1}>
        {onboarded ? (
          <>
            <StatusBar />
            {notesDismissed ? null : <MigrationNotice notes={services.config.migrationNotes} />}
            <Box marginTop={1}>
              <Router stack={stack} push={push} pop={pop} />
            </Box>
          </>
        ) : (
          <SetupWizard config={services.config} onComplete={complete} />
        )}
      </Box>
    </AppProvider>
  );
}
