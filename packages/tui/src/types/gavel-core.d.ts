/**
 * Types for the parts of `@gavel/core` the TUI consumes.
 *
 * Core is CommonJS JavaScript, so there is nothing to import types from. This
 * declares the shape of the surface the TUI actually uses -- the DAO catalog,
 * the config model, the wizard state machine, readiness and the inbox view
 * model -- which keeps the boundary explicit: anything the TUI wants from core
 * has to be named here first, and anything not named here is not reachable
 * from a component.
 */
declare module '@gavel/core' {
  export type DaoCapabilityKey =
    | 'proposals'
    | 'voting'
    | 'delegation'
    | 'calendar'
    | 'votingPowerQueries'
    | 'proposalDecoding'
    | 'privateVoting'
    | 'analyze'
    | 'predict'
    | 'prepareVote'
    | 'eoaSupervised'
    | 'safeSupervised'
    | 'waapAutonomous';

  export interface DaoDescriptor {
    id: string;
    displayName: string;
    network: string;
    chainId: number;
    status: string;
    summary: string;
    terminology: Record<string, string>;
    capabilities: Record<DaoCapabilityKey, boolean>;
  }

  export function listDaoDescriptors(): DaoDescriptor[];
  export function listDaoIds(): string[];
  export function findDaoDescriptor(id: string): DaoDescriptor | null;
  export function getDaoDescriptor(id: string): DaoDescriptor;
  export function daoDisplayName(id: string): string;
  export function daoTerm(id: string, key: string): string;
  export function daoSupports(id: string, capability: string): boolean;
  export function daoCapabilityMatrix(ids?: string[]): Array<{
    id: string;
    displayName: string;
    capabilities: Array<{ capability: string; supported: boolean }>;
  }>;
  export function normalizeDaoSelection(ids: string[]): { selected: string[]; unknown: string[] };

  export function daoProposalKey(dao: string, proposalId: string | number | bigint): string;
  export function formatDaoProposal(dao: string, proposalId: string | number | bigint): string;

  export interface GavelConfig {
    schemaVersion: string;
    runtime: { dataDir: string | null; indexApiUrl: string | null };
    identity: { address: string | null; label: string | null };
    wallet: {
      type: 'read-only' | 'local' | 'walletconnect';
      local: { signer: 'keystore' | 'environment'; keystoreLabel: string | null; variable: string | null } | null;
      walletconnect: {
        projectIdVariable: string | null;
        session: { topic: string | null; account: string | null; chainId: number | null; expiresAt: string | null } | null;
      } | null;
    };
    execution: {
      mode: string;
      safe: { address: string; chainId: number; proposerIdentity: string | null } | null;
      autonomous: { executionAddress: string; policyId: string | null; acknowledgedAt: string | null } | null;
      payoutAddress: string | null;
    };
    followedDaos: string[];
    inference: { mode: 'local' | 'remote' | 'runtime'; endpointVariable: string | null };
    privacy: { network: 'direct' | 'tor' | 'nym' };
    notifications: {
      proposalAlerts: boolean;
      dailyBriefing: boolean;
      executionAlerts: boolean;
      calendarReminders: boolean;
    };
    onboarding: { completed: boolean; completedAt: string | null; lastStep: string | null };
    migrationNotes: Array<{ at: string; code: string; message: string }>;
  }

  export interface ConfigIssue {
    code: string;
    message: string;
    path?: string;
  }

  export function defaultGavelConfig(overrides?: Record<string, unknown>): GavelConfig;
  export function parseGavelConfig(document: unknown): GavelConfig;
  export function validateGavelConfig(config: unknown): { config: GavelConfig; issues: ConfigIssue[]; valid: boolean };
  export function loadGavelConfig(options?: Record<string, unknown>): Promise<{
    config: GavelConfig;
    path: string;
    dataDir: string;
    exists: boolean;
    migrated: boolean;
    notes: Array<{ at: string; code: string; message: string }>;
  }>;
  export function saveGavelConfig(
    config: unknown,
    options?: Record<string, unknown>,
  ): Promise<{ config: GavelConfig; path: string; dataDir: string }>;
  export function serializeGavelConfig(config: unknown): unknown;
  export function redactSecrets(value: unknown): unknown;
  export function resolveSecretAudit(options?: Record<string, unknown>): Array<{
    id: string;
    label: string;
    source: string;
    variable: string;
    status: string;
    requiredFor: string;
    required: boolean;
  }>;
  export function resolveDataDir(options?: Record<string, unknown>): string;
  export function privatePath(dataDir: string, ...segments: string[]): string;

  export interface WalletMethod {
    type: 'read-only' | 'local' | 'walletconnect';
    label: string;
    summary: string;
    recommended: boolean;
    available: boolean;
    blockers: string[];
    signerSources?: Array<{ kind: string; available: boolean; variable?: string; labels?: string[] }>;
  }
  export function listWalletMethods(options?: Record<string, unknown>): WalletMethod[];
  export function shortAddress(address: string | null): string;

  export interface SetupStepDescriptor {
    id: string;
    title: string;
    summary: string;
    advisory?: boolean;
  }
  export const SETUP_STEPS: SetupStepDescriptor[];
  export const SetupStep: Record<string, string>;
  export const DATA_DIR_CONTENTS: { stored: string[]; notStored: string[] };

  export interface SetupWizardInstance {
    readonly steps: SetupStepDescriptor[];
    readonly step: SetupStepDescriptor;
    readonly stepId: string;
    readonly isFirst: boolean;
    readonly isLast: boolean;
    draft: GavelConfig;
    verification: DaoReadiness[];
    options(): any;
    apply(stepId: string, value: unknown): { ok: boolean; issues: ConfigIssue[]; config: GavelConfig };
    blockers(): ConfigIssue[];
    canAdvance(): boolean;
    next(): { ok: boolean; issues: ConfigIssue[]; step: SetupStepDescriptor };
    back(): { ok: boolean; step: SetupStepDescriptor };
    goto(stepId: string): SetupStepDescriptor;
    review(): any;
    finish(): { ok: boolean; issues: ConfigIssue[]; config: GavelConfig };
  }
  export function createSetupWizard(options?: Record<string, unknown>): SetupWizardInstance;
  export function listExecutionOptions(input?: Record<string, unknown>): Array<{
    mode: string;
    kind: string;
    label: string;
    description: string;
    available: boolean;
    blockers: string[];
    supportedDaos: string[];
  }>;

  export interface ReadinessReason {
    code: string;
    message: string;
    severity: 'info' | 'warning' | 'error';
  }
  export interface DaoReadiness {
    dao: string;
    displayName: string;
    chainId: number;
    signals: { index: string; identity: string; vote: string };
    monitor: string;
    analyze: string;
    vote: string;
    votingPower: string | null;
    votingPowerLabel: string;
    delegation: string | null;
    delegationLabel: string;
    usable: boolean;
    level: string;
    reasons: ReadinessReason[];
  }
  export const ReadinessLevel: Record<string, string>;
  export function resolveDaoReadiness(input: Record<string, unknown>): DaoReadiness;
  export function resolveRuntimeReadiness(input: Record<string, unknown>): {
    level: string;
    signals: Record<string, string>;
    reasons: ReadinessReason[];
    executionMode: string;
    humanApprovalRequired: boolean;
    walletType: string;
  };
  export function summarizeGavelReadiness(input: Record<string, unknown>): {
    level: string;
    canLaunch: boolean;
    runtime: { level: string; signals: Record<string, string>; reasons: ReadinessReason[] };
    daos: DaoReadiness[];
    counts: { followed: number; monitorable: number; votable: number; unavailable: number };
  };

  export interface InboxEntry {
    key: string;
    dao: string;
    daoDisplayName: string;
    chainId: number | null;
    proposalId: string;
    label: string;
    title: string;
    state: string;
    endsIn: number | null;
    endsAt: number | null;
    voted: boolean;
    recommendation: string | null;
    attention: string | null;
    needsAttention: boolean;
  }
  export interface GovernanceInbox {
    needsAttention: InboxEntry[];
    proposals: InboxEntry[];
    daos: Array<{
      dao: string;
      displayName: string;
      active: number;
      needsAttention: number;
      total: number;
      available: boolean;
      error: string | null;
      monitor: string | null;
      vote: string | null;
    }>;
    counts: { followed: number; available: number; unavailable: number; needsAttention: number };
  }
  export function buildGovernanceInbox(input: Record<string, unknown>): GovernanceInbox;
  export function filterInboxByDao(inbox: GovernanceInbox, dao: string | null): GovernanceInbox;
}
