/**
 * The onboarding wizard.
 *
 * The state machine is `@gavel/core`'s `createSetupWizard()`. This file is the
 * keyboard and the pixels: it reads `wizard.options()` to know what to draw,
 * calls `wizard.apply()` to record an answer, and lets core decide whether Next
 * is allowed. No step logic lives here, so the same flow can be driven
 * headlessly by a runtime that has no terminal.
 *
 * DAO verification is the one step that touches the network, and it is
 * deliberately non-blocking: a DAO that cannot be reached shows its error and
 * the user continues. Being unable to check ENS is not a reason to prevent
 * someone from finishing setup and following Nouns.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import Spinner from 'ink-spinner';
import {
  SETUP_STEPS,
  SetupStep,
  createSetupWizard,
  resolveDaoReadiness,
  type DaoReadiness,
  type GavelConfig,
} from '@gavel/core';
import { CheckList, RadioList, StepChrome, type Choice } from './controls.js';
import { assertFresh } from '../data/governanceIndex.js';
import type { Config } from '../config.js';

type Issue = { code: string; message: string };

/**
 * Probe one DAO for the verification step.
 *
 * Only the index is reached. Voting power and delegation need a live adapter
 * and an RPC, which the TUI does not construct during setup -- the readiness
 * model reports those as unknown rather than guessing, and the main UI fills
 * them in once a wallet is attached.
 */
async function probeDao(config: Config, dao: string, identityAddress: string | null): Promise<DaoReadiness> {
  try {
    await assertFresh(config, dao);
    return resolveDaoReadiness({ dao, identityAddress, probe: { indexFresh: true } });
  } catch (error) {
    return resolveDaoReadiness({
      dao,
      identityAddress,
      probe: { error: error instanceof Error ? error.message : String(error) },
    });
  }
}

export function SetupWizard({
  config,
  onComplete,
}: {
  config: Config;
  onComplete: (next: GavelConfig) => void;
}) {
  const wizard = useMemo(
    () => createSetupWizard({ config: config.gavel, env: process.env }),
    [config.gavel],
  );
  const [, forceRender] = useState(0);
  const redraw = () => forceRender((n) => n + 1);

  const [cursor, setCursor] = useState(0);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [dataDir, setDataDir] = useState(config.gavel.runtime.dataDir ?? config.dataDir);
  const [selectedDaos, setSelectedDaos] = useState<string[]>(config.gavel.followedDaos);
  const [verifying, setVerifying] = useState(false);

  const step = wizard.step;
  const options = wizard.options();

  // Verification runs when the step is entered, once, and never blocks Next.
  useEffect(() => {
    if (step.id !== SetupStep.VERIFY) return undefined;
    let cancelled = false;
    setVerifying(true);
    void Promise.all(
      wizard.draft.followedDaos.map((dao) => probeDao(config, dao, wizard.draft.identity.address)),
    ).then((results) => {
      if (cancelled) return;
      wizard.verification = results;
      setVerifying(false);
      redraw();
    });
    return () => {
      cancelled = true;
    };
  }, [step.id, config, wizard]);

  const choices = useMemo<Choice[]>(() => {
    switch (step.id) {
      case SetupStep.DAOS:
        return options.daos.map((dao: any) => ({
          value: dao.id,
          label: `${dao.displayName}  (${dao.network})`,
          summary: dao.summary,
          available: dao.available,
        }));
      case SetupStep.WALLET:
        return options.methods.map((method: any) => ({
          value: method.type,
          label: method.label,
          summary: method.summary,
          available: method.available,
          blockers: method.blockers,
          recommended: method.recommended,
        }));
      case SetupStep.EXECUTION:
        return options.modes.map((mode: any) => ({
          value: mode.mode,
          label: mode.label,
          summary: mode.description,
          available: mode.available,
          blockers: mode.blockers,
        }));
      case SetupStep.INFERENCE:
        return options.modes.map((mode: any) => ({
          value: mode.mode,
          label: mode.label,
          summary: mode.description,
          available: mode.available,
        }));
      case SetupStep.PRIVACY:
        return options.networks.map((network: any) => ({
          value: network.network,
          label: network.label,
          available: network.available,
          blockers: network.blockers,
        }));
      case SetupStep.NOTIFICATIONS:
        return [
          { value: 'proposalAlerts', label: 'Proposal alerts', summary: 'New and closing proposals in every followed DAO.' },
          { value: 'dailyBriefing', label: 'Daily briefing', summary: 'One summary across all followed DAOs.' },
          { value: 'executionAlerts', label: 'Execution alerts', summary: 'When a prepared action needs you.' },
          ...(options.calendarAvailable
            ? [{ value: 'calendarReminders', label: 'Governance call reminders' }]
            : []),
        ];
      default:
        return [];
    }
  }, [step.id, options]);

  const notificationSelections = useMemo(
    () =>
      Object.entries(wizard.draft.notifications)
        .filter(([, value]) => value === true)
        .map(([key]) => key),
    [wizard.draft.notifications, step.id],
  );

  const commit = (value: unknown) => {
    const result = wizard.apply(step.id, value);
    setIssues(result.issues);
    return result.ok;
  };

  const advance = () => {
    // Record the current step's answer before asking core to advance.
    if (step.id === SetupStep.DATA_DIR) commit({ dataDir });
    if (step.id === SetupStep.DAOS && !commit({ daos: selectedDaos })) return;
    const result = wizard.next();
    setIssues(result.issues);
    if (result.ok) {
      setCursor(0);
      redraw();
    }
  };

  useInput((input, key) => {
    if (key.escape) {
      wizard.back();
      setIssues([]);
      setCursor(0);
      redraw();
      return;
    }
    if (step.id === SetupStep.DATA_DIR) {
      if (key.return) advance();
      return;
    }
    if (key.downArrow || input === 'j') {
      setCursor((c) => Math.min(Math.max(choices.length - 1, 0), c + 1));
      return;
    }
    if (key.upArrow || input === 'k') {
      setCursor((c) => Math.max(0, c - 1));
      return;
    }
    if (input === ' ') {
      const choice = choices[cursor];
      if (!choice) return;
      if (step.id === SetupStep.DAOS) {
        setSelectedDaos((current) =>
          current.includes(choice.value)
            ? current.filter((id) => id !== choice.value)
            : [...current, choice.value],
        );
      } else if (step.id === SetupStep.NOTIFICATIONS) {
        commit({ [choice.value]: !notificationSelections.includes(choice.value) });
        redraw();
      }
      return;
    }
    if (key.return) {
      const choice = choices[cursor];
      if (step.id === SetupStep.WALLET && choice) {
        if (!commit({ type: choice.value })) return;
      } else if (step.id === SetupStep.EXECUTION && choice) {
        if (!commit({ mode: choice.value })) return;
      } else if (step.id === SetupStep.INFERENCE && choice) {
        if (!commit({ mode: choice.value })) return;
      } else if (step.id === SetupStep.PRIVACY && choice) {
        if (!commit({ network: choice.value })) return;
      }
      if (step.id === SetupStep.FINISH) {
        const finished = wizard.finish();
        setIssues(finished.issues);
        if (finished.ok) onComplete(finished.config);
        return;
      }
      advance();
    }
  });

  const index = SETUP_STEPS.findIndex((entry) => entry.id === step.id);
  const chrome = (children: React.ReactNode) => (
    <StepChrome index={index} total={SETUP_STEPS.length} title={step.title} summary={step.summary} issues={issues}>
      {children}
      <Box marginTop={1}>
        <Text dimColor>
          <Text color="cyan">↵</Text> continue  <Text color="cyan">esc</Text> back
          {step.id === SetupStep.DAOS || step.id === SetupStep.NOTIFICATIONS ? (
            <Text>
              {'  '}
              <Text color="cyan">space</Text> toggle
            </Text>
          ) : null}
        </Text>
      </Box>
    </StepChrome>
  );

  switch (step.id) {
    case SetupStep.WELCOME:
      return chrome(
        <Box flexDirection="column">
          <Text>· Gavel follows governance across the DAOs you choose.</Text>
          <Text>· Recommendations run locally, or through inference you configure.</Text>
          <Text>· Signing stays with the wallet and execution mode you pick.</Text>
        </Box>,
      );

    case SetupStep.DATA_DIR:
      return chrome(
        <Box flexDirection="column">
          <Box>
            <Text dimColor>Directory  </Text>
            <TextInput value={dataDir} onChange={setDataDir} />
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text dimColor>Stored here:</Text>
            {options.contents.stored.map((line: string) => (
              <Text key={line} dimColor>
                {'  · '}
                {line}
              </Text>
            ))}
            <Text dimColor>Never stored here:</Text>
            {options.contents.notStored.map((line: string) => (
              <Text key={line} color="green">
                {'  · '}
                {line}
              </Text>
            ))}
          </Box>
        </Box>,
      );

    case SetupStep.DAOS:
      return chrome(<CheckList choices={choices} cursor={cursor} selected={selectedDaos} />);

    case SetupStep.WALLET:
      return chrome(<RadioList choices={choices} cursor={cursor} selected={options.selected} />);

    case SetupStep.VERIFY:
      return chrome(
        <Box flexDirection="column">
          {verifying ? (
            <Text>
              <Spinner type="dots" /> Checking your followed DAOs…
            </Text>
          ) : wizard.verification.length === 0 ? (
            <Text dimColor>No DAOs to check.</Text>
          ) : (
            wizard.verification.map((result) => (
              <Box key={result.dao} flexDirection="column">
                <Box>
                  <Box width={14}>
                    <Text bold>{result.displayName}</Text>
                  </Box>
                  <Text color={result.usable ? 'green' : 'red'}>
                    {result.usable ? 'reachable' : 'unavailable'}
                  </Text>
                </Box>
                {result.reasons.map((reason) => (
                  <Text
                    key={reason.code}
                    color={reason.severity === 'error' ? 'red' : reason.severity === 'warning' ? 'yellow' : undefined}
                    dimColor={reason.severity === 'info'}
                  >
                    {'  '}
                    {reason.message}
                  </Text>
                ))}
              </Box>
            ))
          )}
          <Box marginTop={1}>
            <Text dimColor>A DAO that is down does not block setup. You can continue.</Text>
          </Box>
        </Box>,
      );

    case SetupStep.EXECUTION:
    case SetupStep.INFERENCE:
    case SetupStep.PRIVACY:
      return chrome(<RadioList choices={choices} cursor={cursor} selected={options.selected} />);

    case SetupStep.NOTIFICATIONS:
      return chrome(<CheckList choices={choices} cursor={cursor} selected={notificationSelections} />);

    case SetupStep.REVIEW:
      return chrome(<ReviewPanel review={options} />);

    case SetupStep.FINISH:
      return chrome(
        <Box flexDirection="column">
          <Text color="green">Setup complete.</Text>
          <Text dimColor>Press ↵ to open Gavel.</Text>
        </Box>,
      );

    default:
      return chrome(<Text dimColor>…</Text>);
  }
}

/** The review page. Everything it renders has already been through redaction. */
function ReviewPanel({ review }: { review: any }) {
  return (
    <Box flexDirection="column">
      <Text bold>DAOs</Text>
      {review.daos.map((dao: any) => (
        <Box key={dao.id}>
          <Box width={14}>
            <Text>{'  '}{dao.displayName}</Text>
          </Box>
          <Text dimColor={!dao.followed}>{dao.status}</Text>
        </Box>
      ))}
      <Text bold>Wallet</Text>
      <Text>
        {'  '}
        {review.wallet.label}
        {review.wallet.address ? ` · ${review.wallet.address}` : ''}
      </Text>
      {review.wallet.signerSource?.variable ? (
        <Text dimColor>
          {'  '}Signer: {review.wallet.signerSource.kind} · Variable: {review.wallet.signerSource.variable}
        </Text>
      ) : null}
      <Text bold>Execution</Text>
      <Text>{'  '}{review.execution.label}</Text>
      <Text bold>Recommendations</Text>
      <Text>{'  '}{review.inference.mode}</Text>
      <Text bold>Private data</Text>
      <Text>{'  '}{review.privateData.dataDir ?? '(default)'}</Text>
      <Text bold>Secrets</Text>
      {review.secrets.map((secret: any) => (
        <Text key={secret.id} dimColor>
          {'  '}
          {secret.variable}: {secret.status} (source: {secret.source})
        </Text>
      ))}
      <Box marginTop={1}>
        <Text bold>Overall </Text>
        <Text color={review.overall === 'Ready' ? 'green' : 'yellow'}>{review.overall}</Text>
      </Box>
    </Box>
  );
}
