-- Gate schema migration gate/001_gate-v3.
-- Deliberately has no BEGIN/COMMIT: the migration runner owns transaction scope.
CREATE TABLE IF NOT EXISTS public.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  migration_checksum text,
  catalog_manifest jsonb
);
ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS migration_checksum text;
ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS catalog_manifest jsonb;

DO $$
DECLARE
  marked boolean;
  existing_objects integer;
  installed_tables integer;
  stored_manifest jsonb;
  current_manifest jsonb;
BEGIN
  SELECT EXISTS (SELECT 1 FROM public.schema_migrations WHERE version='gate/001_gate-v3') INTO marked;
  SELECT count(*) INTO existing_objects FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='gate' AND c.relkind IN ('r','p','v','m','S');
  SELECT count(*) INTO installed_tables FROM information_schema.tables WHERE table_schema='gate' AND table_name=ANY(ARRAY[
    'profiles','dao_policies','auth_nonces','auth_sessions','proposal_snapshots','splitter_deployments','submissions','quotes',
    'capacity_reservations','inbox_items','notification_attempts','sender_blocks','rate_limit_events','delivery_settings',
    'settlement_cursors','settlement_scan_ranges','settlement_scan_blocks','settlement_scan_observations','settlement_reorg_monitors',
    'profile_version_authorizations']);
  IF marked THEN
    IF to_regprocedure('public.gavel_gate_catalog_manifest()') IS NOT NULL THEN
      SELECT catalog_manifest INTO stored_manifest FROM public.schema_migrations WHERE version='gate/001_gate-v3';
      SELECT public.gavel_gate_catalog_manifest() INTO current_manifest;
    END IF;
    IF to_regclass('gate.profiles') IS NULL
       OR current_manifest IS DISTINCT FROM stored_manifest
       OR obj_description(to_regclass('gate.profiles'), 'pg_class') IS DISTINCT FROM 'gavel gate 001 v3'
       OR ((SELECT migration_checksum FROM public.schema_migrations WHERE version='gate/001_gate-v3')
          = 'sha256:gate-001-v3-postgres-parity' AND installed_tables <> 19)
       OR ((SELECT migration_checksum FROM public.schema_migrations WHERE version='gate/001_gate-v3')
          = 'sha256:gate-001-v3-durable-auth-profile' AND installed_tables <> 20)
       OR ((SELECT migration_checksum FROM public.schema_migrations WHERE version='gate/001_gate-v3')
          = 'sha256:gate-001-v3-durable-auth-profile-hardening' AND installed_tables <> 20)
       OR ((SELECT migration_checksum FROM public.schema_migrations WHERE version='gate/001_gate-v3')
          IN ('sha256:gate-001-v3-legacy-upgrade-hardening','sha256:gate-001-v3-closed-base-environments',
            'sha256:gate-001-v3-agentmail-idempotency','sha256:gate-001-v3-bound-delivery-settings') AND installed_tables <> 20)
       OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='gate' AND table_name='quotes'
         AND column_name='settlement_scanner_verified' AND is_nullable='YES' AND data_type='boolean')
       OR NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='gate' AND table_name='settlement_scan_ranges'
         AND column_name='scanner_result' AND is_nullable='NO' AND data_type='jsonb')
       OR ((SELECT migration_checksum FROM public.schema_migrations WHERE version='gate/001_gate-v3')
          NOT IN ('sha256:gate-001-v3-closed-base-environments','sha256:gate-001-v3-agentmail-idempotency',
            'sha256:gate-001-v3-bound-delivery-settings') AND NOT EXISTS(
            SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
            WHERE n.nspname='gate' AND t.relname='quotes' AND c.contype='c'
              AND pg_get_constraintdef(c.oid) LIKE '%base_chain_id = 8453%'))
       OR ((SELECT migration_checksum FROM public.schema_migrations WHERE version='gate/001_gate-v3')
          IN ('sha256:gate-001-v3-closed-base-environments','sha256:gate-001-v3-agentmail-idempotency',
            'sha256:gate-001-v3-bound-delivery-settings') AND (
            NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
              WHERE n.nspname='gate' AND t.relname='quotes' AND c.conname='quotes_base_chain_check')
            OR NOT EXISTS(SELECT 1 FROM pg_constraint c JOIN pg_class t ON t.oid=c.conrelid JOIN pg_namespace n ON n.oid=t.relnamespace
              WHERE n.nspname='gate' AND t.relname='splitter_deployments' AND c.conname='splitter_deployments_environment_check')
            OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
              WHERE n.nspname='gate' AND p.proname='validate_relational_bindings' AND p.pronargs=0)
            OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='gate' AND c.relname='quotes' AND t.tgname='quotes_validate_bindings' AND NOT t.tgisinternal)
            OR NOT EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
              WHERE n.nspname='gate' AND c.relname='splitter_deployments'
                AND t.tgname='splitter_deployments_immutable_identity' AND NOT t.tgisinternal)))
       OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='gate' AND p.proname='mutate_profile' AND p.pronargs=12)
       OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='gate' AND p.proname='mutate_profile' AND p.pronargs=11)
       OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='gate' AND p.proname='validate_relational_bindings' AND p.pronargs=0)
       OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='gate' AND p.proname='transition_notification' AND p.pronargs=7)
       OR NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname='gate' AND p.proname='transition_notification' AND p.pronargs=4)
       OR COALESCE((SELECT migration_checksum FROM public.schema_migrations WHERE version='gate/001_gate-v3'),'')
          NOT IN ('sha256:gate-001-v3-postgres-parity','sha256:gate-001-v3-durable-auth-profile',
            'sha256:gate-001-v3-durable-auth-profile-hardening','sha256:gate-001-v3-legacy-upgrade-hardening',
            'sha256:gate-001-v3-closed-base-environments','sha256:gate-001-v3-agentmail-idempotency',
            'sha256:gate-001-v3-bound-delivery-settings')
       OR ((SELECT migration_checksum FROM public.schema_migrations WHERE version='gate/001_gate-v3')
          = 'sha256:gate-001-v3-durable-auth-profile' AND (
            to_regclass('gate.auth_sessions') IS NULL
            OR to_regprocedure('gate.insert_auth_nonce(gate.auth_proof_type,gate.auth_purpose,gate.auth_role,text,text,bigint,text,text,text,bigint,bigint)') IS NULL
            OR to_regprocedure('gate.consume_auth_nonce(text,bigint)') IS NULL
            OR to_regprocedure('gate.insert_auth_session(text,text,gate.auth_role,bigint,text,bigint,bigint)') IS NULL)) THEN
      RAISE EXCEPTION 'gate/001_gate-v3 marker does not match installed Gate schema';
    END IF;
  ELSIF existing_objects <> 0 THEN
    RAISE EXCEPTION 'refusing gate/001_gate-v3 over an unmarked Gate schema';
  END IF;
END $$;

CREATE SCHEMA IF NOT EXISTS gate;
REVOKE ALL ON SCHEMA gate FROM PUBLIC;

DO $$ BEGIN CREATE TYPE gate.availability AS ENUM ('accepting_now','paused','closed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE gate.lifecycle AS ENUM ('PRE_VOTE','VOTING','CLOSED','UNKNOWN'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE gate.auth_proof_type AS ENUM ('GateEnrollment','BasePayoutControl','WalletSession'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE gate.auth_purpose AS ENUM ('enrollment','base_payout_control','wallet_session'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE gate.auth_role AS ENUM ('base_sender','dao_profile','dao_inbox'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE gate.quote_state AS ENUM ('quoted','expired','settled'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE gate.reservation_state AS ENUM ('active','expiry_pending_reconciliation','released','consumed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE gate.notification_state AS ENUM ('pending','sent','failed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS gate.profiles (
  id text PRIMARY KEY,
  wallet text NOT NULL UNIQUE CHECK (wallet ~ '^0x[0-9a-f]{40}$'),
  wallet_kind text NOT NULL CHECK (wallet_kind IN ('eoa','contract')),
  availability gate.availability NOT NULL DEFAULT 'paused',
  profile_version bigint NOT NULL DEFAULT 1 CHECK (profile_version > 0),
  enrolled_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  base_payout_verified_at timestamptz,
  base_payout_code_hash text CHECK (base_payout_code_hash IS NULL OR base_payout_code_hash ~ '^0x[0-9a-f]{64}$'),
  display_cache jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(display_cache)='object')
);
ALTER TABLE gate.profiles DROP CONSTRAINT IF EXISTS profiles_public_display_shape;
UPDATE gate.profiles
SET display_cache =
  CASE WHEN jsonb_typeof(display_cache->'ens') IN ('string','null')
    THEN jsonb_build_object('ens',display_cache->'ens') ELSE '{}'::jsonb END
  || CASE WHEN jsonb_typeof(display_cache->'message') IN ('string','null')
    THEN jsonb_build_object('message',display_cache->'message') ELSE '{}'::jsonb END
WHERE display_cache IS DISTINCT FROM
  CASE WHEN jsonb_typeof(display_cache->'ens') IN ('string','null')
    THEN jsonb_build_object('ens',display_cache->'ens') ELSE '{}'::jsonb END
  || CASE WHEN jsonb_typeof(display_cache->'message') IN ('string','null')
    THEN jsonb_build_object('message',display_cache->'message') ELSE '{}'::jsonb END;
ALTER TABLE gate.profiles ADD CONSTRAINT profiles_public_display_shape CHECK (
  jsonb_typeof(display_cache)='object'
  AND display_cache - ARRAY['ens','message']::text[] = '{}'::jsonb
  AND (NOT (display_cache ? 'ens') OR jsonb_typeof(display_cache->'ens') IN ('string','null'))
  AND (NOT (display_cache ? 'message') OR jsonb_typeof(display_cache->'message') IN ('string','null'))
);
COMMENT ON TABLE gate.profiles IS 'gavel gate 001 v3';

CREATE TABLE IF NOT EXISTS gate.profile_version_authorizations (
  transaction_id bigint NOT NULL, profile_id text NOT NULL, target_version bigint NOT NULL,
  PRIMARY KEY(transaction_id,profile_id)
);

CREATE OR REPLACE FUNCTION gate.bump_profile_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE authorized boolean;
BEGIN
  IF ROW(NEW.wallet,NEW.wallet_kind,NEW.availability,NEW.base_payout_verified_at,NEW.base_payout_code_hash,NEW.display_cache)
     IS DISTINCT FROM ROW(OLD.wallet,OLD.wallet_kind,OLD.availability,OLD.base_payout_verified_at,OLD.base_payout_code_hash,OLD.display_cache) THEN
    NEW.profile_version := OLD.profile_version + 1;
    NEW.updated_at := clock_timestamp();
  ELSIF NEW.profile_version IS DISTINCT FROM OLD.profile_version THEN
    DELETE FROM gate.profile_version_authorizations
      WHERE transaction_id=txid_current() AND profile_id=OLD.id AND target_version=NEW.profile_version
      RETURNING true INTO authorized;
    IF NOT COALESCE(authorized,false) OR NEW.profile_version <> OLD.profile_version + 1 THEN
      RAISE EXCEPTION 'profile_version is managed by Gate' USING ERRCODE='23514';
    END IF;
    NEW.updated_at := clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS profiles_bump_version ON gate.profiles;
CREATE TRIGGER profiles_bump_version BEFORE UPDATE ON gate.profiles FOR EACH ROW EXECUTE FUNCTION gate.bump_profile_version();

CREATE TABLE IF NOT EXISTS gate.dao_policies (
  id bigserial PRIMARY KEY,
  profile_id text NOT NULL REFERENCES gate.profiles(id),
  dao text NOT NULL CHECK (dao ~ '^[a-z][a-z0-9-]{0,62}$'),
  chain_id bigint NOT NULL CHECK (chain_id > 0),
  enabled boolean NOT NULL DEFAULT true,
  accept_pre_vote boolean NOT NULL,
  accept_voting boolean NOT NULL,
  attention_amount numeric(78,0) NOT NULL CHECK (attention_amount >= 1000000),
  pending_reservation_capacity integer NOT NULL DEFAULT 12 CHECK (pending_reservation_capacity > 0),
  settled_capacity integer NOT NULL DEFAULT 25 CHECK (settled_capacity > 0),
  CHECK (pending_reservation_capacity <= settled_capacity / 2),
  public_tags jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(public_tags)='array'),
  UNIQUE (profile_id,dao)
);
ALTER TABLE gate.dao_policies DROP CONSTRAINT IF EXISTS dao_policies_nouns_policy_check;
DO $$
DECLARE legacy_constraint name;
BEGIN
  FOR legacy_constraint IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid='gate.dao_policies'::regclass AND c.contype='c'
      AND position('nouns' in lower(pg_get_constraintdef(c.oid))) > 0
  LOOP
    EXECUTE format('ALTER TABLE gate.dao_policies DROP CONSTRAINT %I',legacy_constraint);
  END LOOP;
END $$;
UPDATE gate.dao_policies
SET enabled=false
WHERE dao='nouns' AND accept_voting=false AND enabled=true;
ALTER TABLE gate.dao_policies ADD CONSTRAINT dao_policies_nouns_policy_check CHECK (
  dao <> 'nouns' OR (chain_id = 1 AND accept_pre_vote = false AND (enabled = false OR accept_voting = true))
);
DROP TRIGGER IF EXISTS dao_policies_bump_profile_version ON gate.dao_policies;

CREATE OR REPLACE FUNCTION gate.mutate_profile(
  p_id text,p_wallet text,p_wallet_kind text,p_availability gate.availability,p_display jsonb,p_has_display boolean,
  p_verified_at timestamptz,p_has_verified_at boolean,p_code_hash text,p_has_code_hash boolean,p_policy jsonb,
  p_wallet_kind_authoritative boolean
) RETURNS gate.profiles LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
DECLARE
  before_row gate.profiles%ROWTYPE;
  result_row gate.profiles%ROWTYPE;
  before_policy gate.dao_policies%ROWTYPE;
  profile_exists boolean;
  profile_changed boolean := false;
  policy_changed boolean := false;
  policy_exists boolean;
  policy_dao text;
BEGIN
  IF p_policy IS NOT NULL AND (jsonb_typeof(p_policy->'enabled')<>'boolean'
      OR jsonb_typeof(p_policy->'acceptPreVote')<>'boolean' OR jsonb_typeof(p_policy->'acceptVoting')<>'boolean'
      OR jsonb_typeof(p_policy->'tags')<>'array') THEN
    RAISE EXCEPTION 'invalid policy JSON types' USING ERRCODE='23514';
  END IF;
  SELECT * INTO before_row FROM gate.profiles WHERE id=p_id FOR UPDATE;
  profile_exists := FOUND;
  IF NOT profile_exists THEN
    INSERT INTO gate.profiles(id,wallet,wallet_kind,availability,display_cache,base_payout_verified_at,base_payout_code_hash)
      VALUES(p_id,p_wallet,COALESCE(p_wallet_kind,'eoa'),COALESCE(p_availability,'paused'),CASE WHEN p_has_display THEN p_display ELSE '{}'::jsonb END,
        CASE WHEN p_has_verified_at THEN p_verified_at END,CASE WHEN p_has_code_hash THEN p_code_hash END)
      RETURNING * INTO result_row;
  ELSE
    IF before_row.wallet <> p_wallet THEN
      RAISE EXCEPTION 'profile wallet is immutable' USING ERRCODE='23514';
    END IF;
    IF before_row.wallet_kind='contract' AND p_wallet_kind='eoa' AND NOT COALESCE(p_wallet_kind_authoritative,false) THEN
      RAISE EXCEPTION 'contract wallet kind downgrade requires authoritative classification' USING ERRCODE='23514';
    END IF;
    profile_changed := ROW(p_wallet,COALESCE(p_wallet_kind,before_row.wallet_kind),COALESCE(p_availability,before_row.availability),
      CASE WHEN p_has_verified_at THEN p_verified_at ELSE before_row.base_payout_verified_at END,
      CASE WHEN p_has_code_hash THEN p_code_hash ELSE before_row.base_payout_code_hash END,
      CASE WHEN p_has_display THEN p_display ELSE before_row.display_cache END)
      IS DISTINCT FROM ROW(before_row.wallet,before_row.wallet_kind,before_row.availability,before_row.base_payout_verified_at,
        before_row.base_payout_code_hash,before_row.display_cache);
    IF profile_changed THEN
      UPDATE gate.profiles SET wallet=p_wallet,wallet_kind=COALESCE(p_wallet_kind,wallet_kind),availability=COALESCE(p_availability,availability),
        display_cache=CASE WHEN p_has_display THEN p_display ELSE display_cache END,
        base_payout_verified_at=CASE WHEN p_has_verified_at THEN p_verified_at ELSE base_payout_verified_at END,
        base_payout_code_hash=CASE WHEN p_has_code_hash THEN p_code_hash ELSE base_payout_code_hash END
        WHERE id=p_id RETURNING * INTO result_row;
    ELSE result_row := before_row;
    END IF;
  END IF;
  IF p_policy IS NOT NULL THEN
    policy_dao := p_policy->>'dao';
    SELECT * INTO before_policy FROM gate.dao_policies WHERE profile_id=p_id AND dao=policy_dao FOR UPDATE;
    policy_exists := FOUND;
    policy_changed := NOT policy_exists OR ROW(before_policy.chain_id,before_policy.enabled,before_policy.accept_pre_vote,
      before_policy.accept_voting,before_policy.attention_amount,before_policy.pending_reservation_capacity,before_policy.settled_capacity,before_policy.public_tags)
      IS DISTINCT FROM ROW((p_policy->>'chainId')::bigint,(p_policy->>'enabled')::boolean,(p_policy->>'acceptPreVote')::boolean,
        (p_policy->>'acceptVoting')::boolean,(p_policy->>'attentionAmount')::numeric,(p_policy->>'pendingReservationCapacity')::integer,
        (p_policy->>'settledCapacity')::integer,p_policy->'tags');
    IF policy_changed THEN
      INSERT INTO gate.dao_policies(profile_id,dao,chain_id,enabled,accept_pre_vote,accept_voting,attention_amount,pending_reservation_capacity,settled_capacity,public_tags)
        VALUES(p_id,policy_dao,(p_policy->>'chainId')::bigint,(p_policy->>'enabled')::boolean,(p_policy->>'acceptPreVote')::boolean,
          (p_policy->>'acceptVoting')::boolean,(p_policy->>'attentionAmount')::numeric,(p_policy->>'pendingReservationCapacity')::integer,
          (p_policy->>'settledCapacity')::integer,p_policy->'tags')
        ON CONFLICT(profile_id,dao) DO UPDATE SET chain_id=EXCLUDED.chain_id,enabled=EXCLUDED.enabled,
          accept_pre_vote=EXCLUDED.accept_pre_vote,accept_voting=EXCLUDED.accept_voting,attention_amount=EXCLUDED.attention_amount,
          pending_reservation_capacity=EXCLUDED.pending_reservation_capacity,settled_capacity=EXCLUDED.settled_capacity,public_tags=EXCLUDED.public_tags;
    END IF;
  END IF;
  IF profile_exists AND policy_changed AND NOT profile_changed THEN
    INSERT INTO gate.profile_version_authorizations(transaction_id,profile_id,target_version)
      VALUES(txid_current(),p_id,before_row.profile_version+1);
    UPDATE gate.profiles SET profile_version=profile_version+1 WHERE id=p_id RETURNING * INTO result_row;
  ELSIF profile_changed THEN
    SELECT * INTO result_row FROM gate.profiles WHERE id=p_id;
  END IF;
  RETURN result_row;
END $$;
REVOKE ALL ON FUNCTION gate.mutate_profile(text,text,text,gate.availability,jsonb,boolean,timestamptz,boolean,text,boolean,jsonb,boolean) FROM PUBLIC;
-- Compatibility entry point retained for the role auditor and older Gate workers. It is
-- deliberately non-authoritative, so it cannot downgrade a contract wallet to an EOA.
CREATE OR REPLACE FUNCTION gate.mutate_profile(
  p_id text,p_wallet text,p_wallet_kind text,p_availability gate.availability,p_display jsonb,p_has_display boolean,
  p_verified_at timestamptz,p_has_verified_at boolean,p_code_hash text,p_has_code_hash boolean,p_policy jsonb
) RETURNS gate.profiles LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
 SELECT gate.mutate_profile(p_id,p_wallet,p_wallet_kind,p_availability,p_display,p_has_display,
   p_verified_at,p_has_verified_at,p_code_hash,p_has_code_hash,p_policy,false)
$$;
REVOKE ALL ON FUNCTION gate.mutate_profile(text,text,text,gate.availability,jsonb,boolean,timestamptz,boolean,text,boolean,jsonb) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS gate.auth_nonces (
 id text PRIMARY KEY, proof_type gate.auth_proof_type NOT NULL, signed_purpose gate.auth_purpose NOT NULL,
 internal_operation text NOT NULL, role gate.auth_role, wallet text NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'),
 audience text, chain_id bigint NOT NULL CHECK(chain_id>0), verifier text NOT NULL CHECK(verifier ~ '^0x[0-9a-f]{40}$'),
 nonce_hash text NOT NULL UNIQUE CHECK(nonce_hash ~ '^0x[0-9a-f]{64}$'), payload_hash text NOT NULL CHECK(payload_hash ~ '^0x[0-9a-f]{64}$'),
 issued_at timestamptz NOT NULL DEFAULT clock_timestamp(), expires_at timestamptz NOT NULL, consumed_at timestamptz,
 CHECK(expires_at>issued_at), CHECK((proof_type='GateEnrollment' AND signed_purpose='enrollment' AND role IS NULL) OR
 (proof_type='BasePayoutControl' AND signed_purpose='base_payout_control' AND role IS NULL) OR
 (proof_type='WalletSession' AND signed_purpose='wallet_session' AND role IS NOT NULL AND audience IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS auth_nonces_lookup_idx ON gate.auth_nonces(nonce_hash,expires_at) WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS gate.auth_sessions (
 token_hash text NOT NULL PRIMARY KEY CHECK(token_hash ~ '^0x[0-9a-f]{64}$'),
 wallet text NOT NULL CHECK(wallet ~ '^0x[0-9a-f]{40}$'), role gate.auth_role NOT NULL,
 chain_id bigint NOT NULL CHECK(chain_id>0), audience text NOT NULL CHECK(length(audience)>0),
 issued_at timestamptz NOT NULL, expires_at timestamptz NOT NULL, revoked_at timestamptz,
 CHECK(expires_at>issued_at), CHECK(revoked_at IS NULL OR revoked_at>=issued_at)
);
CREATE INDEX IF NOT EXISTS auth_sessions_active_idx ON gate.auth_sessions(token_hash,expires_at) WHERE revoked_at IS NULL;

CREATE OR REPLACE FUNCTION gate.insert_auth_nonce(
 p_proof_type gate.auth_proof_type,p_purpose gate.auth_purpose,p_role gate.auth_role,p_wallet text,p_audience text,
 p_chain_id bigint,p_verifier text,p_nonce_hash text,p_payload_hash text,p_issued_at bigint,p_expiry bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
BEGIN
 INSERT INTO gate.auth_nonces(id,proof_type,signed_purpose,internal_operation,role,wallet,audience,chain_id,verifier,
   nonce_hash,payload_hash,issued_at,expires_at)
 VALUES(p_nonce_hash,p_proof_type,p_purpose,
   CASE p_proof_type WHEN 'WalletSession' THEN 'create_session' WHEN 'GateEnrollment' THEN 'mutate_profile'
     ELSE 'verify_base_payout_control' END,
   p_role,p_wallet,p_audience,p_chain_id,p_verifier,p_nonce_hash,p_payload_hash,to_timestamp(p_issued_at),to_timestamp(p_expiry));
END $$;
REVOKE ALL ON FUNCTION gate.insert_auth_nonce(gate.auth_proof_type,gate.auth_purpose,gate.auth_role,text,text,bigint,text,text,text,bigint,bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION gate.consume_auth_nonce(p_nonce_hash text,p_consumed_at bigint)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
BEGIN
 UPDATE gate.auth_nonces SET consumed_at=to_timestamp(p_consumed_at)
   WHERE nonce_hash=p_nonce_hash AND consumed_at IS NULL AND expires_at>to_timestamp(p_consumed_at);
 IF NOT FOUND THEN RAISE EXCEPTION 'authentication proof unavailable' USING ERRCODE='23514'; END IF;
END $$;
REVOKE ALL ON FUNCTION gate.consume_auth_nonce(text,bigint) FROM PUBLIC;

CREATE OR REPLACE FUNCTION gate.insert_auth_session(
 p_token_hash text,p_wallet text,p_role gate.auth_role,p_chain_id bigint,p_audience text,p_issued_at bigint,p_expiry bigint
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
BEGIN
 INSERT INTO gate.auth_sessions(token_hash,wallet,role,chain_id,audience,issued_at,expires_at)
 VALUES(p_token_hash,p_wallet,p_role,p_chain_id,p_audience,to_timestamp(p_issued_at),to_timestamp(p_expiry));
END $$;
REVOKE ALL ON FUNCTION gate.insert_auth_session(text,text,gate.auth_role,bigint,text,bigint,bigint) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS gate.proposal_snapshots (
 id text PRIMARY KEY, dao text NOT NULL CHECK(dao ~ '^[a-z][a-z0-9-]{0,62}$'), proposal_id numeric(78,0) NOT NULL CHECK(proposal_id>=0),
 content_hash text NOT NULL CHECK(content_hash ~ '^0x[0-9a-f]{64}$'), native_state text NOT NULL CHECK(native_state ~ '^[A-Z][A-Z_]*$'),
 normalized_eligibility text NOT NULL CHECK(normalized_eligibility IN('PRE_VOTE','VOTING','CLOSED')),
 mapping_version text NOT NULL CHECK(mapping_version='nouns-lifecycle/1'), source_block bigint NOT NULL CHECK(source_block>=0),
 source_block_hash text NOT NULL CHECK(source_block_hash ~ '^0x[0-9a-f]{64}$'), refreshed_at timestamptz NOT NULL,
 canonical_facts jsonb NOT NULL CHECK(jsonb_typeof(canonical_facts)='object'), decoded_facts jsonb NOT NULL CHECK(jsonb_typeof(decoded_facts)='object'),
 canonical_actions jsonb NOT NULL CHECK(jsonb_typeof(canonical_actions)='array'),
 CHECK(dao<>'nouns' OR ((native_state='ACTIVE' AND normalized_eligibility='VOTING') OR (native_state<>'ACTIVE' AND normalized_eligibility='CLOSED'))),
 UNIQUE(dao,proposal_id,content_hash,source_block,source_block_hash)
);
DO $$
DECLARE mapping_version_type text;
BEGIN
 SELECT data_type INTO mapping_version_type FROM information_schema.columns
   WHERE table_schema='gate' AND table_name='proposal_snapshots' AND column_name='mapping_version';
 IF mapping_version_type='integer' THEN
  ALTER TABLE gate.proposal_snapshots DROP CONSTRAINT IF EXISTS proposal_snapshots_mapping_version_check;
  ALTER TABLE gate.proposal_snapshots ALTER COLUMN mapping_version TYPE text
    USING CASE WHEN mapping_version=1 THEN 'nouns-lifecycle/1' ELSE mapping_version::text END;
  ALTER TABLE gate.proposal_snapshots ADD CONSTRAINT proposal_snapshots_mapping_version_check
    CHECK (mapping_version='nouns-lifecycle/1');
 ELSIF mapping_version_type IS DISTINCT FROM 'text' THEN
  RAISE EXCEPTION 'unsupported gate.proposal_snapshots.mapping_version type: %',mapping_version_type;
 END IF;
END $$;

CREATE TABLE IF NOT EXISTS gate.splitter_deployments (
 id text PRIMARY KEY, chain_id bigint NOT NULL CHECK(chain_id>0), splitter text NOT NULL CHECK(splitter ~ '^0x[0-9a-f]{40}$'),
 signer text NOT NULL CHECK(signer ~ '^0x[0-9a-f]{40}$'), token text NOT NULL CHECK(token ~ '^0x[0-9a-f]{40}$'),
 gavel_recipient text NOT NULL CHECK(gavel_recipient ~ '^0x[0-9a-f]{40}$'),
 deployment_block bigint NOT NULL CHECK(deployment_block>=0), scanner_cursor bigint NOT NULL CHECK(scanner_cursor>=deployment_block),
 contract_code_hash text NOT NULL CHECK(contract_code_hash ~ '^0x[0-9a-f]{64}$'), config jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(config)='object'),
 rpc_access_ciphertext text NOT NULL, issuance_active boolean NOT NULL DEFAULT false, retired_at timestamptz, retirement_ready_at timestamptz,
 UNIQUE(chain_id,splitter), UNIQUE(id,chain_id,splitter), UNIQUE(id,chain_id,splitter,token)
);
UPDATE gate.splitter_deployments
SET config=jsonb_set(config,'{environment}','"production"'::jsonb,true) - 'testTokenLabel'
WHERE chain_id=8453
  AND token='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
  AND NOT (config ? 'environment');
ALTER TABLE gate.splitter_deployments DROP CONSTRAINT IF EXISTS splitter_deployments_environment_check;
ALTER TABLE gate.splitter_deployments ADD CONSTRAINT splitter_deployments_environment_check CHECK (
  COALESCE((
  (config->>'environment'='production' AND chain_id=8453
    AND token='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'
    AND NOT (config ? 'testTokenLabel')) OR
  (config->>'environment'='test' AND chain_id=84532
    AND jsonb_typeof(config->'testTokenLabel')='string'
    AND NULLIF(btrim(config->>'testTokenLabel'),'') IS NOT NULL)
  ),false)
);
CREATE UNIQUE INDEX IF NOT EXISTS splitter_one_active_per_chain_idx ON gate.splitter_deployments(chain_id) WHERE issuance_active;

CREATE TABLE IF NOT EXISTS gate.submissions (
 id text PRIMARY KEY, public_id varchar(22) NOT NULL UNIQUE CHECK(public_id ~ '^[A-Za-z0-9_-]{22}$'),
 submission_hash text NOT NULL UNIQUE CHECK(submission_hash ~ '^0x[0-9a-f]{64}$'), profile_id text NOT NULL REFERENCES gate.profiles(id),
 issuance_snapshot_id text NOT NULL REFERENCES gate.proposal_snapshots(id), payer text NOT NULL CHECK(payer ~ '^0x[0-9a-f]{40}$'),
 signed_sender text NOT NULL CHECK(signed_sender ~ '^0x[0-9a-f]{40}$'), material jsonb NOT NULL CHECK(jsonb_typeof(material)='object'),
 status text NOT NULL DEFAULT 'QUOTED' CHECK(status IN('QUOTED','SETTLEMENT_PENDING','SETTLED','EXPIRED')), public_state_changed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), CHECK(payer=signed_sender)
);
ALTER TABLE gate.submissions ADD COLUMN IF NOT EXISTS pending_settlement_tx_hash text;
ALTER TABLE gate.submissions DROP CONSTRAINT IF EXISTS submissions_pending_settlement_tx_hash_check;
ALTER TABLE gate.submissions ADD CONSTRAINT submissions_pending_settlement_tx_hash_check
  CHECK(pending_settlement_tx_hash IS NULL OR pending_settlement_tx_hash ~ '^0x[0-9a-f]{64}$');
CREATE INDEX IF NOT EXISTS submissions_profile_idx ON gate.submissions(profile_id,created_at DESC);

CREATE TABLE IF NOT EXISTS gate.quotes (
 id text PRIMARY KEY, quote_id text NOT NULL UNIQUE CHECK(quote_id ~ '^0x[0-9a-f]{64}$'), submission_id text NOT NULL UNIQUE REFERENCES gate.submissions(id),
 payer text NOT NULL CHECK(payer ~ '^0x[0-9a-f]{40}$'), voter text NOT NULL CHECK(voter ~ '^0x[0-9a-f]{40}$'),
 attention_amount numeric(78,0) NOT NULL CHECK(attention_amount >= 1000000), fee_amount numeric(78,0) NOT NULL CHECK(fee_amount = 250000),
 token text NOT NULL CHECK(token ~ '^0x[0-9a-f]{40}$'), base_chain_id bigint NOT NULL CHECK(base_chain_id IN(8453,84532)), splitter text NOT NULL CHECK(splitter ~ '^0x[0-9a-f]{40}$'),
 deployment_id text NOT NULL REFERENCES gate.splitter_deployments(id), quote_version integer NOT NULL DEFAULT 1 CHECK(quote_version = 1), expires_at timestamptz NOT NULL,
 quote_signature text, reservation_state text NOT NULL DEFAULT 'reserved' CHECK(reservation_state IN('reserved','consumed','released')),
 state gate.quote_state NOT NULL DEFAULT 'quoted', settled_tx_hash text CHECK(settled_tx_hash IS NULL OR settled_tx_hash ~ '^0x[0-9a-f]{64}$'),
 settled_log_index integer CHECK(settled_log_index IS NULL OR settled_log_index>=0), settled_at timestamptz,
 receipt_block bigint CHECK(receipt_block IS NULL OR receipt_block>=0), receipt_block_hash text CHECK(receipt_block_hash IS NULL OR receipt_block_hash ~ '^0x[0-9a-f]{64}$'),
 receipt_block_timestamp timestamptz, settlement_proof_canonical boolean, settlement_scanner_verified boolean, settlement_confirmations integer,
 settlement_event_quote_id text CHECK(settlement_event_quote_id IS NULL OR settlement_event_quote_id ~ '^0x[0-9a-f]{64}$'),
 settlement_payer text CHECK(settlement_payer IS NULL OR settlement_payer ~ '^0x[0-9a-f]{40}$'),
 settlement_voter text CHECK(settlement_voter IS NULL OR settlement_voter ~ '^0x[0-9a-f]{40}$'),
 settlement_attention_amount numeric(78,0), settlement_fee_amount numeric(78,0),
 settlement_gavel_recipient text CHECK(settlement_gavel_recipient IS NULL OR settlement_gavel_recipient ~ '^0x[0-9a-f]{40}$'),
 settlement_token text CHECK(settlement_token IS NULL OR settlement_token ~ '^0x[0-9a-f]{40}$'),
 settlement_submission_hash text CHECK(settlement_submission_hash IS NULL OR settlement_submission_hash ~ '^0x[0-9a-f]{64}$'),
 settlement_quote_version integer, settlement_source_chain_id bigint,
 settlement_splitter text CHECK(settlement_splitter IS NULL OR settlement_splitter ~ '^0x[0-9a-f]{40}$'),
 settlement_reorged_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(deployment_id,base_chain_id,splitter,token) REFERENCES gate.splitter_deployments(id,chain_id,splitter,token)
);
ALTER TABLE gate.quotes DROP CONSTRAINT IF EXISTS quotes_base_chain_id_check;
ALTER TABLE gate.quotes DROP CONSTRAINT IF EXISTS quotes_base_chain_check;
ALTER TABLE gate.quotes ADD CONSTRAINT quotes_base_chain_check CHECK (base_chain_id IN(8453,84532));
ALTER TABLE gate.quotes ADD COLUMN IF NOT EXISTS lifecycle_recheck_attempted_at timestamptz;
ALTER TABLE gate.quotes ADD COLUMN IF NOT EXISTS lifecycle_recheck jsonb;
ALTER TABLE gate.quotes DROP CONSTRAINT IF EXISTS quotes_lifecycle_recheck_check;
ALTER TABLE gate.quotes ADD CONSTRAINT quotes_lifecycle_recheck_check CHECK(
 lifecycle_recheck IS NULL OR (lifecycle_recheck_attempted_at IS NOT NULL AND jsonb_typeof(lifecycle_recheck)='object'));
DO $$
DECLARE legacy_constraint name;
BEGIN
  FOR legacy_constraint IN
    SELECT c.conname FROM pg_constraint c
    WHERE c.conrelid='gate.quotes'::regclass AND c.contype='c'
      AND position('state' in pg_get_constraintdef(c.oid)) > 0
      AND position('settled_tx_hash' in pg_get_constraintdef(c.oid)) > 0
      AND position('settlement_confirmations' in pg_get_constraintdef(c.oid)) > 0
  LOOP
    EXECUTE format('ALTER TABLE gate.quotes DROP CONSTRAINT %I',legacy_constraint);
  END LOOP;
END $$;
ALTER TABLE gate.quotes ADD CONSTRAINT quotes_settlement_complete_check CHECK(
 (state='settled')=(settled_tx_hash IS NOT NULL AND settled_log_index IS NOT NULL AND settled_at IS NOT NULL AND receipt_block IS NOT NULL
   AND receipt_block_hash IS NOT NULL AND receipt_block_timestamp IS NOT NULL AND settlement_proof_canonical IS TRUE
   AND settlement_scanner_verified IS TRUE AND settlement_event_quote_id=quote_id AND settlement_confirmations=1
   AND settlement_payer IS NOT NULL AND settlement_voter IS NOT NULL AND settlement_attention_amount IS NOT NULL AND settlement_fee_amount IS NOT NULL
   AND settlement_gavel_recipient IS NOT NULL
   AND settlement_token IS NOT NULL AND settlement_submission_hash IS NOT NULL AND settlement_quote_version IS NOT NULL
   AND settlement_source_chain_id IS NOT NULL AND settlement_splitter IS NOT NULL));
CREATE INDEX IF NOT EXISTS quotes_expiry_idx ON gate.quotes(state,expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS quotes_settled_log_identity_idx
  ON gate.quotes(base_chain_id,splitter,settled_tx_hash,settled_log_index) WHERE settled_tx_hash IS NOT NULL;

CREATE TABLE IF NOT EXISTS gate.capacity_reservations (
 id text PRIMARY KEY, profile_id text NOT NULL REFERENCES gate.profiles(id), quote_id text NOT NULL UNIQUE REFERENCES gate.quotes(id),
 amount numeric(78,0) NOT NULL CHECK(amount>=1000000), expires_at timestamptz NOT NULL, state gate.reservation_state NOT NULL DEFAULT 'active',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(), released_at timestamptz, consumed_at timestamptz,
 scanner_cursor bigint, release_range_from bigint, release_range_to bigint, release_canonical_block_hash text,
 CHECK(release_range_from IS NULL OR release_range_from>=0), CHECK(release_range_to IS NULL OR release_range_to>=release_range_from),
 CHECK(release_canonical_block_hash IS NULL OR release_canonical_block_hash ~ '^0x[0-9a-f]{64}$'),
 CHECK(state<>'released' OR (released_at IS NOT NULL AND scanner_cursor IS NOT NULL AND release_range_from IS NOT NULL AND release_range_to IS NOT NULL AND release_canonical_block_hash IS NOT NULL)),
 CHECK(state<>'consumed' OR consumed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS capacity_liabilities_idx ON gate.capacity_reservations(profile_id,state) WHERE state IN('active','expiry_pending_reconciliation');

CREATE TABLE IF NOT EXISTS gate.inbox_items (
 id text PRIMARY KEY, submission_id text NOT NULL UNIQUE REFERENCES gate.submissions(id), profile_id text NOT NULL REFERENCES gate.profiles(id),
 issuance_lifecycle gate.lifecycle NOT NULL, current_lifecycle gate.lifecycle NOT NULL, lifecycle_changed boolean NOT NULL DEFAULT false,
 current_lifecycle_unavailable boolean NOT NULL DEFAULT false, private_unavailability_reason text,
 inbox_created_at timestamptz NOT NULL DEFAULT clock_timestamp(), read_at timestamptz, archived_at timestamptz,
 CHECK(issuance_lifecycle='VOTING' AND current_lifecycle IN('VOTING','CLOSED','UNKNOWN')),
 CHECK((current_lifecycle_unavailable AND current_lifecycle='UNKNOWN' AND NOT lifecycle_changed)
   OR (NOT current_lifecycle_unavailable AND current_lifecycle<>'UNKNOWN' AND lifecycle_changed=(current_lifecycle<>issuance_lifecycle))),
 CHECK((NOT current_lifecycle_unavailable AND private_unavailability_reason IS NULL) OR current_lifecycle_unavailable)
);
CREATE INDEX IF NOT EXISTS inbox_profile_idx ON gate.inbox_items(profile_id,inbox_created_at DESC);
CREATE TABLE IF NOT EXISTS gate.notification_attempts (
 id text PRIMARY KEY, inbox_id text NOT NULL REFERENCES gate.inbox_items(id), channel text NOT NULL, destination_ref_ciphertext text NOT NULL,
 state gate.notification_state NOT NULL DEFAULT 'pending', provider_opaque_id text, error_code text,
 retry_count integer NOT NULL DEFAULT 0 CHECK(retry_count>=0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE gate.notification_attempts ADD COLUMN IF NOT EXISTS trusted_summary jsonb;
UPDATE gate.notification_attempts SET trusted_summary=jsonb_build_object(
  'subject','Paid pitch ready','text','Open your private Gate inbox.') WHERE trusted_summary IS NULL;
ALTER TABLE gate.notification_attempts ALTER COLUMN trusted_summary SET NOT NULL;
ALTER TABLE gate.notification_attempts DROP CONSTRAINT IF EXISTS notification_trusted_summary_shape;
ALTER TABLE gate.notification_attempts ADD CONSTRAINT notification_trusted_summary_shape CHECK(
  jsonb_typeof(trusted_summary)='object' AND trusted_summary ?& ARRAY['subject','text']
  AND NOT (trusted_summary - ARRAY['subject','text'] <> '{}'::jsonb)
  AND jsonb_typeof(trusted_summary->'subject')='string' AND jsonb_typeof(trusted_summary->'text')='string');
ALTER TABLE gate.notification_attempts ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz;
UPDATE gate.notification_attempts SET next_attempt_at=created_at WHERE next_attempt_at IS NULL;
ALTER TABLE gate.notification_attempts ALTER COLUMN next_attempt_at SET DEFAULT clock_timestamp();
ALTER TABLE gate.notification_attempts ALTER COLUMN next_attempt_at SET NOT NULL;
ALTER TABLE gate.notification_attempts ADD COLUMN IF NOT EXISTS claimed_until timestamptz;
ALTER TABLE gate.notification_attempts ADD COLUMN IF NOT EXISTS claim_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE gate.notification_attempts ADD COLUMN IF NOT EXISTS first_attempt_at timestamptz;
ALTER TABLE gate.notification_attempts ADD COLUMN IF NOT EXISTS dedupe_deadline timestamptz;
ALTER TABLE gate.notification_attempts ADD COLUMN IF NOT EXISTS manual_reconciliation_at timestamptz;

ALTER TABLE gate.notification_attempts DROP CONSTRAINT IF EXISTS notification_dedupe_window_check;
ALTER TABLE gate.notification_attempts ADD CONSTRAINT notification_dedupe_window_check CHECK(
  (first_attempt_at IS NULL AND dedupe_deadline IS NULL)
  OR (first_attempt_at IS NOT NULL AND dedupe_deadline=first_attempt_at+interval '24 hours'));
ALTER TABLE gate.notification_attempts DROP CONSTRAINT IF EXISTS notification_manual_reconciliation_check;
ALTER TABLE gate.notification_attempts ADD CONSTRAINT notification_manual_reconciliation_check CHECK(
  manual_reconciliation_at IS NULL OR (state='failed' AND error_code IS NOT NULL));
CREATE UNIQUE INDEX IF NOT EXISTS notification_inbox_unique_idx ON gate.notification_attempts(inbox_id);
CREATE INDEX IF NOT EXISTS notification_pending_idx ON gate.notification_attempts(state,created_at);

DROP FUNCTION IF EXISTS gate.claim_notification_attempts(integer,timestamptz,integer);
DROP FUNCTION IF EXISTS gate.claim_notification_attempts(integer,integer,integer);
CREATE OR REPLACE FUNCTION gate.claim_notification_attempts(p_limit integer,p_retry_limit integer,p_lease_ms integer)
RETURNS TABLE(id text,"claimToken" text,"retryCount" integer,"firstAttemptAt" timestamptz,"dedupeDeadline" timestamptz,"profileId" text,"destinationRef" text,summary jsonb)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
 WITH candidates AS (
   SELECT n.id FROM gate.notification_attempts n
   WHERE n.state IN('pending','failed') AND n.next_attempt_at<=clock_timestamp()
     AND n.manual_reconciliation_at IS NULL
     AND n.retry_count<=p_retry_limit AND (n.claimed_until IS NULL OR n.claimed_until<=clock_timestamp())
     AND p_lease_ms BETWEEN 1 AND 3600000
   ORDER BY n.next_attempt_at,n.created_at LIMIT p_limit FOR UPDATE SKIP LOCKED
 )
 UPDATE gate.notification_attempts n SET state='pending',claim_generation=claim_generation+1,
   claimed_until=clock_timestamp()+make_interval(secs => p_lease_ms / 1000.0),
   first_attempt_at=COALESCE(first_attempt_at,statement_timestamp()),
   dedupe_deadline=COALESCE(dedupe_deadline,statement_timestamp()+interval '24 hours'),updated_at=clock_timestamp()
 FROM candidates c WHERE n.id=c.id
 RETURNING n.id,n.claim_generation::text,n.retry_count,n.first_attempt_at,n.dedupe_deadline,
   (SELECT i.profile_id FROM gate.inbox_items i WHERE i.id=n.inbox_id),n.destination_ref_ciphertext,n.trusted_summary
$$;
REVOKE ALL ON FUNCTION gate.claim_notification_attempts(integer,integer,integer) FROM PUBLIC;

DROP FUNCTION IF EXISTS gate.complete_notification_attempt(text,text);
CREATE OR REPLACE FUNCTION gate.complete_notification_attempt(p_id text,p_claim_token text,p_provider_opaque_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
BEGIN
 UPDATE gate.notification_attempts SET state='sent',provider_opaque_id=p_provider_opaque_id,
   claimed_until=NULL,updated_at=clock_timestamp() WHERE id=p_id AND state='pending'
     AND claim_generation=p_claim_token::bigint AND claimed_until>clock_timestamp()
     AND manual_reconciliation_at IS NULL;
 IF FOUND THEN RETURN true; END IF;
 RETURN false;
END $$;
REVOKE ALL ON FUNCTION gate.complete_notification_attempt(text,text,text) FROM PUBLIC;

DROP FUNCTION IF EXISTS gate.fail_notification_attempt(text,text,timestamptz);
CREATE OR REPLACE FUNCTION gate.fail_notification_attempt(p_id text,p_claim_token text,p_error_code text,p_next_attempt_at timestamptz)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
BEGIN
 UPDATE gate.notification_attempts SET state='failed',error_code=p_error_code,retry_count=retry_count+1,
   next_attempt_at=p_next_attempt_at,claimed_until=NULL,updated_at=clock_timestamp()
 WHERE id=p_id AND state='pending' AND claim_generation=p_claim_token::bigint AND claimed_until>clock_timestamp()
   AND manual_reconciliation_at IS NULL;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION gate.fail_notification_attempt(text,text,text,timestamptz) FROM PUBLIC;

CREATE OR REPLACE FUNCTION gate.reconcile_notification_attempt(p_id text,p_claim_token text,p_error_code text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
BEGIN
 UPDATE gate.notification_attempts SET state='failed',error_code=p_error_code,
   manual_reconciliation_at=clock_timestamp(),claimed_until=NULL,updated_at=clock_timestamp()
 WHERE id=p_id AND state='pending' AND claim_generation=p_claim_token::bigint
   AND claimed_until>clock_timestamp() AND manual_reconciliation_at IS NULL;
 RETURN FOUND;
END $$;
REVOKE ALL ON FUNCTION gate.reconcile_notification_attempt(text,text,text) FROM PUBLIC;

CREATE OR REPLACE FUNCTION gate.transition_notification(p_id text,p_state gate.notification_state,p_provider text,p_has_provider boolean,
  p_error text,p_has_error boolean,p_retry_limit integer)
RETURNS TABLE(id text,"inboxId" text,channel text,status gate.notification_state,"providerOpaqueId" text,"errorCode" text,
  "retryCount" integer,"createdAt" timestamptz,"updatedAt" timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
DECLARE old_state gate.notification_state; next_state gate.notification_state; old_retry_count integer; old_manual_reconciliation_at timestamptz;
BEGIN
 IF p_retry_limit<0 THEN RAISE EXCEPTION 'notification retry limit must be nonnegative' USING ERRCODE='23514'; END IF;
 SELECT n.state,n.retry_count,n.manual_reconciliation_at INTO old_state,old_retry_count,old_manual_reconciliation_at
   FROM gate.notification_attempts n WHERE n.id=p_id FOR UPDATE;
 IF NOT FOUND THEN RETURN; END IF;
 next_state := COALESCE(p_state,old_state);
 IF old_manual_reconciliation_at IS NOT NULL AND next_state<>'failed' THEN
   RAISE EXCEPTION 'manual reconciliation is terminal' USING ERRCODE='23514';
 END IF;
 IF NOT ((old_state='pending' AND next_state IN('pending','sent','failed')) OR (old_state='failed' AND next_state IN('failed','pending'))
    OR (old_state='sent' AND next_state='sent')) THEN
   RAISE EXCEPTION 'invalid notification transition' USING ERRCODE='23514';
 END IF;
 IF old_state='failed' AND next_state='pending' AND old_retry_count>=p_retry_limit THEN
   RAISE EXCEPTION 'notification retry limit reached' USING ERRCODE='23514';
 END IF;
 RETURN QUERY UPDATE gate.notification_attempts n SET state=next_state,
   provider_opaque_id=CASE WHEN p_has_provider THEN p_provider ELSE n.provider_opaque_id END,
   error_code=CASE WHEN p_has_error THEN p_error ELSE n.error_code END,
   retry_count=n.retry_count+CASE WHEN old_state='failed' AND next_state='pending' THEN 1 ELSE 0 END,
   updated_at=clock_timestamp()
   WHERE n.id=p_id RETURNING n.id,n.inbox_id,n.channel,n.state,n.provider_opaque_id,n.error_code,n.retry_count,n.created_at,n.updated_at;
END $$;
REVOKE ALL ON FUNCTION gate.transition_notification(text,gate.notification_state,text,boolean,text,boolean,integer) FROM PUBLIC;
-- Compatibility entry point for the audited legacy signature. All four arguments are
-- authoritative in this form; retry transitions retain the frozen default bound of 3.
CREATE OR REPLACE FUNCTION gate.transition_notification(p_id text,p_state gate.notification_state,p_provider text,p_error text)
RETURNS TABLE(id text,"inboxId" text,channel text,status gate.notification_state,"providerOpaqueId" text,"errorCode" text,
  "retryCount" integer,"createdAt" timestamptz,"updatedAt" timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
 SELECT * FROM gate.transition_notification(p_id,p_state,p_provider,true,p_error,true,3)
$$;
REVOKE ALL ON FUNCTION gate.transition_notification(text,gate.notification_state,text,text) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS gate.sender_blocks (
 id bigserial PRIMARY KEY, wallet text NOT NULL UNIQUE CHECK(wallet ~ '^0x[0-9a-f]{40}$'), blocked_until timestamptz, reason_code text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS gate.rate_limit_events (
 id bigserial PRIMARY KEY, subject_hash text NOT NULL CHECK(subject_hash ~ '^0x[0-9a-f]{64}$'), operation text NOT NULL,
 occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(), cost integer NOT NULL DEFAULT 1 CHECK(cost>0)
);
CREATE INDEX IF NOT EXISTS rate_limit_lookup_idx ON gate.rate_limit_events(subject_hash,operation,occurred_at DESC);
CREATE TABLE IF NOT EXISTS gate.delivery_settings (
  profile_id text PRIMARY KEY REFERENCES gate.profiles(id), ciphertext text NOT NULL, encrypted_config jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE gate.delivery_settings DROP CONSTRAINT IF EXISTS delivery_settings_envelope_check;
ALTER TABLE gate.delivery_settings ADD CONSTRAINT delivery_settings_envelope_check CHECK (
  length(ciphertext)<=1024
  AND ciphertext ~ '^gg1\.[A-Za-z0-9_-]{1,32}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'
);
CREATE OR REPLACE FUNCTION gate.set_delivery_setting(p_profile_id text,p_wallet text,p_ciphertext text)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM gate.profiles p WHERE p.id=p_profile_id AND p.wallet=p_wallet) THEN
  RAISE EXCEPTION 'delivery setting profile mismatch' USING ERRCODE='23514';
 END IF;
 INSERT INTO gate.delivery_settings(profile_id,ciphertext,encrypted_config,updated_at)
 VALUES(p_profile_id,p_ciphertext,'{}'::jsonb,clock_timestamp())
 ON CONFLICT(profile_id) DO UPDATE SET ciphertext=EXCLUDED.ciphertext,encrypted_config='{}'::jsonb,
   updated_at=clock_timestamp();
END $$;
REVOKE ALL ON FUNCTION gate.set_delivery_setting(text,text,text) FROM PUBLIC;
CREATE TABLE IF NOT EXISTS gate.settlement_cursors (
 id bigserial PRIMARY KEY, deployment_id text NOT NULL UNIQUE REFERENCES gate.splitter_deployments(id), chain_id bigint NOT NULL,
 splitter text NOT NULL, deployment_block bigint NOT NULL CHECK(deployment_block>=0), next_range_from bigint NOT NULL CHECK(next_range_from>=deployment_block),
 scan_generation bigint NOT NULL DEFAULT 0 CHECK(scan_generation>=0),
 checkpoint_block bigint, canonical_block_hash text CHECK(canonical_block_hash IS NULL OR canonical_block_hash ~ '^0x[0-9a-f]{64}$'),
 checkpoint_block_timestamp timestamptz, reconciliation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(chain_id,splitter), FOREIGN KEY(deployment_id,chain_id,splitter) REFERENCES gate.splitter_deployments(id,chain_id,splitter)
);

CREATE TABLE IF NOT EXISTS gate.settlement_scan_ranges (
 id bigserial PRIMARY KEY, deployment_id text NOT NULL REFERENCES gate.splitter_deployments(id),
 scan_generation bigint NOT NULL CHECK(scan_generation>0),
 range_from bigint NOT NULL CHECK(range_from>=0), range_through bigint NOT NULL CHECK(range_through>=range_from),
 canonical_block_hash text NOT NULL CHECK(canonical_block_hash ~ '^0x[0-9a-f]{64}$'),
 canonical_block_timestamp timestamptz NOT NULL, result_kind text NOT NULL CHECK(result_kind IN('no_match','observations')),
 observation_count integer NOT NULL CHECK(observation_count>=0), metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(metadata)='object'),
 scanner_result jsonb NOT NULL CHECK(jsonb_typeof(scanner_result)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((result_kind='no_match')=(observation_count=0)), UNIQUE(deployment_id,scan_generation), UNIQUE(id,deployment_id,scan_generation)
);
CREATE TABLE IF NOT EXISTS gate.settlement_scan_blocks (
 id bigserial PRIMARY KEY, range_id bigint NOT NULL, deployment_id text NOT NULL, scan_generation bigint NOT NULL CHECK(scan_generation>0),
 block_number bigint NOT NULL CHECK(block_number>=0), block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'),
 parent_hash text,
 block_timestamp timestamptz NOT NULL, recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(range_id,deployment_id,scan_generation) REFERENCES gate.settlement_scan_ranges(id,deployment_id,scan_generation),
 UNIQUE(deployment_id,scan_generation,block_number)
);
ALTER TABLE gate.settlement_scan_blocks ADD COLUMN IF NOT EXISTS parent_hash text;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='gate.settlement_scan_blocks'::regclass
   AND conname='settlement_scan_blocks_parent_hash_check') THEN
  ALTER TABLE gate.settlement_scan_blocks ADD CONSTRAINT settlement_scan_blocks_parent_hash_check
    CHECK(parent_hash IS NOT NULL AND parent_hash ~ '^0x[0-9a-f]{64}$') NOT VALID;
 END IF;
END $$;
-- Scanner evidence written before parent linkage existed cannot authorize settlement or capacity release.
-- Temporarily remove the old-version transition trigger while reverting legacy releases; recreate it immediately when upgrading.
DROP TRIGGER IF EXISTS reservations_state_transition ON gate.capacity_reservations;
WITH unsafe_deployments AS (
  SELECT c.deployment_id FROM gate.settlement_cursors c WHERE c.checkpoint_block IS NOT NULL
    AND (SELECT count(DISTINCT b.block_number) FROM gate.settlement_scan_blocks b
      WHERE b.deployment_id=c.deployment_id AND b.parent_hash IS NOT NULL
        AND b.block_number BETWEEN c.deployment_block AND c.checkpoint_block)
      <>c.checkpoint_block-c.deployment_block+1
), reverted AS (
  UPDATE gate.capacity_reservations r SET state='expiry_pending_reconciliation',released_at=NULL,scanner_cursor=NULL,
    release_range_from=NULL,release_range_to=NULL,release_canonical_block_hash=NULL,updated_at=clock_timestamp()
    FROM gate.quotes q,unsafe_deployments u
    WHERE r.quote_id=q.id AND q.deployment_id=u.deployment_id AND q.state='expired' AND r.state='released'
    RETURNING r.quote_id
) UPDATE gate.quotes q SET reservation_state='reserved' FROM reverted r WHERE q.id=r.quote_id;
DO $$ BEGIN
 IF to_regprocedure('gate.enforce_state_transition()') IS NOT NULL THEN
  EXECUTE 'CREATE TRIGGER reservations_state_transition BEFORE UPDATE ON gate.capacity_reservations FOR EACH ROW EXECUTE FUNCTION gate.enforce_state_transition()';
 END IF;
END $$;
-- Reset those deployments to their recorded start so bounded scanner cycles replace the legacy coverage canonically.
UPDATE gate.splitter_deployments d SET scanner_cursor=d.deployment_block
 FROM gate.settlement_cursors c WHERE c.deployment_id=d.id AND c.checkpoint_block IS NOT NULL
   AND (SELECT count(DISTINCT b.block_number) FROM gate.settlement_scan_blocks b
     WHERE b.deployment_id=c.deployment_id AND b.parent_hash IS NOT NULL
       AND b.block_number BETWEEN c.deployment_block AND c.checkpoint_block)
     <>c.checkpoint_block-c.deployment_block+1;
UPDATE gate.settlement_cursors c SET next_range_from=c.deployment_block,checkpoint_block=NULL,
  canonical_block_hash=NULL,checkpoint_block_timestamp=NULL,updated_at=clock_timestamp()
 WHERE c.checkpoint_block IS NOT NULL
   AND (SELECT count(DISTINCT b.block_number) FROM gate.settlement_scan_blocks b
     WHERE b.deployment_id=c.deployment_id AND b.parent_hash IS NOT NULL
       AND b.block_number BETWEEN c.deployment_block AND c.checkpoint_block)
     <>c.checkpoint_block-c.deployment_block+1;
CREATE TABLE IF NOT EXISTS gate.settlement_scan_observations (
 id bigserial PRIMARY KEY, range_id bigint NOT NULL, deployment_id text NOT NULL, scan_generation bigint NOT NULL CHECK(scan_generation>0),
 kind text NOT NULL CHECK(kind IN('exact_log','anomaly')),
 quote_id text CHECK(quote_id IS NULL OR quote_id ~ '^0x[0-9a-f]{64}$'), tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
 log_index integer NOT NULL CHECK(log_index>=0), block_number bigint NOT NULL CHECK(block_number>=0),
 block_hash text NOT NULL CHECK(block_hash ~ '^0x[0-9a-f]{64}$'), block_timestamp timestamptz NOT NULL,
 exact_match boolean NOT NULL, details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(details)='object'),
 recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((kind='exact_log')=exact_match), CHECK(kind<>'exact_log' OR quote_id IS NOT NULL),
 FOREIGN KEY(range_id,deployment_id,scan_generation) REFERENCES gate.settlement_scan_ranges(id,deployment_id,scan_generation),
 UNIQUE(deployment_id,scan_generation,tx_hash,log_index)
);
CREATE INDEX IF NOT EXISTS settlement_scan_observations_quote_idx
 ON gate.settlement_scan_observations(deployment_id,quote_id,block_timestamp) WHERE exact_match;
CREATE OR REPLACE FUNCTION gate.protect_scanner_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 RAISE EXCEPTION 'immutable scanner range evidence' USING ERRCODE='23514';
END $$;
DROP TRIGGER IF EXISTS settlement_scan_ranges_immutable ON gate.settlement_scan_ranges;
CREATE TRIGGER settlement_scan_ranges_immutable BEFORE UPDATE OR DELETE ON gate.settlement_scan_ranges
 FOR EACH ROW EXECUTE FUNCTION gate.protect_scanner_evidence();
DROP TRIGGER IF EXISTS settlement_scan_blocks_immutable ON gate.settlement_scan_blocks;
CREATE TRIGGER settlement_scan_blocks_immutable BEFORE UPDATE OR DELETE ON gate.settlement_scan_blocks
 FOR EACH ROW EXECUTE FUNCTION gate.protect_scanner_evidence();
DROP TRIGGER IF EXISTS settlement_scan_observations_immutable ON gate.settlement_scan_observations;
CREATE TRIGGER settlement_scan_observations_immutable BEFORE UPDATE OR DELETE ON gate.settlement_scan_observations
 FOR EACH ROW EXECUTE FUNCTION gate.protect_scanner_evidence();

CREATE OR REPLACE FUNCTION gate.record_scanner_range(p_deployment_id text,p_from bigint,p_through bigint,p_hash text,p_timestamp timestamptz,p_metadata jsonb)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
DECLARE
 c gate.settlement_cursors%ROWTYPE;
 v_range_id bigint;
 item jsonb;
 block_item jsonb;
 item_count integer;
 block_count bigint;
 p_generation bigint;
 overlap_blocks bigint;
 expected_block bigint;
 previous_hash text;
 boundary_hash text;
 released_count integer := 0;
BEGIN
 SELECT c0.* INTO c FROM gate.settlement_cursors c0 WHERE c0.deployment_id=p_deployment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'invalid or discontinuous canonical scanner range' USING ERRCODE='23514'; END IF;
 SELECT CASE WHEN d.config ? 'overlap' THEN (d.config->>'overlap')::bigint ELSE 64 END
   INTO overlap_blocks FROM gate.splitter_deployments d WHERE d.id=p_deployment_id;
 IF NOT FOUND OR p_through<p_from OR p_hash IS NULL OR p_hash !~ '^0x[0-9a-f]{64}$' OR p_timestamp IS NULL
    OR overlap_blocks<1 OR jsonb_typeof(p_metadata)<>'object' OR (p_metadata->>'generation') !~ '^[1-9][0-9]*$'
    OR p_metadata->>'kind' NOT IN('no_match','observations') OR jsonb_typeof(p_metadata->'canonicalBlocks')<>'array'
    OR jsonb_typeof(p_metadata->'observations')<>'array'
    OR jsonb_typeof(COALESCE(p_metadata->'metadata','{}'::jsonb))<>'object' THEN
   RAISE EXCEPTION 'invalid or discontinuous canonical scanner range' USING ERRCODE='23514';
 END IF;
 p_generation := (p_metadata->>'generation')::bigint;
 IF p_generation<=c.scan_generation THEN
   IF EXISTS(SELECT 1 FROM gate.settlement_scan_ranges
      WHERE deployment_id=p_deployment_id AND scan_generation=p_generation AND range_from=p_from AND range_through=p_through
        AND canonical_block_hash=p_hash AND canonical_block_timestamp=p_timestamp AND scanner_result=p_metadata) THEN
     RETURN 0;
   END IF;
   RAISE EXCEPTION 'conflicting scanner generation replay' USING ERRCODE='23514';
 END IF;
 IF p_generation<>c.scan_generation+1
    OR p_from<>greatest(c.deployment_block,c.next_range_from-overlap_blocks)
    OR p_through<c.next_range_from-1 THEN
   RAISE EXCEPTION 'invalid or discontinuous canonical scanner range' USING ERRCODE='23514';
 END IF;
 item_count := jsonb_array_length(p_metadata->'observations');
 IF (p_metadata->>'kind'='no_match')<>(item_count=0)
    OR jsonb_array_length(p_metadata->'canonicalBlocks')::bigint<>p_through-p_from+1 THEN
   RAISE EXCEPTION 'scanner result does not completely describe its canonical range' USING ERRCODE='23514';
 END IF;
 INSERT INTO gate.settlement_scan_ranges(deployment_id,scan_generation,range_from,range_through,canonical_block_hash,canonical_block_timestamp,result_kind,observation_count,metadata,scanner_result)
   VALUES(p_deployment_id,p_generation,p_from,p_through,p_hash,p_timestamp,p_metadata->>'kind',item_count,COALESCE(p_metadata->'metadata','{}'::jsonb),p_metadata)
   RETURNING id INTO v_range_id;
 expected_block := p_from;
 previous_hash := NULL;
 boundary_hash := NULL;
 IF p_from>c.deployment_block THEN
   SELECT b.block_hash INTO boundary_hash FROM gate.settlement_scan_blocks b
     WHERE b.deployment_id=p_deployment_id AND b.block_number=p_from-1 AND b.parent_hash IS NOT NULL
     ORDER BY b.scan_generation DESC LIMIT 1;
   IF boundary_hash IS NULL OR (p_metadata->'canonicalBlocks'->0->>'parentHash')<>boundary_hash THEN
     RAISE EXCEPTION 'canonical scanner range does not join persisted ancestry' USING ERRCODE='23514';
   END IF;
 END IF;
 FOR block_item IN SELECT value FROM jsonb_array_elements(p_metadata->'canonicalBlocks') LOOP
   IF (block_item->>'blockNumber')::bigint<>expected_block
      OR block_item->>'blockHash' !~ '^0x[0-9a-f]{64}$'
      OR block_item->>'parentHash' !~ '^0x[0-9a-f]{64}$'
      OR (block_item->>'blockTimestamp')::timestamptz IS NULL
      OR (previous_hash IS NOT NULL AND block_item->>'parentHash'<>previous_hash) THEN
     RAISE EXCEPTION 'invalid canonical scanner block ancestry' USING ERRCODE='23514';
   END IF;
   INSERT INTO gate.settlement_scan_blocks(range_id,deployment_id,scan_generation,block_number,block_hash,parent_hash,block_timestamp)
     VALUES(v_range_id,p_deployment_id,p_generation,(block_item->>'blockNumber')::bigint,block_item->>'blockHash',
       block_item->>'parentHash',(block_item->>'blockTimestamp')::timestamptz);
   previous_hash := block_item->>'blockHash';
   expected_block := expected_block+1;
 END LOOP;
 SELECT count(*) INTO block_count FROM gate.settlement_scan_blocks
   WHERE deployment_id=p_deployment_id AND scan_generation=p_generation;
 IF block_count<>p_through-p_from+1 OR NOT EXISTS(SELECT 1 FROM gate.settlement_scan_blocks
      WHERE deployment_id=p_deployment_id AND scan_generation=p_generation AND block_number=p_through
        AND block_hash=p_hash AND block_timestamp=p_timestamp) THEN
   RAISE EXCEPTION 'canonical scanner blocks do not match checkpoint' USING ERRCODE='23514';
 END IF;
 FOR item IN SELECT value FROM jsonb_array_elements(p_metadata->'observations') LOOP
   IF item->>'kind' NOT IN('exact_log','anomaly') OR (item->>'blockNumber')::bigint NOT BETWEEN p_from AND p_through
      OR (item->>'logIndex')::integer<0 OR item->>'txHash' !~ '^0x[0-9a-f]{64}$'
      OR item->>'blockHash' !~ '^0x[0-9a-f]{64}$' OR (item->>'blockTimestamp')::timestamptz IS NULL
      OR jsonb_typeof(COALESCE(item->'details','{}'::jsonb))<>'object'
      OR NOT EXISTS(SELECT 1 FROM gate.settlement_scan_blocks b WHERE b.range_id=v_range_id
        AND b.block_number=(item->>'blockNumber')::bigint AND b.block_hash=item->>'blockHash'
        AND b.block_timestamp=(item->>'blockTimestamp')::timestamptz)
      OR (item->>'kind'='exact_log' AND (COALESCE((item->>'exactMatch')::boolean,false) IS NOT TRUE
        OR item->>'quoteId' !~ '^0x[0-9a-f]{64}$')) THEN
     RAISE EXCEPTION 'invalid scanner observation' USING ERRCODE='23514';
   END IF;
   INSERT INTO gate.settlement_scan_observations(range_id,deployment_id,scan_generation,kind,quote_id,tx_hash,log_index,block_number,block_hash,block_timestamp,exact_match,details)
     VALUES(v_range_id,p_deployment_id,p_generation,item->>'kind',NULLIF(item->>'quoteId',''),item->>'txHash',(item->>'logIndex')::integer,
       (item->>'blockNumber')::bigint,item->>'blockHash',(item->>'blockTimestamp')::timestamptz,
       COALESCE((item->>'exactMatch')::boolean,false),COALESCE(item->'details','{}'::jsonb));
 END LOOP;
 -- Every current canonical block from deployment through the checkpoint must exist. Latest generation wins per block.
 SELECT count(*) INTO block_count FROM (SELECT b.block_number,max(b.scan_generation)
   FROM gate.settlement_scan_blocks b WHERE b.deployment_id=p_deployment_id
     AND b.parent_hash IS NOT NULL
     AND b.block_number BETWEEN c.deployment_block AND p_through GROUP BY b.block_number) current_blocks;
 IF block_count<>p_through-c.deployment_block+1 THEN
   RAISE EXCEPTION 'scanner block evidence does not provide contiguous deployment coverage' USING ERRCODE='23514';
 END IF;
 -- Browser-submitted tx hashes are reconciled only by inspectTransaction(); a canonical range without a confirmed log
 -- says nothing about whether the hinted transaction is still pending or below the one-confirmation-safe head.
 -- Accepted is final, but a canonical rewrite invalidates its current evidence and records a private operator anomaly.
 WITH reorged AS (
   UPDATE gate.quotes q SET settlement_reorged_at=COALESCE(q.settlement_reorged_at,clock_timestamp())
     WHERE q.deployment_id=p_deployment_id AND q.state='settled' AND q.receipt_block BETWEEN p_from AND p_through
       AND NOT EXISTS(SELECT 1 FROM gate.settlement_scan_observations o WHERE o.range_id=v_range_id
         AND o.quote_id=q.quote_id AND o.exact_match AND o.tx_hash=q.settled_tx_hash AND o.log_index=q.settled_log_index
         AND o.block_number=q.receipt_block AND o.block_hash=q.receipt_block_hash AND o.block_timestamp=q.receipt_block_timestamp)
     RETURNING q.id,q.receipt_block,q.receipt_block_hash,q.settled_tx_hash,q.settled_log_index,q.settlement_reorged_at
 ) UPDATE gate.settlement_reorg_monitors m SET reconciliation_metadata=m.reconciliation_metadata||jsonb_build_object(
     'trailingOverlapReorg',jsonb_build_object('detectedAt',r.settlement_reorged_at,'generation',p_generation,
       'receiptBlock',r.receipt_block,'receiptBlockHash',r.receipt_block_hash,'txHash',r.settled_tx_hash,'logIndex',r.settled_log_index))
   FROM reorged r WHERE m.quote_id=r.id;
 UPDATE gate.settlement_cursors SET next_range_from=greatest(c.next_range_from,p_through+1),checkpoint_block=p_through,
   canonical_block_hash=p_hash,checkpoint_block_timestamp=p_timestamp,scan_generation=p_generation,
   reconciliation_metadata=COALESCE(p_metadata->'metadata','{}'::jsonb),updated_at=clock_timestamp() WHERE id=c.id;
 UPDATE gate.splitter_deployments SET scanner_cursor=greatest(scanner_cursor,p_through+1) WHERE id=p_deployment_id;
 -- Only observations attached to the latest generation for their block are current canonical release blockers.
 WITH eligible AS (
   SELECT q.id FROM gate.quotes q JOIN gate.capacity_reservations r ON r.quote_id=q.id
   WHERE q.deployment_id=p_deployment_id AND q.state='expired' AND r.state='expiry_pending_reconciliation'
     AND q.expires_at<=p_timestamp
     AND NOT EXISTS (SELECT 1 FROM gate.settlement_scan_observations o
       WHERE o.deployment_id=p_deployment_id AND o.quote_id=q.quote_id AND o.exact_match AND o.block_timestamp<q.expires_at
         AND o.scan_generation=(SELECT max(b.scan_generation) FROM gate.settlement_scan_blocks b
           WHERE b.deployment_id=o.deployment_id AND b.block_number=o.block_number AND b.parent_hash IS NOT NULL))
   ORDER BY q.id FOR UPDATE OF q
 ), released AS (
   UPDATE gate.capacity_reservations r SET state='released',released_at=clock_timestamp(),updated_at=clock_timestamp(),
     scanner_cursor=greatest(c.next_range_from,p_through+1),release_range_from=c.deployment_block,release_range_to=p_through,release_canonical_block_hash=p_hash
   FROM eligible e WHERE r.quote_id=e.id AND r.state='expiry_pending_reconciliation' RETURNING r.quote_id
 ), updated_quotes AS (
   UPDATE gate.quotes q SET reservation_state='released' FROM released r WHERE q.id=r.quote_id RETURNING q.id
 ) SELECT count(*)::integer INTO released_count FROM updated_quotes;
 RETURN released_count;
END $$;
REVOKE ALL ON FUNCTION gate.record_scanner_range(text,bigint,bigint,text,timestamptz,jsonb) FROM PUBLIC;

CREATE OR REPLACE FUNCTION gate.release_expired_reservation(p_quote_id text,p_deployment_id text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
DECLARE
  q gate.quotes%ROWTYPE;
  r gate.capacity_reservations%ROWTYPE;
  c gate.settlement_cursors%ROWTYPE;
BEGIN
 SELECT * INTO c FROM gate.settlement_cursors WHERE deployment_id=p_deployment_id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'scanner deployment mismatch' USING ERRCODE='23514'; END IF;
 SELECT * INTO q FROM gate.quotes WHERE quote_id=p_quote_id FOR UPDATE;
 IF NOT FOUND OR q.deployment_id<>p_deployment_id THEN RAISE EXCEPTION 'scanner deployment mismatch' USING ERRCODE='23514'; END IF;
 SELECT * INTO r FROM gate.capacity_reservations WHERE quote_id=q.id FOR UPDATE;
 IF r.state='released' THEN RETURN false; END IF;
 IF q.state<>'expired' OR r.state<>'expiry_pending_reconciliation' THEN
   RAISE EXCEPTION 'reservation is not expiry pending' USING ERRCODE='23514';
 END IF;
 -- Caller booleans and asserted lastEligibleBlock values are deliberately absent. The range rows are the authority.
 IF c.checkpoint_block IS NULL OR c.checkpoint_block_timestamp IS NULL OR c.checkpoint_block_timestamp<q.expires_at
    OR c.next_range_from<>c.checkpoint_block+1
    OR (SELECT count(*) FROM (SELECT b.block_number,max(b.scan_generation)
      FROM gate.settlement_scan_blocks b WHERE b.deployment_id=p_deployment_id
        AND b.parent_hash IS NOT NULL
        AND b.block_number BETWEEN c.deployment_block AND c.checkpoint_block GROUP BY b.block_number) current_blocks)
      <>c.checkpoint_block-c.deployment_block+1
    OR EXISTS(SELECT 1 FROM gate.settlement_scan_observations o WHERE o.deployment_id=p_deployment_id
      AND o.quote_id=q.quote_id AND o.exact_match AND o.block_timestamp<q.expires_at
      AND o.scan_generation=(SELECT max(b.scan_generation) FROM gate.settlement_scan_blocks b
        WHERE b.deployment_id=o.deployment_id AND b.block_number=o.block_number AND b.parent_hash IS NOT NULL)) THEN
   RAISE EXCEPTION 'persisted canonical scanner evidence does not cover quote expiry' USING ERRCODE='23514';
 END IF;
 UPDATE gate.capacity_reservations SET state='released',released_at=clock_timestamp(),updated_at=clock_timestamp(),
   scanner_cursor=c.next_range_from,release_range_from=c.deployment_block,release_range_to=c.checkpoint_block,
   release_canonical_block_hash=c.canonical_block_hash WHERE id=r.id;
 UPDATE gate.quotes SET reservation_state='released' WHERE id=q.id;
 RETURN true;
END $$;
REVOKE ALL ON FUNCTION gate.release_expired_reservation(text,text) FROM PUBLIC;

CREATE TABLE IF NOT EXISTS gate.settlement_reorg_monitors (
 id text PRIMARY KEY, chain_id bigint NOT NULL CHECK(chain_id>0), splitter text NOT NULL CHECK(splitter ~ '^0x[0-9a-f]{40}$'),
 quote_id text NOT NULL REFERENCES gate.quotes(id), receipt_block bigint NOT NULL CHECK(receipt_block>=0), receipt_block_hash text NOT NULL CHECK(receipt_block_hash ~ '^0x[0-9a-f]{64}$'),
 tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'), log_index integer NOT NULL CHECK(log_index>=0), next_check_block bigint NOT NULL CHECK(next_check_block>=receipt_block),
 progress_block bigint, reconciliation_metadata jsonb NOT NULL DEFAULT '{}'::jsonb, completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(chain_id,splitter,quote_id), UNIQUE(chain_id,splitter,tx_hash,log_index)
);
ALTER TABLE gate.settlement_reorg_monitors ADD COLUMN IF NOT EXISTS claimed_until timestamptz;
ALTER TABLE gate.settlement_reorg_monitors ADD COLUMN IF NOT EXISTS claim_generation bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS settlement_monitors_due_idx ON gate.settlement_reorg_monitors(chain_id,splitter,next_check_block) WHERE completed_at IS NULL;

CREATE OR REPLACE FUNCTION gate.validate_relational_bindings() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,gate AS $$
DECLARE
  expected_profile text;
  expected_lifecycle gate.lifecycle;
  expected_payer text;
  expected_voter text;
  expected_amount numeric(78,0);
  expected_expiry timestamptz;
  expected_chain bigint;
  expected_splitter text;
  expected_receipt_block bigint;
  expected_receipt_hash text;
  expected_tx_hash text;
  expected_log_index integer;
  expected_submission_hash text;
  expected_gavel_recipient text;
  issuance_deployment gate.splitter_deployments%ROWTYPE;
  release_cursor gate.settlement_cursors%ROWTYPE;
BEGIN
 IF TG_TABLE_NAME='quotes' THEN
   SELECT s.payer,p.wallet,s.submission_hash,d.gavel_recipient INTO expected_payer,expected_voter,expected_submission_hash,expected_gavel_recipient
     FROM gate.submissions s JOIN gate.profiles p ON p.id=s.profile_id JOIN gate.splitter_deployments d ON d.id=NEW.deployment_id
     WHERE s.id=NEW.submission_id;
   IF NOT FOUND OR NEW.payer<>expected_payer OR NEW.voter<>expected_voter THEN
     RAISE EXCEPTION 'quote is not bound to its submission payer and profile voter' USING ERRCODE='23514'; END IF;
   IF TG_OP='INSERT' THEN
     SELECT * INTO issuance_deployment FROM gate.splitter_deployments WHERE id=NEW.deployment_id;
     IF NOT FOUND OR NOT issuance_deployment.issuance_active
        OR issuance_deployment.chain_id<>NEW.base_chain_id OR issuance_deployment.splitter<>NEW.splitter
        OR issuance_deployment.token<>NEW.token
        OR NOT COALESCE((issuance_deployment.config->>'environment'='production'
              AND NEW.base_chain_id=8453
              AND NEW.token='0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')
          OR (issuance_deployment.config->>'environment'='test'
              AND NEW.base_chain_id=84532
              AND jsonb_typeof(issuance_deployment.config->'testTokenLabel')='string'
              AND NULLIF(btrim(issuance_deployment.config->>'testTokenLabel'),'') IS NOT NULL),false) THEN
       RAISE EXCEPTION 'quote deployment environment is not issuance-active for its chain and token' USING ERRCODE='23514';
     END IF;
   END IF;
   IF NEW.state='settled' AND (NEW.settlement_event_quote_id<>NEW.quote_id OR NEW.settlement_payer<>NEW.payer
      OR NEW.settlement_voter<>NEW.voter OR NEW.settlement_attention_amount<>NEW.attention_amount
      OR NEW.settlement_fee_amount<>NEW.fee_amount OR NEW.settlement_gavel_recipient<>expected_gavel_recipient OR NEW.settlement_token<>NEW.token
      OR NEW.settlement_submission_hash<>expected_submission_hash OR NEW.settlement_quote_version<>NEW.quote_version
      OR NEW.settlement_source_chain_id<>NEW.base_chain_id OR NEW.settlement_splitter<>NEW.splitter
      OR NEW.receipt_block_timestamp>=NEW.expires_at) THEN
     RAISE EXCEPTION 'settlement evidence is not exact or pre-expiry' USING ERRCODE='23514'; END IF;
   IF NEW.state='settled' AND (TG_OP='INSERT' OR OLD.state<>'settled')
      AND NOT EXISTS(SELECT 1 FROM gate.settlement_scan_observations o
      WHERE o.deployment_id=NEW.deployment_id AND o.kind='exact_log' AND o.exact_match AND o.quote_id=NEW.quote_id
        AND o.tx_hash=NEW.settled_tx_hash AND o.log_index=NEW.settled_log_index AND o.block_number=NEW.receipt_block
        AND o.block_hash=NEW.receipt_block_hash AND o.block_timestamp=NEW.receipt_block_timestamp
        AND o.scan_generation=(SELECT max(b.scan_generation) FROM gate.settlement_scan_blocks b
          WHERE b.deployment_id=o.deployment_id AND b.block_number=o.block_number AND b.parent_hash IS NOT NULL)) THEN
     RAISE EXCEPTION 'settlement evidence was not persisted by scanner' USING ERRCODE='23514';
   END IF;
 ELSIF TG_TABLE_NAME='capacity_reservations' THEN
   SELECT s.profile_id,q.attention_amount,q.expires_at INTO expected_profile,expected_amount,expected_expiry
     FROM gate.quotes q JOIN gate.submissions s ON s.id=q.submission_id WHERE q.id=NEW.quote_id;
   IF NOT FOUND OR NEW.profile_id<>expected_profile OR NEW.amount<>expected_amount OR NEW.expires_at<>expected_expiry THEN
     RAISE EXCEPTION 'reservation is not bound to its quote and profile' USING ERRCODE='23514'; END IF;
   IF NEW.state='released' THEN
     SELECT c.* INTO release_cursor FROM gate.settlement_cursors c JOIN gate.quotes q ON q.deployment_id=c.deployment_id WHERE q.id=NEW.quote_id;
     IF NOT FOUND OR release_cursor.checkpoint_block_timestamp IS NULL OR release_cursor.canonical_block_hash IS NULL
       OR release_cursor.checkpoint_block_timestamp<NEW.expires_at
       OR release_cursor.next_range_from<>release_cursor.checkpoint_block+1 OR NEW.scanner_cursor<>release_cursor.next_range_from
       OR NEW.release_range_from<>release_cursor.deployment_block OR NEW.release_range_to<>release_cursor.checkpoint_block
       OR NEW.release_canonical_block_hash<>release_cursor.canonical_block_hash THEN
       RAISE EXCEPTION 'release lacks persisted canonical cursor/block-time evidence' USING ERRCODE='23514'; END IF;
     IF (SELECT count(*) FROM (SELECT b.block_number,max(b.scan_generation)
          FROM gate.settlement_scan_blocks b WHERE b.deployment_id=release_cursor.deployment_id
            AND b.parent_hash IS NOT NULL
            AND b.block_number BETWEEN release_cursor.deployment_block AND release_cursor.checkpoint_block
          GROUP BY b.block_number) current_blocks)<>release_cursor.checkpoint_block-release_cursor.deployment_block+1
        OR EXISTS(SELECT 1 FROM gate.settlement_scan_observations o JOIN gate.quotes q ON q.id=NEW.quote_id
          WHERE o.deployment_id=release_cursor.deployment_id AND o.quote_id=q.quote_id AND o.exact_match
            AND o.block_timestamp<NEW.expires_at
            AND o.scan_generation=(SELECT max(b.scan_generation) FROM gate.settlement_scan_blocks b
              WHERE b.deployment_id=o.deployment_id AND b.block_number=o.block_number AND b.parent_hash IS NOT NULL)) THEN
       RAISE EXCEPTION 'release lacks contiguous persisted scanner range/log evidence' USING ERRCODE='23514'; END IF;
   END IF;
 ELSIF TG_TABLE_NAME='inbox_items' THEN
   SELECT s.profile_id,ps.normalized_eligibility::gate.lifecycle INTO expected_profile,expected_lifecycle
     FROM gate.submissions s JOIN gate.proposal_snapshots ps ON ps.id=s.issuance_snapshot_id WHERE s.id=NEW.submission_id;
   IF NOT FOUND OR NEW.profile_id<>expected_profile OR NEW.issuance_lifecycle<>expected_lifecycle THEN
     RAISE EXCEPTION 'inbox is not bound to its submission profile' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='settlement_reorg_monitors' THEN
   SELECT base_chain_id,splitter,receipt_block,receipt_block_hash,settled_tx_hash,settled_log_index
     INTO expected_chain,expected_splitter,expected_receipt_block,expected_receipt_hash,expected_tx_hash,expected_log_index
     FROM gate.quotes WHERE id=NEW.quote_id;
   IF NOT FOUND OR NEW.chain_id<>expected_chain OR NEW.splitter<>expected_splitter OR NEW.receipt_block<>expected_receipt_block
      OR NEW.receipt_block_hash<>expected_receipt_hash OR NEW.tx_hash<>expected_tx_hash OR NEW.log_index<>expected_log_index THEN
     RAISE EXCEPTION 'monitor is not bound to exact immutable settlement evidence' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS quotes_validate_bindings ON gate.quotes;
CREATE TRIGGER quotes_validate_bindings BEFORE INSERT OR UPDATE ON gate.quotes FOR EACH ROW EXECUTE FUNCTION gate.validate_relational_bindings();
DROP TRIGGER IF EXISTS capacity_reservations_validate_bindings ON gate.capacity_reservations;
CREATE TRIGGER capacity_reservations_validate_bindings BEFORE INSERT OR UPDATE ON gate.capacity_reservations FOR EACH ROW EXECUTE FUNCTION gate.validate_relational_bindings();
DROP TRIGGER IF EXISTS inbox_items_validate_bindings ON gate.inbox_items;
CREATE TRIGGER inbox_items_validate_bindings BEFORE INSERT OR UPDATE ON gate.inbox_items FOR EACH ROW EXECUTE FUNCTION gate.validate_relational_bindings();
DROP TRIGGER IF EXISTS settlement_monitors_validate_bindings ON gate.settlement_reorg_monitors;
CREATE TRIGGER settlement_monitors_validate_bindings BEFORE INSERT OR UPDATE ON gate.settlement_reorg_monitors FOR EACH ROW EXECUTE FUNCTION gate.validate_relational_bindings();

CREATE OR REPLACE FUNCTION gate.protect_immutable_issuance() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable Gate record' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='proposal_snapshots' THEN
   IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION 'immutable proposal snapshot' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='submissions' THEN
   IF ROW(NEW.public_id,NEW.submission_hash,NEW.profile_id,NEW.issuance_snapshot_id,NEW.payer,NEW.signed_sender,NEW.material)
     IS DISTINCT FROM ROW(OLD.public_id,OLD.submission_hash,OLD.profile_id,OLD.issuance_snapshot_id,OLD.payer,OLD.signed_sender,OLD.material) THEN
     RAISE EXCEPTION 'immutable submission issuance material' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='quotes' THEN
   IF ROW(NEW.quote_id,NEW.submission_id,NEW.payer,NEW.voter,NEW.attention_amount,NEW.fee_amount,NEW.token,NEW.base_chain_id,NEW.splitter,NEW.deployment_id,NEW.quote_version,NEW.expires_at)
     IS DISTINCT FROM ROW(OLD.quote_id,OLD.submission_id,OLD.payer,OLD.voter,OLD.attention_amount,OLD.fee_amount,OLD.token,OLD.base_chain_id,OLD.splitter,OLD.deployment_id,OLD.quote_version,OLD.expires_at) THEN
     RAISE EXCEPTION 'immutable quote issuance material' USING ERRCODE='23514'; END IF;
   IF OLD.quote_signature IS NOT NULL AND NEW.quote_signature IS DISTINCT FROM OLD.quote_signature THEN
     RAISE EXCEPTION 'immutable quote signature' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION gate.protect_settlement_evidence() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF OLD.settled_tx_hash IS NOT NULL AND ROW(NEW.settled_tx_hash,NEW.settled_log_index,NEW.settled_at,NEW.receipt_block,NEW.receipt_block_hash,NEW.receipt_block_timestamp,
 NEW.settlement_proof_canonical,NEW.settlement_scanner_verified,NEW.settlement_event_quote_id,NEW.settlement_confirmations,NEW.settlement_payer,NEW.settlement_voter,NEW.settlement_attention_amount,NEW.settlement_fee_amount,
 NEW.settlement_gavel_recipient,NEW.settlement_token,NEW.settlement_submission_hash,NEW.settlement_quote_version,NEW.settlement_source_chain_id,NEW.settlement_splitter)
 IS DISTINCT FROM ROW(OLD.settled_tx_hash,OLD.settled_log_index,OLD.settled_at,OLD.receipt_block,OLD.receipt_block_hash,OLD.receipt_block_timestamp,
 OLD.settlement_proof_canonical,OLD.settlement_scanner_verified,OLD.settlement_event_quote_id,OLD.settlement_confirmations,OLD.settlement_payer,OLD.settlement_voter,OLD.settlement_attention_amount,OLD.settlement_fee_amount,
 OLD.settlement_gavel_recipient,OLD.settlement_token,OLD.settlement_submission_hash,OLD.settlement_quote_version,OLD.settlement_source_chain_id,OLD.settlement_splitter)
 THEN RAISE EXCEPTION 'immutable settlement evidence' USING ERRCODE='23514'; END IF; RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION gate.protect_splitter_deployment_identity() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable Gate relationship' USING ERRCODE='23514'; END IF;
 IF ROW(NEW.chain_id,NEW.splitter,NEW.signer,NEW.token,NEW.gavel_recipient,NEW.deployment_block,NEW.contract_code_hash,
      NEW.config->'environment',NEW.config->'testTokenLabel')
    IS DISTINCT FROM
    ROW(OLD.chain_id,OLD.splitter,OLD.signer,OLD.token,OLD.gavel_recipient,OLD.deployment_block,OLD.contract_code_hash,
      OLD.config->'environment',OLD.config->'testTokenLabel')
 THEN RAISE EXCEPTION 'immutable deployment identity' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION gate.protect_immutable_relationship() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'immutable Gate relationship' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='capacity_reservations' THEN
   IF ROW(NEW.profile_id,NEW.quote_id,NEW.amount,NEW.expires_at) IS DISTINCT FROM ROW(OLD.profile_id,OLD.quote_id,OLD.amount,OLD.expires_at)
   THEN RAISE EXCEPTION 'immutable capacity reservation relationship' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='inbox_items' THEN
   IF ROW(NEW.submission_id,NEW.profile_id,NEW.inbox_created_at) IS DISTINCT FROM ROW(OLD.submission_id,OLD.profile_id,OLD.inbox_created_at)
   THEN RAISE EXCEPTION 'immutable inbox relationship' USING ERRCODE='23514'; END IF;
 ELSIF TG_TABLE_NAME='settlement_reorg_monitors' THEN
   IF ROW(NEW.chain_id,NEW.splitter,NEW.quote_id,NEW.receipt_block,NEW.receipt_block_hash,NEW.tx_hash,NEW.log_index)
   IS DISTINCT FROM ROW(OLD.chain_id,OLD.splitter,OLD.quote_id,OLD.receipt_block,OLD.receipt_block_hash,OLD.tx_hash,OLD.log_index)
   THEN RAISE EXCEPTION 'immutable settlement evidence' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS splitter_deployments_immutable_identity ON gate.splitter_deployments;
CREATE TRIGGER splitter_deployments_immutable_identity BEFORE UPDATE OR DELETE ON gate.splitter_deployments
  FOR EACH ROW EXECUTE FUNCTION gate.protect_splitter_deployment_identity();
DROP TRIGGER IF EXISTS proposal_snapshots_immutable ON gate.proposal_snapshots;
CREATE TRIGGER proposal_snapshots_immutable BEFORE UPDATE OR DELETE ON gate.proposal_snapshots FOR EACH ROW EXECUTE FUNCTION gate.protect_immutable_issuance();
DROP TRIGGER IF EXISTS submissions_immutable_issuance ON gate.submissions;
CREATE TRIGGER submissions_immutable_issuance BEFORE UPDATE OR DELETE ON gate.submissions FOR EACH ROW EXECUTE FUNCTION gate.protect_immutable_issuance();
DROP TRIGGER IF EXISTS quotes_immutable_issuance ON gate.quotes;
CREATE TRIGGER quotes_immutable_issuance BEFORE UPDATE OR DELETE ON gate.quotes FOR EACH ROW EXECUTE FUNCTION gate.protect_immutable_issuance();
DROP TRIGGER IF EXISTS quotes_immutable_settlement ON gate.quotes;
CREATE TRIGGER quotes_immutable_settlement BEFORE UPDATE ON gate.quotes FOR EACH ROW EXECUTE FUNCTION gate.protect_settlement_evidence();
DROP TRIGGER IF EXISTS capacity_reservations_immutable_relationship ON gate.capacity_reservations;
CREATE TRIGGER capacity_reservations_immutable_relationship BEFORE UPDATE OR DELETE ON gate.capacity_reservations FOR EACH ROW EXECUTE FUNCTION gate.protect_immutable_relationship();
DROP TRIGGER IF EXISTS inbox_items_immutable_relationship ON gate.inbox_items;
CREATE TRIGGER inbox_items_immutable_relationship BEFORE UPDATE OR DELETE ON gate.inbox_items FOR EACH ROW EXECUTE FUNCTION gate.protect_immutable_relationship();
DROP TRIGGER IF EXISTS settlement_monitors_immutable_evidence ON gate.settlement_reorg_monitors;
CREATE TRIGGER settlement_monitors_immutable_evidence BEFORE UPDATE OR DELETE ON gate.settlement_reorg_monitors FOR EACH ROW EXECUTE FUNCTION gate.protect_immutable_relationship();

CREATE OR REPLACE FUNCTION gate.enforce_state_transition() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
 IF TG_TABLE_NAME='notification_attempts' THEN
   IF TG_OP='INSERT' AND NEW.state<>'pending' THEN
     RAISE EXCEPTION 'notification must start pending' USING ERRCODE='23514';
   ELSIF TG_OP='UPDATE' AND OLD.manual_reconciliation_at IS NOT NULL
     AND (NEW.manual_reconciliation_at IS DISTINCT FROM OLD.manual_reconciliation_at OR NEW.state<>'failed') THEN
     RAISE EXCEPTION 'manual reconciliation is terminal' USING ERRCODE='23514';
   ELSIF TG_OP='UPDATE'
     AND NOT ((OLD.state='pending' AND NEW.state IN('pending','sent','failed')) OR (OLD.state='failed' AND NEW.state IN('failed','pending')) OR (OLD.state='sent' AND NEW.state='sent')) THEN
     RAISE EXCEPTION 'invalid notification transition' USING ERRCODE='23514';
   END IF;
 ELSIF TG_TABLE_NAME='capacity_reservations' THEN
   IF TG_OP='UPDATE' AND NOT ((OLD.state='active' AND NEW.state IN('active','expiry_pending_reconciliation','consumed'))
     OR (OLD.state='expiry_pending_reconciliation' AND NEW.state IN('expiry_pending_reconciliation','released','consumed'))
     OR (OLD.state='released' AND NEW.state IN('released','consumed')) OR (OLD.state='consumed' AND NEW.state='consumed')) THEN
     RAISE EXCEPTION 'invalid reservation transition' USING ERRCODE='23514';
   END IF;
 ELSIF TG_TABLE_NAME='quotes' THEN
   IF TG_OP='UPDATE' AND NOT ((OLD.state='quoted' AND NEW.state IN('quoted','expired','settled')) OR (OLD.state='expired' AND NEW.state IN('expired','settled')) OR (OLD.state='settled' AND NEW.state='settled')) THEN
     RAISE EXCEPTION 'invalid quote transition' USING ERRCODE='23514';
   END IF;
 ELSIF TG_TABLE_NAME='submissions' THEN
   IF TG_OP='UPDATE' AND NOT ((OLD.status='QUOTED' AND NEW.status IN('QUOTED','SETTLEMENT_PENDING','EXPIRED','SETTLED'))
     OR (OLD.status='SETTLEMENT_PENDING' AND NEW.status IN('SETTLEMENT_PENDING','QUOTED','EXPIRED','SETTLED'))
     OR (OLD.status='EXPIRED' AND NEW.status IN('EXPIRED','SETTLED')) OR (OLD.status='SETTLED' AND NEW.status='SETTLED')) THEN
     RAISE EXCEPTION 'invalid submission transition' USING ERRCODE='23514';
   END IF;
 END IF; RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS quotes_state_transition ON gate.quotes;
DROP TRIGGER IF EXISTS submissions_state_transition ON gate.submissions;
DROP TRIGGER IF EXISTS reservations_state_transition ON gate.capacity_reservations;
DROP TRIGGER IF EXISTS notifications_state_transition ON gate.notification_attempts;
CREATE TRIGGER quotes_state_transition BEFORE UPDATE ON gate.quotes FOR EACH ROW EXECUTE FUNCTION gate.enforce_state_transition();
CREATE TRIGGER submissions_state_transition BEFORE UPDATE ON gate.submissions FOR EACH ROW EXECUTE FUNCTION gate.enforce_state_transition();
CREATE TRIGGER reservations_state_transition BEFORE UPDATE ON gate.capacity_reservations FOR EACH ROW EXECUTE FUNCTION gate.enforce_state_transition();
CREATE TRIGGER notifications_state_transition BEFORE INSERT OR UPDATE ON gate.notification_attempts FOR EACH ROW EXECUTE FUNCTION gate.enforce_state_transition();

DO $$ BEGIN
 IF COALESCE((SELECT migration_checksum FROM public.schema_migrations WHERE version='gate/001_gate-v3'),'')
    <> 'sha256:gate-001-v3-bound-delivery-settings' THEN
  UPDATE gate.notification_attempts SET state='failed',error_code='PROVIDER_IDEMPOTENCY_HISTORY_UNKNOWN',
    manual_reconciliation_at=clock_timestamp(),claimed_until=NULL,updated_at=clock_timestamp()
  WHERE claim_generation>0 AND first_attempt_at IS NULL AND dedupe_deadline IS NULL
    AND state IN('pending','failed') AND manual_reconciliation_at IS NULL;
 END IF;
END $$;

CREATE OR REPLACE FUNCTION gate.validate_state_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE qid text; qstate gate.quote_state; qsig text; sstate text; rstate gate.reservation_state; inbox_count integer; notice_count integer; monitor_count integer;
BEGIN
 IF TG_TABLE_NAME='quotes' THEN qid:=NEW.id;
 ELSIF TG_TABLE_NAME='capacity_reservations' THEN qid:=NEW.quote_id;
 ELSIF TG_TABLE_NAME='submissions' THEN SELECT id INTO qid FROM gate.quotes WHERE submission_id=NEW.id;
 ELSIF TG_TABLE_NAME='inbox_items' THEN SELECT id INTO qid FROM gate.quotes WHERE submission_id=NEW.submission_id;
 ELSIF TG_TABLE_NAME='notification_attempts' THEN SELECT q.id INTO qid FROM gate.quotes q JOIN gate.inbox_items i ON i.submission_id=q.submission_id WHERE i.id=NEW.inbox_id;
 ELSE qid:=NEW.quote_id; END IF;
 IF qid IS NULL THEN RETURN NULL; END IF;
 SELECT q.state,q.quote_signature,s.status,r.state INTO qstate,qsig,sstate,rstate FROM gate.quotes q
   JOIN gate.submissions s ON s.id=q.submission_id JOIN gate.capacity_reservations r ON r.quote_id=q.id WHERE q.id=qid;
 IF NOT FOUND OR qsig IS NULL THEN RAISE EXCEPTION 'incomplete signed issuance graph' USING ERRCODE='23514'; END IF;
 SELECT count(*) INTO inbox_count FROM gate.inbox_items i JOIN gate.quotes q ON q.submission_id=i.submission_id WHERE q.id=qid;
 SELECT count(*) INTO notice_count FROM gate.notification_attempts n JOIN gate.inbox_items i ON i.id=n.inbox_id JOIN gate.quotes q ON q.submission_id=i.submission_id WHERE q.id=qid;
 SELECT count(*) INTO monitor_count FROM gate.settlement_reorg_monitors WHERE quote_id=qid;
 IF (qstate='quoted' AND (sstate NOT IN('QUOTED','SETTLEMENT_PENDING') OR rstate<>'active' OR inbox_count<>0 OR notice_count<>0 OR monitor_count<>0))
   OR (qstate='expired' AND (sstate<>'EXPIRED' OR rstate NOT IN('expiry_pending_reconciliation','released') OR inbox_count<>0 OR notice_count<>0 OR monitor_count<>0))
   OR (qstate='settled' AND (sstate<>'SETTLED' OR rstate<>'consumed' OR inbox_count<>1 OR notice_count NOT BETWEEN 0 AND 1 OR monitor_count<>1)) THEN
   RAISE EXCEPTION 'inconsistent Gate quote/submission/reservation/inbox/notification/monitor graph' USING ERRCODE='23514';
 END IF; RETURN NULL;
END $$;

DROP TRIGGER IF EXISTS quotes_consistent ON gate.quotes;
DROP TRIGGER IF EXISTS submissions_consistent ON gate.submissions;
DROP TRIGGER IF EXISTS reservations_consistent ON gate.capacity_reservations;
DROP TRIGGER IF EXISTS inbox_consistent ON gate.inbox_items;
DROP TRIGGER IF EXISTS notifications_consistent ON gate.notification_attempts;
DROP TRIGGER IF EXISTS monitors_consistent ON gate.settlement_reorg_monitors;
CREATE CONSTRAINT TRIGGER quotes_consistent AFTER INSERT OR UPDATE ON gate.quotes DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gate.validate_state_consistency();
CREATE CONSTRAINT TRIGGER submissions_consistent AFTER INSERT OR UPDATE ON gate.submissions DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gate.validate_state_consistency();
CREATE CONSTRAINT TRIGGER reservations_consistent AFTER INSERT OR UPDATE ON gate.capacity_reservations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gate.validate_state_consistency();
CREATE CONSTRAINT TRIGGER inbox_consistent AFTER INSERT OR UPDATE ON gate.inbox_items DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gate.validate_state_consistency();
CREATE CONSTRAINT TRIGGER notifications_consistent AFTER INSERT OR UPDATE ON gate.notification_attempts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gate.validate_state_consistency();
CREATE CONSTRAINT TRIGGER monitors_consistent AFTER INSERT OR UPDATE ON gate.settlement_reorg_monitors DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION gate.validate_state_consistency();

-- Public callers receive SELECT on owner-backed, non-updatable projections only.
-- They never receive USAGE on the private Gate schema or privileges on its tables.
CREATE SCHEMA IF NOT EXISTS gate_public;
REVOKE ALL ON SCHEMA gate_public FROM PUBLIC;
DROP VIEW IF EXISTS gate_public.profiles;
CREATE OR REPLACE VIEW gate_public.profiles WITH (security_barrier=true) AS
 SELECT id,wallet,wallet_kind,availability,
   CASE WHEN jsonb_typeof(display_cache->'ens')='string' THEN display_cache->>'ens' END AS ens,
   CASE WHEN jsonb_typeof(display_cache->'message')='string' THEN display_cache->>'message' END AS message,
   enrolled_at,updated_at FROM gate.profiles;
CREATE OR REPLACE VIEW gate_public.dao_policies WITH (security_barrier=true) AS
 SELECT profile_id,dao,chain_id,enabled,accept_pre_vote,accept_voting,attention_amount,public_tags FROM gate.dao_policies;
CREATE OR REPLACE VIEW gate_public.submission_receipts WITH (security_barrier=true) AS
 SELECT s.public_id,
   CASE s.status WHEN 'SETTLED' THEN 'accepted' WHEN 'EXPIRED' THEN 'expired'
     WHEN 'SETTLEMENT_PENDING' THEN 'pending_settlement' WHEN 'QUOTED' THEN 'payment_required' END::text AS state,
   CASE WHEN s.status='SETTLED' THEN NULL ELSE s.public_state_changed_at END AS updated_at,
   CASE WHEN s.status='SETTLED' THEN i.inbox_created_at ELSE NULL END AS accepted_at
 FROM gate.submissions s LEFT JOIN gate.inbox_items i ON i.submission_id=s.id;
REVOKE ALL ON ALL TABLES IN SCHEMA gate_public FROM PUBLIC;

-- Remove inherited/default Gate grants, then apply the matrix audited in roles.js.
REVOKE ALL ON ALL TABLES IN SCHEMA gate FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA gate FROM PUBLIC;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gavel_gate') THEN
  REVOKE ALL ON ALL TABLES IN SCHEMA public FROM gavel_gate; REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM gavel_gate;
  REVOKE ALL ON ALL TABLES IN SCHEMA gate FROM gavel_gate; REVOKE ALL ON ALL SEQUENCES IN SCHEMA gate FROM gavel_gate;
  REVOKE ALL ON ALL TABLES IN SCHEMA gate_public FROM gavel_gate; REVOKE ALL ON SCHEMA gate_public FROM gavel_gate;
  ALTER DEFAULT PRIVILEGES IN SCHEMA gate REVOKE ALL ON TABLES FROM gavel_gate;
  ALTER DEFAULT PRIVILEGES IN SCHEMA gate REVOKE ALL ON SEQUENCES FROM gavel_gate;
  GRANT USAGE ON SCHEMA gate TO gavel_gate;
  GRANT SELECT ON gate.profiles,gate.dao_policies TO gavel_gate;
  GRANT SELECT,INSERT,UPDATE ON gate.splitter_deployments,gate.submissions,gate.quotes,gate.capacity_reservations,
    gate.inbox_items,gate.settlement_cursors,gate.settlement_reorg_monitors TO gavel_gate;
  GRANT SELECT,INSERT ON gate.notification_attempts TO gavel_gate;
  GRANT SELECT,INSERT ON gate.proposal_snapshots TO gavel_gate;
  GRANT SELECT ON gate.auth_nonces,gate.auth_sessions,gate.sender_blocks,gate.rate_limit_events,gate.delivery_settings TO gavel_gate;
  GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA gate TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.mutate_profile(text,text,text,gate.availability,jsonb,boolean,timestamptz,boolean,text,boolean,jsonb,boolean) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.mutate_profile(text,text,text,gate.availability,jsonb,boolean,timestamptz,boolean,text,boolean,jsonb) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.transition_notification(text,gate.notification_state,text,boolean,text,boolean,integer) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.transition_notification(text,gate.notification_state,text,text) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.claim_notification_attempts(integer,integer,integer) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.complete_notification_attempt(text,text,text) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.fail_notification_attempt(text,text,text,timestamptz) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.reconcile_notification_attempt(text,text,text) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.record_scanner_range(text,bigint,bigint,text,timestamptz,jsonb) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.release_expired_reservation(text,text) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.insert_auth_nonce(gate.auth_proof_type,gate.auth_purpose,gate.auth_role,text,text,bigint,text,text,text,bigint,bigint) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.consume_auth_nonce(text,bigint) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.insert_auth_session(text,text,gate.auth_role,bigint,text,bigint,bigint) TO gavel_gate;
  GRANT EXECUTE ON FUNCTION gate.set_delivery_setting(text,text,text) TO gavel_gate;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gavel_api') THEN
  REVOKE ALL ON SCHEMA gate FROM gavel_api; REVOKE ALL ON ALL TABLES IN SCHEMA gate FROM gavel_api; REVOKE ALL ON ALL SEQUENCES IN SCHEMA gate FROM gavel_api;
  REVOKE ALL ON ALL TABLES IN SCHEMA gate_public FROM gavel_api; GRANT USAGE ON SCHEMA gate_public TO gavel_api;
  GRANT SELECT ON gate_public.profiles,gate_public.dao_policies,gate_public.submission_receipts TO gavel_api;
 END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='gavel_indexer') THEN
  REVOKE ALL ON SCHEMA gate FROM gavel_indexer; REVOKE ALL ON ALL TABLES IN SCHEMA gate FROM gavel_indexer; REVOKE ALL ON ALL SEQUENCES IN SCHEMA gate FROM gavel_indexer;
  REVOKE ALL ON ALL TABLES IN SCHEMA gate_public FROM gavel_indexer; REVOKE ALL ON SCHEMA gate_public FROM gavel_indexer;
 END IF;
END $$;

-- This manifest is deliberately derived from pg_catalog rather than a marker literal. It
-- covers every Gate relation (including views/sequences), column contract, constraint,
-- index, trigger, function signature/body/config, owner/ACL, schema ACL, and enum label.
CREATE OR REPLACE FUNCTION public.gavel_gate_catalog_manifest() RETURNS jsonb
LANGUAGE sql SET search_path=pg_catalog AS $catalog_manifest$
 SELECT jsonb_build_object(
  'schemas',(SELECT jsonb_agg(jsonb_build_object('name',n.nspname,'owner',pg_get_userbyid(n.nspowner),'acl',n.nspacl::text)
    ORDER BY n.nspname) FROM pg_namespace n WHERE n.nspname IN('gate','gate_public')),
  'relations',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',c.relname,'kind',c.relkind,
    'owner',pg_get_userbyid(c.relowner),'acl',c.relacl::text,'options',c.reloptions,'rowSecurity',c.relrowsecurity,
    'forceRowSecurity',c.relforcerowsecurity,'viewDefinition',CASE WHEN c.relkind IN('v','m') THEN pg_get_viewdef(c.oid,false) END)
    ORDER BY n.nspname,c.relname,c.relkind) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN('gate','gate_public') AND c.relkind IN('r','p','v','m','S')),
  'columns',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'relation',c.relname,'position',a.attnum,
    'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,
    'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,
    'collation',CASE WHEN a.attcollation<>0 THEN a.attcollation::regcollation::text END)
    ORDER BY n.nspname,c.relname,a.attnum) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE n.nspname IN('gate','gate_public') AND c.relkind IN('r','p','v','m') AND a.attnum>0 AND NOT a.attisdropped),
  'constraints',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'relation',c.relname,'name',x.conname,
    'type',x.contype,'deferrable',x.condeferrable,'initiallyDeferred',x.condeferred,'validated',x.convalidated,
    'definition',pg_get_constraintdef(x.oid,false)) ORDER BY n.nspname,c.relname,x.conname)
    FROM pg_constraint x JOIN pg_class c ON c.oid=x.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname IN('gate','gate_public')),
  'indexes',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'relation',c.relname,'name',i.relname,
    'unique',x.indisunique,'primary',x.indisprimary,'valid',x.indisvalid,'ready',x.indisready,
    'definition',pg_get_indexdef(x.indexrelid)) ORDER BY n.nspname,c.relname,i.relname)
    FROM pg_index x JOIN pg_class c ON c.oid=x.indrelid JOIN pg_class i ON i.oid=x.indexrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('gate','gate_public')),
  'triggers',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'relation',c.relname,'name',t.tgname,
    'enabled',t.tgenabled,'constraint',t.tgconstraint<>0,'deferrable',t.tgdeferrable,
    'initiallyDeferred',t.tginitdeferred,'definition',pg_get_triggerdef(t.oid,false))
    ORDER BY n.nspname,c.relname,t.tgname) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname IN('gate','gate_public') AND NOT t.tgisinternal),
  'functions',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',p.proname,
    'identityArguments',pg_get_function_identity_arguments(p.oid),'result',pg_get_function_result(p.oid),
    'language',l.lanname,'securityDefiner',p.prosecdef,'config',p.proconfig,'owner',pg_get_userbyid(p.proowner),
    'acl',p.proacl::text,'kind',p.prokind,'definition',pg_get_functiondef(p.oid))
    ORDER BY n.nspname,p.proname,pg_get_function_identity_arguments(p.oid)) FROM pg_proc p
    JOIN pg_namespace n ON n.oid=p.pronamespace JOIN pg_language l ON l.oid=p.prolang
    WHERE n.nspname='gate' OR (n.nspname='public' AND p.proname='gavel_gate_catalog_manifest')),
  'enums',(SELECT jsonb_agg(jsonb_build_object('schema',n.nspname,'name',t.typname,'label',e.enumlabel,
    'order',e.enumsortorder) ORDER BY n.nspname,t.typname,e.enumsortorder) FROM pg_enum e
    JOIN pg_type t ON t.oid=e.enumtypid JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='gate')
 )
$catalog_manifest$;
REVOKE ALL ON FUNCTION public.gavel_gate_catalog_manifest() FROM PUBLIC;

INSERT INTO public.schema_migrations(version,migration_checksum,catalog_manifest)
 SELECT 'gate/001_gate-v3','sha256:gate-001-v3-bound-delivery-settings',public.gavel_gate_catalog_manifest()
 ON CONFLICT(version) DO UPDATE SET
   migration_checksum=EXCLUDED.migration_checksum,
   catalog_manifest=EXCLUDED.catalog_manifest;
