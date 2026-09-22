/**
 * Settings.
 *
 * Changing which DAOs you follow must not mean re-running setup. Each section
 * here edits one branch of the same config the wizard writes, through the same
 * core validators, so there is one set of rules and not two.
 *
 * Switching wallet or execution mode says what it costs: the consequences of a
 * change to signing authority should be visible before it is made, not
 * discovered at the moment a vote fails.
 */
import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  applyFollowedDaoSelection,
  daoDisplayName,
  listDaoDescriptors,
  listExecutionOptions,
  listWalletMethods,
  resolveSecretAudit,
  validateGavelConfig,
  type GavelConfig,
} from '@gavel/core';
import { Header, Footer } from '../components/common.js';
import { CheckList, RadioList, type Choice } from '../wizard/controls.js';
import { useServices } from '../hooks/AppContext.js';

type Section = 'daos' | 'wallet' | 'execution' | 'inference' | 'notifications' | 'secrets';

const SECTIONS: Array<{ id: Section; label: string }> = [
  { id: 'daos', label: 'Followed DAOs' },
  { id: 'wallet', label: 'Wallet connection' },
  { id: 'execution', label: 'Execution mode' },
  { id: 'inference', label: 'Recommendations' },
  { id: 'notifications', label: 'Alerts' },
  { id: 'secrets', label: 'Secrets' },
];

export function Settings({ onBack }: { onBack: () => void }) {
  const { config, updateConfig } = useServices();
  const [section, setSection] = useState<Section | null>(null);
  const [sectionCursor, setSectionCursor] = useState(0);
  const [cursor, setCursor] = useState(0);
  const [message, setMessage] = useState<string | null>(null);

  const gavel = config.gavel;

  const save = async (next: GavelConfig) => {
    const { issues } = validateGavelConfig(next);
    if (issues.length > 0) {
      setMessage(issues[0]?.message ?? 'That change is not valid.');
      return;
    }
    await updateConfig(next);
    setMessage('Saved.');
  };

  const choices: Choice[] = (() => {
    if (section === 'daos') {
      return listDaoDescriptors().map((descriptor) => ({
        value: descriptor.id,
        label: `${descriptor.displayName}  (${descriptor.network})`,
        summary: descriptor.summary,
      }));
    }
    if (section === 'wallet') {
      return listWalletMethods({ env: process.env }).map((method) => ({
        value: method.type,
        label: method.label,
        summary: method.summary,
        available: method.available,
        blockers: method.blockers,
        recommended: method.recommended,
      }));
    }
    if (section === 'execution') {
      return listExecutionOptions({
        walletType: gavel.wallet.type,
        followedDaos: gavel.followedDaos,
        autonomousAcknowledged: Boolean(gavel.execution.autonomous?.acknowledgedAt),
      }).map((mode) => ({
        value: mode.mode,
        label: mode.label,
        summary: `${mode.description}${mode.supportedDaos.length ? ` · ${mode.supportedDaos.map(daoDisplayName).join(', ')}` : ''}`,
        available: mode.available,
        blockers: mode.blockers,
      }));
    }
    if (section === 'inference') {
      return [
        { value: 'local', label: 'Local', summary: 'Nothing leaves this machine.' },
        { value: 'remote', label: 'Remote provider', summary: 'Proposal text is sent to a configured endpoint.' },
        { value: 'runtime', label: 'Runtime-provided', summary: 'The host harness supplies inference.' },
      ];
    }
    if (section === 'notifications') {
      return [
        { value: 'proposalAlerts', label: 'Proposal alerts' },
        { value: 'dailyBriefing', label: 'Daily briefing' },
        { value: 'executionAlerts', label: 'Execution alerts' },
      ];
    }
    return [];
  })();

  useInput((input, key) => {
    setMessage(null);
    if (key.escape || (input === 'q' && !section)) {
      if (section) setSection(null);
      else onBack();
      return;
    }
    if (!section) {
      if (key.downArrow || input === 'j') setSectionCursor((c) => Math.min(SECTIONS.length - 1, c + 1));
      else if (key.upArrow || input === 'k') setSectionCursor((c) => Math.max(0, c - 1));
      else if (key.return) {
        setSection(SECTIONS[sectionCursor]?.id ?? null);
        setCursor(0);
      }
      return;
    }
    if (key.downArrow || input === 'j') setCursor((c) => Math.min(Math.max(choices.length - 1, 0), c + 1));
    else if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1));
    else if (input === ' ' && section === 'daos') {
      const choice = choices[cursor];
      if (!choice) return;
      const next = gavel.followedDaos.includes(choice.value)
        ? gavel.followedDaos.filter((id) => id !== choice.value)
        : [...gavel.followedDaos, choice.value];
      // The same transition the wizard's DAO step runs, so Settings cannot
      // reach a state the wizard would refuse -- previously this wrote
      // `followedDaos` alone and left an execution mode no remaining DAO
      // could support.
      const transition = applyFollowedDaoSelection(gavel, next);
      if (transition.downgraded) {
        setMessage(
          `No followed DAO supports ${gavel.execution.mode}; execution is now unsigned. ` +
            'Re-select a mode in Execution mode.',
        );
      }
      void save(transition.config);
    } else if (input === ' ' && section === 'notifications') {
      const choice = choices[cursor];
      if (!choice) return;
      const key2 = choice.value as keyof GavelConfig['notifications'];
      void save({
        ...gavel,
        notifications: { ...gavel.notifications, [key2]: !gavel.notifications[key2] },
      });
    } else if (key.return) {
      const choice = choices[cursor];
      if (!choice || choice.available === false) {
        setMessage(choice?.blockers?.[0] ?? null);
        return;
      }
      if (section === 'wallet') {
        // Say what changes before it changes. A wallet swap can take away the
        // ability to sign, and that should never be a surprise.
        void save({
          ...gavel,
          wallet: { type: choice.value as GavelConfig['wallet']['type'], local: null, walletconnect: null },
          execution:
            choice.value === 'read-only' ? { ...gavel.execution, mode: 'unsigned' } : gavel.execution,
        });
      } else if (section === 'execution') {
        void save({ ...gavel, execution: { ...gavel.execution, mode: choice.value } });
      } else if (section === 'inference') {
        void save({
          ...gavel,
          inference: {
            mode: choice.value as GavelConfig['inference']['mode'],
            endpointVariable: choice.value === 'remote' ? 'PREDICTION_URL' : null,
          },
        });
      }
    }
  });

  if (!section) {
    return (
      <Box flexDirection="column">
        <Header title="Settings" subtitle={config.configPath} />
        {SECTIONS.map((entry, index) => (
          <Box key={entry.id}>
            <Text color={index === sectionCursor ? 'cyan' : undefined}>
              {index === sectionCursor ? '› ' : '  '}
              {entry.label}
            </Text>
          </Box>
        ))}
        <Footer hints={[['↑/↓', 'move'], ['↵', 'open'], ['esc', 'back']]} />
      </Box>
    );
  }

  if (section === 'secrets') {
    // Status and source only. There is no view in Gavel that renders a value.
    const rows = resolveSecretAudit({ env: process.env });
    return (
      <Box flexDirection="column">
        <Header title="Settings · Secrets" subtitle="Source and status only — Gavel never stores or displays a value." />
        {rows.map((row) => (
          <Box key={row.id}>
            <Box width={28}>
              <Text>{row.variable}</Text>
            </Box>
            <Box width={16}>
              <Text dimColor>source: {row.source}</Text>
            </Box>
            <Text color={row.status === 'configured' ? 'green' : undefined}>{row.status}</Text>
          </Box>
        ))}
        <Footer hints={[['esc', 'back']]} />
      </Box>
    );
  }

  const selectedValue =
    section === 'wallet'
      ? gavel.wallet.type
      : section === 'execution'
        ? gavel.execution.mode
        : section === 'inference'
          ? gavel.inference.mode
          : null;

  const selectedList =
    section === 'daos'
      ? gavel.followedDaos
      : section === 'notifications'
        ? Object.entries(gavel.notifications)
            .filter(([, value]) => value === true)
            .map(([name]) => name)
        : [];

  return (
    <Box flexDirection="column">
      <Header
        title={`Settings · ${SECTIONS.find((entry) => entry.id === section)?.label}`}
        subtitle={section === 'execution' ? `Wallet: ${gavel.wallet.type}` : undefined}
      />
      {section === 'daos' || section === 'notifications' ? (
        <CheckList choices={choices} cursor={cursor} selected={selectedList} />
      ) : (
        <RadioList choices={choices} cursor={cursor} selected={selectedValue} />
      )}
      {message ? <Text color="yellow">{message}</Text> : null}
      <Footer
        hints={[
          ['↑/↓', 'move'],
          ...(section === 'daos' || section === 'notifications'
            ? [['space', 'toggle'] as [string, string]]
            : [['↵', 'select'] as [string, string]]),
          ['esc', 'back'],
        ]}
      />
    </Box>
  );
}
