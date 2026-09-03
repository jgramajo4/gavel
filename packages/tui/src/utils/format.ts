/** Display helpers — formatting numbers, addresses, time, and vote power. */
import { formatEther } from 'viem';
import type { ProposalStatus } from '../types.js';

export function shortAddress(addr: string): string {
  if (!addr || addr.length < 10) return addr;
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, Math.max(0, max - 1))}…`;
}

/** Nouns votes are whole numbers (1 Noun = 1 vote); render as plain integers. */
export function formatVotes(v: bigint): string {
  return v.toLocaleString('en-US');
}

export function formatEth(wei: bigint, decimals = 4): string {
  const eth = Number(formatEther(wei));
  return `${eth.toFixed(decimals)} ETH`;
}

/** "2d 4h", "3h 12m", "45m", "12s", or "ended". */
export function timeRemaining(endTimestamp?: number, now = Date.now()): string {
  if (!endTimestamp) return '—';
  let secs = Math.floor((endTimestamp * 1000 - now) / 1000);
  if (secs <= 0) return 'ended';
  const d = Math.floor(secs / 86400);
  secs -= d * 86400;
  const h = Math.floor(secs / 3600);
  secs -= h * 3600;
  const m = Math.floor(secs / 60);
  secs -= m * 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${secs}s`;
}

export function relativeTime(unixSeconds: number, now = Date.now()): string {
  const secs = Math.floor((now - unixSeconds * 1000) / 1000);
  if (secs < 60) return `${secs}s ago`;
  const m = Math.floor(secs / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

const STATUS_COLORS: Record<ProposalStatus, string> = {
  ACTIVE: 'green',
  PENDING: 'yellow',
  UPDATABLE: 'yellow',
  OBJECTION_PERIOD: 'yellow',
  QUEUED: 'cyan',
  EXECUTED: 'blue',
  DEFEATED: 'red',
  VETOED: 'red',
  CANCELLED: 'gray',
  EXPIRED: 'gray',
};

export function statusColor(status: ProposalStatus): string {
  return STATUS_COLORS[status] ?? 'white';
}

/** A proposal is finished (no polling) once it reaches a terminal state. */
export function isTerminalStatus(status: ProposalStatus): boolean {
  return (
    status === 'EXECUTED' ||
    status === 'DEFEATED' ||
    status === 'VETOED' ||
    status === 'CANCELLED' ||
    status === 'EXPIRED' ||
    status === 'QUEUED'
  );
}

/** Render an ASCII progress bar, e.g. [████████░░░░░░░░] 52%. */
export function progressBar(value: number, total: number, width = 16): string {
  const ratio = total <= 0 ? 0 : Math.min(1, Math.max(0, value / total));
  const filled = Math.round(ratio * width);
  const bar = '█'.repeat(filled) + '░'.repeat(Math.max(0, width - filled));
  return `[${bar}] ${Math.round(ratio * 100)}%`;
}

