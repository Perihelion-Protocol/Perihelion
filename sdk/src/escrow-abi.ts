// SPDX-License-Identifier: MIT

/**
 * PerihelionEscrow ABI — generated from contract source via forge inspect.
 * This ABI is the authoritative interface for the escrow contract used by the SDK.
 */

export const ESCROW_ABI = [
  {
    type: "constructor",
    inputs: [
      { name: "endpoint_", type: "address" },
      { name: "stellarEid_", type: "uint32" },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancelExpired",
    inputs: [{ name: "intentHash", type: "bytes32" }],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "confirmationGrace",
    inputs: [],
    outputs: [{ type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "lock",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "user", type: "address" },
          { name: "destination", type: "string" },
          { name: "sourceChainId", type: "uint256" },
          { name: "sourceAsset", type: "address" },
          { name: "sourceAmount", type: "uint256" },
          { name: "destAsset", type: "string" },
          { name: "minDestAmount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "preferredSolver", type: "address" },
        ],
      },
      { name: "signature", type: "bytes" },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "getLock",
    inputs: [{ name: "intentHash", type: "bytes32" }],
    outputs: [
      {
        type: "tuple",
        components: [
          { name: "solver", type: "address" },
          { name: "user", type: "address" },
          { name: "asset", type: "address" },
          { name: "amount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "released", type: "bool" },
          { name: "refunded", type: "bool" },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "quoteFee",
    inputs: [
      {
        name: "intent",
        type: "tuple",
        components: [
          { name: "user", type: "address" },
          { name: "destination", type: "string" },
          { name: "sourceChainId", type: "uint256" },
          { name: "sourceAsset", type: "address" },
          { name: "sourceAmount", type: "uint256" },
          { name: "destAsset", type: "string" },
          { name: "minDestAmount", type: "uint256" },
          { name: "deadline", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "preferredSolver", type: "address" },
        ],
      },
    ],
    outputs: [{ name: "nativeFee", type: "uint256" }],
    stateMutability: "view",
  },
  {
    type: "event",
    name: "Locked",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "solver", type: "address", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "asset", type: "address", indexed: false },
      { name: "amount", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "Refunded",
    inputs: [
      { name: "intentHash", type: "bytes32", indexed: true },
      { name: "user", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "reason", type: "uint8", indexed: false },
    ],
  },
  {
    type: "error",
    name: "NotLocked",
  },
  {
    type: "error",
    name: "AlreadyFinalized",
  },
  {
    type: "error",
    name: "DeadlineNotPassed",
  },
  {
    type: "error",
    name: "PausedError",
  },
] as const;
