#!/usr/bin/env python3
"""Disposable PostgreSQL proof for the destructive governance integration suite.

Runs only isolated test containers; never accepts a database URL from the host.
"""
import os
import json
from pathlib import Path
import re
import secrets
import subprocess
import time

root = Path(__file__).resolve().parents[1]
name = "gavel-db-suite-" + secrets.token_hex(4)
database = "gavel_test_" + secrets.token_hex(4) + "_disposable"
password = secrets.token_urlsafe(28)
nonce = secrets.token_hex(16)
image = "gavel-reconcile-tests:42edbb4"

def run(args, env=None, timeout=150):
    return subprocess.run(args, env=env, capture_output=True, text=True, timeout=timeout)

def require(label, result):
    if result.returncode:
        raise RuntimeError(label)

network = False
started = False
health_started = False
try:
    network_args = ["docker", "network", "create", "--internal"]
    if os.getenv("GAVEL_TEST_SUBNET"):
        network_args += ["--subnet", os.environ["GAVEL_TEST_SUBNET"]]
    require("disposable network unavailable", run([*network_args, name]))
    network = True
    pg_env = {**os.environ, "POSTGRES_PASSWORD": password}
    require("disposable PostgreSQL unavailable", run([
        "docker", "run", "--rm", "-d", "--name", name, "--network", name,
        "--network-alias", "postgres", "--tmpfs", "/var/lib/postgresql/data:rw,mode=0700",
        "-e", "POSTGRES_PASSWORD", "-e", "POSTGRES_DB=" + database,
        "-e", "POSTGRES_USER=gavel", "postgres:16-alpine"], pg_env))
    started = True
    for _ in range(45):
        if run(["docker", "exec", name, "pg_isready", "-U", "gavel", "-d", database]).returncode == 0:
            break
        time.sleep(1)
    else:
        raise RuntimeError("disposable PostgreSQL not ready")
    require("database proof setup failed", run([
        "docker", "exec", name, "psql", "-U", "gavel", "-d", database,
        "-c", "COMMENT ON DATABASE " + database + " IS 'gavel-disposable:" + nonce + "'"]))
    result = run(["docker", "exec", name, "psql", "-U", "gavel", "-d", database,
                  "-At", "-c", "SELECT system_identifier FROM pg_control_system()"])
    require("cluster identifier unavailable", result)
    cluster_id = result.stdout.strip()
    if not re.fullmatch(r"[0-9]+", cluster_id):
        raise RuntimeError("invalid cluster identifier")
    # No published port; the only PostgreSQL endpoint is the internal test network.
    runner_env = {
        "GAVEL_TEST_DATABASE_URL": "postgresql://gavel:" + password + "@postgres/" + database,
        "GAVEL_TEST_DISPOSABLE_OPT_IN": "I_UNDERSTAND_DISPOSABLE_DB",
        "GAVEL_TEST_DATABASE_NONCE": nonce,
        "GAVEL_TEST_CLUSTER_ID": cluster_id,
        "NODE_PATH": "/app/node_modules",
    }
    command = ["docker", "run", "--rm", "--network", name,
               "--read-only", "--tmpfs", "/tmp:rw,exec,mode=1777",
               "-v", str(root) + ":/source:ro", "-w", "/source"]
    for key in runner_env:
        command += ["-e", key]
    command += ["--entrypoint", "node", image, "--test", "test/governance-index-postgres.test.js"]
    runner_process_env = {**os.environ, **runner_env}
    def state():
        result = run(["docker", "exec", name, "psql", "-U", "gavel", "-d", database,
                      "-At", "-c", "SELECT (SELECT count(*) FROM pg_namespace WHERE nspname='public'),"
                      "(SELECT count(*) FROM pg_roles WHERE rolname IN ('gavel_api','gavel_indexer'))"])
        require("disposable state unavailable", result)
        return result.stdout.strip()
    before = state()
    negative = run(command, runner_process_env, timeout=180)
    if negative.returncode == 0 or "not ok" not in negative.stdout or state() != before:
        raise RuntimeError("unattested cluster was not rejected before mutation")
    print("UNATTESTED_CLUSTER_REJECTED", True, flush=True)
    require("cluster proof setup failed", run([
        "docker", "exec", name, "sh", "-c",
        'printf %s "$1" > "$PGDATA/gavel-disposable-cluster.attestation"', "attest", nonce]))
    gate_database = "gavel_gate_" + secrets.token_hex(4) + "_disposable"
    require("Gate database setup failed", run(["docker", "exec", name, "createdb", "-U", "gavel", gate_database]))
    require("Gate database attestation failed", run(["docker", "exec", name, "psql", "-U", "gavel",
        "-d", gate_database, "-c", "COMMENT ON DATABASE " + gate_database + " IS 'gavel-disposable:" + nonce + "'"]))
    gate_env = {**runner_process_env, "GAVEL_GATE_TEST_DATABASE_URL":
                "postgresql://gavel:" + password + "@postgres/" + gate_database,
                "GAVEL_GATE_TEST_DATABASE_DISPOSABLE": "yes"}
    gate_command = command[:command.index("--entrypoint")]
    gate_command += ["-e", "GAVEL_GATE_TEST_DATABASE_URL", "-e", "GAVEL_GATE_TEST_DATABASE_DISPOSABLE",
                     "--entrypoint", "node", image, "--test", "--test-concurrency=1",
                     "packages/server/test/gate-store-postgres.test.js",
                     "packages/server/test/gate-reservation-lifecycle-postgres.test.js",
                     "packages/server/test/durable-persistence.test.js",
                     "packages/server/test/auth-session-environment.test.js"]
    gate = run(gate_command, gate_env, timeout=240)
    gate_counts = {key: re.findall(r"^# " + key + r" (\d+)$", gate.stdout, re.M)
                   for key in ("tests", "pass", "fail", "skipped")}
    print("GATE_SUITE_EXIT", gate.returncode,
          "COUNTS", {key: value[-1] if value else None for key, value in gate_counts.items()}, flush=True)
    if gate.returncode or not gate_counts["pass"] or gate_counts["skipped"][-1] != "0":
        print("GATE_FAILURE_NAMES", [line for line in gate.stdout.splitlines() if line.startswith("not ok ")], flush=True)
        raise RuntimeError("attested Gate integration suite failed")
    positive = run(command, runner_process_env, timeout=240)
    counts = {key: re.findall(r"^# " + key + r" (\d+)$", positive.stdout, re.M)
              for key in ("tests", "pass", "fail", "skipped")}
    print("POSTGRES_SUITE_EXIT", positive.returncode,
          "COUNTS", {key: value[-1] if value else None for key, value in counts.items()}, flush=True)
    if positive.returncode or not counts["pass"] or counts["skipped"][-1] != "0":
        print("FAILURE_NAMES", [line for line in positive.stdout.splitlines() if line.startswith("not ok ")], flush=True)
        raise RuntimeError("attested integration suite failed")
    # The production Compose command is bare Node in direct-credential mode.
    # Exercise that exact Docker health command, including checkpoint failure.
    sql = ("INSERT INTO daos(id,chain_id,from_block) VALUES('ens',1,1) ON CONFLICT DO NOTHING; "
           "INSERT INTO governance_sources(dao_id,id,kind,endpoint,from_block) "
           "VALUES('ens','governor-logs','ens-governor-logs','https://example.invalid',1) ON CONFLICT DO NOTHING; "
           "INSERT INTO sync_checkpoints(dao_id,source_id,next_block,finalized_head,last_error) "
           "VALUES('ens','governor-logs',2,1,NULL) ON CONFLICT(dao_id,source_id) "
           "DO UPDATE SET next_block=2,finalized_head=1,updated_at=now(),last_error=NULL;")
    require("health fixture setup failed", run(["docker", "exec", name, "psql", "-U", "gavel", "-d", database,
                                               "-v", "ON_ERROR_STOP=1", "-c", sql]))
    health_name = name + "-health"
    health_env = {**os.environ, "PGPASSWORD": password}
    require("disposable health container unavailable", run([
        "docker", "run", "--rm", "-d", "--name", health_name, "--network", name,
        "--health-cmd", "node packages/governance-index/bin/gavel-indexer.js health",
        "--health-interval", "2s", "--health-timeout", "5s", "--health-retries", "2",
        "-e", "PGHOST=postgres", "-e", "PGPORT=5432", "-e", "PGUSER=gavel",
        "-e", "PGPASSWORD", "-e", "PGDATABASE=" + database,
        "-e", "INDEXER_ENABLED_DAOS=ens", "--entrypoint", "sh", image, "-c", "sleep 120"], health_env))
    health_started = True
    def health():
        result = run(["docker", "inspect", health_name])
        require("health status unavailable", result)
        return json.loads(result.stdout)[0]["State"]["Health"]["Status"]
    for _ in range(25):
        if health() == "healthy": break
        time.sleep(2)
    else: raise RuntimeError("direct-credential Docker health did not become healthy")
    print("DOCKER_HEALTH_WITH_CHECKPOINT", "healthy", flush=True)
    require("health failure fixture failed", run(["docker", "exec", name, "psql", "-U", "gavel",
        "-d", database, "-v", "ON_ERROR_STOP=1", "-c",
        "UPDATE sync_checkpoints SET last_error='synthetic failure' WHERE dao_id='ens'"]))
    for _ in range(25):
        if health() == "unhealthy": break
        time.sleep(2)
    else: raise RuntimeError("Docker health ignored checkpoint failure")
    print("DOCKER_HEALTH_WITH_FAILED_CHECKPOINT", "unhealthy", flush=True)
finally:
    if health_started:
        require("disposable health cleanup failed", run(["docker", "rm", "-f", name + "-health"]))
    if started:
        require("disposable PostgreSQL cleanup failed", run(["docker", "rm", "-f", name]))
    if network:
        require("disposable network cleanup failed", run(["docker", "network", "rm", name]))
    print("DISPOSABLE_CLEANUP", True, flush=True)
