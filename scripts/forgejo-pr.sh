#!/usr/bin/env python3
"""Read-only Forgejo PR summary. Usage: scripts/forgejo-pr.sh <number> [--files]

Auth: FORGEJO_TOKEN if set; otherwise the Pi machine account via Bitwarden Secrets
Manager. Set FORGEJO_BWS_SECRET_ID to fetch one secret by id (preferred); else the
secret named FORGEJO_BWS_SECRET (default "Forgejo Pallax API") is looked up.
The machine token is read from ~/.config/bitwarden-secrets-manager/token.

Safety: GET requests only. The token is never printed or put on a command line.
Redirects are refused so the Authorization header is never re-sent elsewhere.
Only the hosts in FORGEJO_ALLOWED_HOSTS (default "eros") receive the token.
The default Forgejo URL is plain HTTP on the home LAN; the token crosses the LAN
unencrypted, as with any other client of this instance.
"""
import json
import os
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE = os.environ.get("FORGEJO_URL", "http://eros:3003").rstrip("/")
REPO = os.environ.get("FORGEJO_REPO", "gramajo/gavel")
SECRET_ID = os.environ.get("FORGEJO_BWS_SECRET_ID", "")
SECRET_NAME = os.environ.get("FORGEJO_BWS_SECRET", "Forgejo Pallax API")
ALLOWED_HOSTS = {h.strip() for h in os.environ.get("FORGEJO_ALLOWED_HOSTS", "eros").split(",") if h.strip()}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise urllib.error.HTTPError(req.full_url, code, "redirect refused (token not forwarded)", headers, fp)


OPENER = urllib.request.build_opener(NoRedirect)


def bws(args, machine):
    env = {**os.environ, "BWS_ACCESS_TOKEN": machine}
    try:
        result = subprocess.run(["bws", *args, "-o", "json"], env=env, capture_output=True, text=True, check=False)
    except OSError:
        sys.exit("bws is not installed or not executable")
    if result.returncode:
        sys.exit(f"bws {args[0]} {args[1]} failed")
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        sys.exit("bws returned non-JSON output")


def token():
    if os.environ.get("FORGEJO_TOKEN"):
        return os.environ["FORGEJO_TOKEN"].strip()
    path = os.path.expanduser("~/.config/bitwarden-secrets-manager/token")
    try:
        with open(path, encoding="utf-8") as handle:
            machine = handle.read().strip()
    except OSError:
        sys.exit("no FORGEJO_TOKEN and no Bitwarden machine token file")
    if SECRET_ID:
        return str(bws(["secret", "get", SECRET_ID], machine).get("value", "")).strip() or sys.exit("empty secret")
    matches = [s for s in bws(["secret", "list"], machine) if s.get("key") == SECRET_NAME]
    if len(matches) != 1:
        sys.exit(f"expected exactly one Bitwarden secret named {SECRET_NAME!r}; set FORGEJO_BWS_SECRET_ID")
    return matches[0]["value"].strip()


def check_base():
    parsed = urllib.parse.urlsplit(BASE)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in ALLOWED_HOSTS:
        sys.exit(f"refusing to send the token to {parsed.hostname!r}; allowed: {sorted(ALLOWED_HOSTS)}")


def get(path, auth):
    request = urllib.request.Request(f"{BASE}/api/v1/repos/{REPO}{path}",
                                     headers={"Authorization": "token " + auth, "Accept": "application/json"})
    try:
        with OPENER.open(request, timeout=20) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        hint = " (no such PR, or the token cannot see this private repo)" if error.code == 404 else ""
        sys.exit(f"GET {path}: HTTP {error.code}{hint}")
    except (urllib.error.URLError, TimeoutError, OSError) as error:
        sys.exit(f"GET {path}: {type(error).__name__}")
    except json.JSONDecodeError:
        sys.exit(f"GET {path}: non-JSON response")


def main(argv):
    if not argv or not argv[0].isdigit():
        sys.exit(__doc__)
    check_base()
    number = argv[0]
    auth = token()
    pr = get(f"/pulls/{number}", auth)
    print(f"PR #{pr['number']}: {pr['title']}")
    print(f"url:    {pr['html_url']}")
    print(f"state:  {pr['state']}  merged: {pr['merged']}  mergeable: {pr.get('mergeable')}")
    print(f"head:   {pr['head']['ref']} @ {pr['head']['sha']}")
    print(f"base:   {pr['base']['ref']} @ {pr['base']['sha']}")
    print(f"author: {pr['user']['login']}")
    if pr.get("merge_commit_sha"):
        print(f"merge:  {pr['merge_commit_sha']}")
    print(f"verify: git ls-remote origin refs/pull/{number}/head  # must equal head sha")
    if "--files" in argv:
        for item in get(f"/pulls/{number}/files", auth):
            print(f"  {item['status']:<9} +{item['additions']:<5} -{item['deletions']:<5} {item['filename']}")


if __name__ == "__main__":
    main(sys.argv[1:])
