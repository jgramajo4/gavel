/** Keyboard controls shared by the wizard and settings screens. */
import React from 'react';
import { Box, Text } from 'ink';

export interface Choice {
  value: string;
  label: string;
  summary?: string;
  available?: boolean;
  blockers?: string[];
  recommended?: boolean;
}

/** A single-choice list. Unavailable options stay visible with their reason. */
export function RadioList({
  choices,
  cursor,
  selected,
}: {
  choices: Choice[];
  cursor: number;
  selected: string | null;
}) {
  return (
    <Box flexDirection="column">
      {choices.map((choice, index) => {
        const focused = index === cursor;
        const disabled = choice.available === false;
        return (
          <Box key={choice.value} flexDirection="column">
            <Box>
              <Text color={focused ? 'cyan' : undefined}>{focused ? '›' : ' '} </Text>
              <Text color={disabled ? 'gray' : undefined} bold={focused}>
                {selected === choice.value ? '◉' : '○'} {choice.label}
                {choice.recommended ? <Text color="green"> (recommended)</Text> : null}
              </Text>
            </Box>
            {choice.summary ? <Text dimColor>    {choice.summary}</Text> : null}
            {disabled && choice.blockers?.length ? (
              <Text color="yellow">    ⚠ {choice.blockers[0]}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

/** A multi-select checklist. Space toggles, Enter confirms. */
export function CheckList({
  choices,
  cursor,
  selected,
}: {
  choices: Choice[];
  cursor: number;
  selected: string[];
}) {
  return (
    <Box flexDirection="column">
      {choices.map((choice, index) => {
        const focused = index === cursor;
        const disabled = choice.available === false;
        return (
          <Box key={choice.value} flexDirection="column">
            <Box>
              <Text color={focused ? 'cyan' : undefined}>{focused ? '›' : ' '} </Text>
              <Text color={disabled ? 'gray' : undefined} bold={focused}>
                [{selected.includes(choice.value) ? 'x' : ' '}] {choice.label}
              </Text>
            </Box>
            {choice.summary ? <Text dimColor>      {choice.summary}</Text> : null}
            {disabled && choice.blockers?.length ? (
              <Text color="yellow">      ⚠ {choice.blockers[0]}</Text>
            ) : null}
          </Box>
        );
      })}
    </Box>
  );
}

export function StepChrome({
  index,
  total,
  title,
  summary,
  children,
  issues,
}: {
  index: number;
  total: number;
  title: string;
  summary: string;
  children: React.ReactNode;
  issues?: Array<{ code: string; message: string }>;
}) {
  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text color="magenta" bold>
          ⚖  Gavel setup
        </Text>
        <Text dimColor>
          {' '}
          · step {index + 1}/{total} · {title}
        </Text>
      </Box>
      <Text dimColor>{summary}</Text>
      <Box marginTop={1} flexDirection="column">
        {children}
      </Box>
      {issues?.length ? (
        <Box marginTop={1} flexDirection="column">
          {issues.map((issue) => (
            <Text key={issue.code} color="yellow">
              ⚠ {issue.message}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
