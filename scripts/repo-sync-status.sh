#!/usr/bin/env bash
# Report local / Forgejo (origin) / GitHub (github) main parity. Read-only: fetches, never pushes.
# Usage: scripts/repo-sync-status.sh [branch]   (default: main)
set -euo pipefail
branch="${1:-main}"
cd "$(git rev-parse --show-toplevel)"

for remote in origin github; do
  git remote get-url "$remote" >/dev/null 2>&1 || { echo "missing remote: $remote" >&2; exit 2; }
done

git fetch --quiet origin "$branch" || { echo "cannot fetch origin/$branch (missing branch or Forgejo unreachable)" >&2; exit 2; }
git fetch --quiet github "$branch" || echo "warning: github fetch failed; using last known github/$branch" >&2

ref() { git rev-parse --verify --quiet "refs/remotes/$1/$branch^{commit}" || echo missing; }
forgejo="$(ref origin)"
github="$(ref github)"
if [ "$forgejo" = missing ]; then
  echo "origin/$branch not found; cannot compare (Forgejo is authoritative)" >&2
  exit 2
fi
head="$(git rev-parse HEAD)"

echo "worktree:       $(pwd)"
echo "current branch: $(git branch --show-current || true)"
echo "HEAD:           $head"
echo "origin/$branch: $forgejo  (Forgejo, authoritative)"
echo "github/$branch: $github  (publication mirror)"
echo "dirty files:    $(git status --porcelain | wc -l | tr -d ' ')"

status=0
if [ "$github" = missing ]; then
  echo "RESULT: github/$branch unknown"; status=1
elif [ "$forgejo" = "$github" ]; then
  echo "RESULT: in sync"
else
  ahead="$(git rev-list --count "github/$branch..origin/$branch")"
  github_only="$(git rev-list --count "origin/$branch..github/$branch")"
  echo "RESULT: diverged — Forgejo ahead by $ahead, GitHub-only commits: $github_only"
  if [ "$github_only" -gt 0 ]; then
    echo "STOP: GitHub has commits missing from Forgejo; reconcile before publishing." >&2
  fi
  status=1
fi
echo "HEAD vs origin/$branch: behind $(git rev-list --count "HEAD..origin/$branch"), ahead $(git rev-list --count "origin/$branch..HEAD")"
exit "$status"
