/**
 * SigningIdentity: the key-backend seam.
 *
 * The execution layer never reads a private key. It depends on this interface:
 *
 *     address(): Promise<Address>
 *     signTypedData(domain, types, message): Promise<Signature>
 *
 * That is what lets BYOH and hosted deployments differ in the only place they
 * should. A Hermes user keeps key material in an OS keychain or an encrypted
 * local keystore; a hosted deployment signs through a KMS or a per-tenant
 * managed signer; neither changes a line of Safe or WaaP code.
 *
 * Deliberately narrow. There is no `exportPrivateKey()`, no `signMessage()` and
 * no `sendTransaction()`: typed-data signing is what a Safe proposal needs, and
 * a narrow interface is what makes a hardware- or HSM-backed implementation
 * possible at all.
 */

const { getAddress } = require("ethers");

/**
 * The contract. Subclass it, or pass any object with the same two methods --
 * `assertSigningIdentity()` is structural on purpose so a KMS client wrapper
 * does not have to import Gavel.
 */
class SigningIdentity {
  /** @returns {Promise<string>} the checksummed address this identity signs as */
  async address() {
    throw new Error("A SigningIdentity must implement address()");
  }

  /** @returns {Promise<string>} a 0x-prefixed EIP-712 signature */
  async signTypedData() {
    throw new Error("A SigningIdentity must implement signTypedData()");
  }
}

function assertSigningIdentity(identity, label = "signing identity") {
  if (!identity || typeof identity !== "object") throw new TypeError(`A ${label} is required`);
  for (const method of ["address", "signTypedData"]) {
    if (typeof identity[method] !== "function") {
      throw new TypeError(`A ${label} must implement ${method}()`);
    }
  }
  return identity;
}

/**
 * A signature must come back from the backend recognisably formed, and the
 * address the backend claims must be stable. A backend that returns a
 * different address between calls is misconfigured, not merely surprising.
 */
function assertSignature(value) {
  const signature = String(value ?? "");
  if (!/^0x[0-9a-fA-F]{130}$/.test(signature) && !/^0x[0-9a-fA-F]+$/.test(signature)) {
    throw new Error("Signing backend returned a malformed signature");
  }
  return signature;
}

/**
 * Signing delegated to a callback: the seam for KMS, HSM, a managed key
 * provider, a per-tenant signer service, or a hardware wallet.
 *
 * This is the recommended shape for hosted execution. A hosted deployment
 * resolves a *different* `RemoteSigningIdentity` per user or per Safe, so one
 * global key is never shared across tenants.
 */
class RemoteSigningIdentity extends SigningIdentity {
  #address;
  #sign;
  #description;

  constructor(options) {
    super();
    if (typeof options?.sign !== "function") {
      throw new TypeError("A remote signing identity requires a sign(payload) function");
    }
    this.#address = options.address ? getAddress(options.address) : null;
    this.#sign = options.sign;
    this.#description = options.description || "remote";
    // `resolveAddress` lets a backend that only learns its address by asking
    // (a fresh KMS key, say) stay lazy.
    this.resolveAddress = options.resolveAddress || null;
    Object.freeze(this);
  }

  get description() {
    return this.#description;
  }

  async address() {
    if (this.#address) return this.#address;
    if (!this.resolveAddress) throw new Error("Remote signing identity has no address and no resolver");
    return getAddress(await this.resolveAddress());
  }

  async signTypedData(domain, types, message) {
    return assertSignature(await this.#sign({ domain, types, message }));
  }
}

/**
 * An encrypted local keystore, unlocked through a passphrase provider.
 *
 * The preferred BYOH backend. The key never exists on disk in plaintext, the
 * passphrase is fetched per unlock rather than held, and the decrypted wallet
 * is not retained on the instance -- so a heap dump of an idle process has no
 * key in it.
 *
 * `decrypt` is injected (`ethers.Wallet.fromEncryptedJson` at the call site) so
 * core keeps no opinion about the keystore format and stays testable without
 * running a KDF.
 */
class KeystoreSigningIdentity extends SigningIdentity {
  #keystore;
  #passphrase;
  #decrypt;
  #address;

  constructor(options) {
    super();
    if (!options?.keystore) throw new TypeError("A keystore document is required");
    if (typeof options.passphrase !== "function") {
      throw new TypeError("A keystore identity requires a passphrase() provider, not a stored passphrase");
    }
    if (typeof options.decrypt !== "function") throw new TypeError("A keystore identity requires decrypt()");
    this.#keystore = options.keystore;
    this.#passphrase = options.passphrase;
    this.#decrypt = options.decrypt;
    this.#address = options.address ? getAddress(options.address) : null;
    Object.freeze(this);
  }

  get description() {
    return "local-keystore";
  }

  async #unlock() {
    const wallet = await this.#decrypt(this.#keystore, await this.#passphrase());
    if (!wallet?.address) throw new Error("Keystore did not yield a usable signer");
    if (this.#address && getAddress(wallet.address) !== this.#address) {
      throw new Error("Keystore address does not match the bound identity address");
    }
    return wallet;
  }

  async address() {
    if (this.#address) return this.#address;
    const wallet = await this.#unlock();
    return getAddress(wallet.address);
  }

  async signTypedData(domain, types, message) {
    const wallet = await this.#unlock();
    return assertSignature(await wallet.signTypedData(domain, types, message));
  }
}

/**
 * A secret fetched from an external secret store on each use -- an OS keychain
 * (`security find-generic-password`, `secret-tool lookup`), a system secret
 * service, or a cloud secret manager.
 *
 * `fetchSecret` is injected rather than shelled out to from core, so the
 * platform-specific command lives in the runtime that knows its platform and
 * core does not spawn processes.
 */
class SecretStoreSigningIdentity extends SigningIdentity {
  #fetchSecret;
  #toSigner;
  #address;
  #description;

  constructor(options) {
    super();
    if (typeof options?.fetchSecret !== "function") {
      throw new TypeError("A secret-store identity requires fetchSecret()");
    }
    if (typeof options.toSigner !== "function") {
      throw new TypeError("A secret-store identity requires toSigner(secret)");
    }
    this.#fetchSecret = options.fetchSecret;
    this.#toSigner = options.toSigner;
    this.#address = options.address ? getAddress(options.address) : null;
    this.#description = options.description || "secret-store";
    Object.freeze(this);
  }

  get description() {
    return this.#description;
  }

  async #signer() {
    const signer = await this.#toSigner(await this.#fetchSecret());
    if (!signer?.address) throw new Error("Secret store did not yield a usable signer");
    if (this.#address && getAddress(signer.address) !== this.#address) {
      throw new Error("Secret store address does not match the bound identity address");
    }
    return signer;
  }

  async address() {
    if (this.#address) return this.#address;
    return getAddress((await this.#signer()).address);
  }

  async signTypedData(domain, types, message) {
    return assertSignature(await (await this.#signer()).signTypedData(domain, types, message));
  }
}

/**
 * A development-only backend reading a key from an environment variable.
 *
 * Not a production recommendation, and it says so: construction requires an
 * explicit `acknowledgeDevelopmentOnly` flag, so this cannot be reached by
 * configuration drift or by an operator who never read the docs. The long-term
 * design is a keychain, a system secret store, an encrypted keystore, or a
 * hardware- or KMS-backed key -- all of which are the classes above.
 */
class EnvironmentSigningIdentity extends SigningIdentity {
  #variable;
  #env;
  #toSigner;

  constructor(options) {
    super();
    if (options?.acknowledgeDevelopmentOnly !== true) {
      throw new Error(
        "A plaintext environment-variable key is a development-only backend. " +
          "Pass acknowledgeDevelopmentOnly: true to use it, or use a keystore, " +
          "secret store, or remote signing identity in production.",
      );
    }
    if (!options.variable) throw new TypeError("An environment variable name is required");
    if (typeof options.toSigner !== "function") throw new TypeError("toSigner(secret) is required");
    this.#variable = options.variable;
    this.#env = options.env || process.env;
    this.#toSigner = options.toSigner;
    Object.freeze(this);
  }

  get description() {
    return `environment:${this.#variable} (development only)`;
  }

  async #signer() {
    const secret = this.#env[this.#variable];
    if (!secret) throw new Error(`${this.#variable} is not set`);
    const signer = await this.#toSigner(secret);
    if (!signer?.address) throw new Error(`${this.#variable} did not yield a usable signer`);
    return signer;
  }

  async address() {
    return getAddress((await this.#signer()).address);
  }

  async signTypedData(domain, types, message) {
    return assertSignature(await (await this.#signer()).signTypedData(domain, types, message));
  }
}

module.exports = {
  EnvironmentSigningIdentity,
  KeystoreSigningIdentity,
  RemoteSigningIdentity,
  SecretStoreSigningIdentity,
  SigningIdentity,
  assertSignature,
  assertSigningIdentity,
};
