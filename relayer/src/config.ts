/** Relayer runtime configuration, loaded from environment variables. */

export interface RelayerConfig {
  /** RPC endpoint for the EVM source chain. */
  readonly evmRpcUrl: string;
  /** Horizon / RPC endpoint for Stellar. */
  readonly stellarRpcUrl: string;
  /** Address of the EVM escrow contract emitting bridge messages. */
  readonly escrowAddress: string;
  /** Address of the Soroban settlement (OApp) contract. */
  readonly settlementContractId: string;
  /** Block confirmations to wait before relaying a source message. */
  readonly confirmations: number;
  /** Poll interval for new messages, milliseconds. */
  readonly pollIntervalMs: number;
}

/** 0x-prefixed 20-byte EVM address. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
/** Soroban contract IDs start with 'C' and are 56 base-32 characters. */
const SOROBAN_CONTRACT_RE = /^C[A-Z2-7]{55}$/;

/**
 * Build config from `process.env`, applying sensible defaults.
 * Throws a descriptive error and exits if required vars are missing or
 * any value is malformed/NaN.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): RelayerConfig {
  const errors: string[] = [];

  // --- Required: escrow address ---
  const escrowAddress = env.PERIHELION_ESCROW_ADDRESS ?? "";
  if (!escrowAddress) {
    errors.push("PERIHELION_ESCROW_ADDRESS is required");
  } else if (!EVM_ADDRESS_RE.test(escrowAddress)) {
    errors.push(
      `PERIHELION_ESCROW_ADDRESS must be a 0x-prefixed 20-byte EVM address, got: "${escrowAddress}"`,
    );
  }

  // --- Required: settlement contract id ---
  const settlementContractId = env.PERIHELION_SETTLEMENT_CONTRACT ?? "";
  if (!settlementContractId) {
    errors.push("PERIHELION_SETTLEMENT_CONTRACT is required");
  } else if (!SOROBAN_CONTRACT_RE.test(settlementContractId)) {
    errors.push(
      `PERIHELION_SETTLEMENT_CONTRACT must be a valid Soroban contract id (C…, 56 chars), got: "${settlementContractId}"`,
    );
  }

  // --- Optional with sane defaults but must not be NaN/negative if set ---
  const confirmations = Number(env.PERIHELION_CONFIRMATIONS ?? 6);
  if (Number.isNaN(confirmations) || confirmations < 0) {
    errors.push(
      `PERIHELION_CONFIRMATIONS must be a non-negative integer, got: "${env.PERIHELION_CONFIRMATIONS}"`,
    );
  }

  const pollIntervalMs = Number(env.PERIHELION_POLL_INTERVAL_MS ?? 5_000);
  if (Number.isNaN(pollIntervalMs) || pollIntervalMs <= 0) {
    errors.push(
      `PERIHELION_POLL_INTERVAL_MS must be a positive integer, got: "${env.PERIHELION_POLL_INTERVAL_MS}"`,
    );
  }

  if (errors.length > 0) {
    throw new Error(
      `Relayer configuration error — fix the following before starting:\n  • ${errors.join("\n  • ")}`,
    );
  }

  return {
    evmRpcUrl: env.PERIHELION_EVM_RPC_URL ?? "http://localhost:8545",
    stellarRpcUrl:
      env.PERIHELION_STELLAR_RPC_URL ?? "https://soroban-testnet.stellar.org",
    escrowAddress,
    settlementContractId,
    confirmations,
    pollIntervalMs,
  };
}
