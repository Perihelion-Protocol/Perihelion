// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev forge-std cheatcode interface, addressed directly so this library can be
///      imported by both scripts and tests without pulling in the Test base.
interface VmDeployConfig {
    function readFile(string calldata path) external view returns (string memory);
    function parseJsonAddress(string calldata json, string calldata key)
        external
        pure
        returns (address);
    function parseJsonBytes32(string calldata json, string calldata key)
        external
        pure
        returns (bytes32);
    function parseJsonUint(string calldata json, string calldata key)
        external
        pure
        returns (uint256);
    function parseJsonAddressArray(string calldata json, string calldata key)
        external
        pure
        returns (address[] memory);
    function parseJsonUintArray(string calldata json, string calldata key)
        external
        pure
        returns (uint256[] memory);
    function keyExistsJson(string calldata json, string calldata key)
        external
        view
        returns (bool);
}

/// @title DeployConfig
/// @notice Single source of truth for the deployment configuration JSON. Both
///         `Deploy.s.sol` (applies it) and `VerifyDeployment.s.sol` (asserts it) read
///         through this library, so the two cannot disagree about what is required.
///
/// Schema (see `script/config/example.json`):
///   peer                   (required) bytes32 LayerZero address of the Stellar settlement OApp
///   guardian               (required) address allowed to trigger emergency pause
///   confirmationGrace      (required) seconds; must lie within the escrow's grace bounds
///   rollingWindowDuration  (optional, default 0) window length in seconds for per-asset caps
///   assets                 (optional) allowlisted ERC-20 addresses
///   assetMaxIntentAmounts  (required iff assets) per-asset max lock, parallel to `assets`
///   assetRollingWindowCaps (required iff assets) per-asset rolling cap, parallel to `assets`;
///                          zero disables the rolling cap for that asset
///   owner                  (optional) address nominated as pending owner, normally the timelock
///
/// Amounts are JSON strings so uint256 values survive without float precision loss.
library DeployConfig {
    VmDeployConfig internal constant VM =
        VmDeployConfig(address(uint160(uint256(keccak256("hevm cheat code")))));

    struct Config {
        bytes32 peer;
        address guardian;
        uint256 confirmationGrace;
        uint256 rollingWindowDuration;
        address[] assets;
        uint256[] assetMaxIntentAmounts;
        uint256[] assetRollingWindowCaps;
        address owner;
    }

    /// @notice Load and validate a configuration file. Reverts with a descriptive
    ///         message on any missing or inconsistent field.
    function load(string memory path) internal view returns (Config memory c) {
        string memory json = VM.readFile(path);

        require(VM.keyExistsJson(json, ".peer"), "DeployConfig: missing peer");
        require(VM.keyExistsJson(json, ".guardian"), "DeployConfig: missing guardian");
        require(
            VM.keyExistsJson(json, ".confirmationGrace"), "DeployConfig: missing confirmationGrace"
        );

        c.peer = VM.parseJsonBytes32(json, ".peer");
        c.guardian = VM.parseJsonAddress(json, ".guardian");
        c.confirmationGrace = VM.parseJsonUint(json, ".confirmationGrace");
        c.rollingWindowDuration = VM.keyExistsJson(json, ".rollingWindowDuration")
            ? VM.parseJsonUint(json, ".rollingWindowDuration")
            : 0;
        c.owner =
            VM.keyExistsJson(json, ".owner") ? VM.parseJsonAddress(json, ".owner") : address(0);

        if (VM.keyExistsJson(json, ".assets")) {
            c.assets = VM.parseJsonAddressArray(json, ".assets");
            require(
                VM.keyExistsJson(json, ".assetMaxIntentAmounts"),
                "DeployConfig: missing assetMaxIntentAmounts"
            );
            require(
                VM.keyExistsJson(json, ".assetRollingWindowCaps"),
                "DeployConfig: missing assetRollingWindowCaps"
            );
            c.assetMaxIntentAmounts = VM.parseJsonUintArray(json, ".assetMaxIntentAmounts");
            c.assetRollingWindowCaps = VM.parseJsonUintArray(json, ".assetRollingWindowCaps");
            require(
                c.assetMaxIntentAmounts.length == c.assets.length
                    && c.assetRollingWindowCaps.length == c.assets.length,
                "DeployConfig: asset arrays must have equal length"
            );
        }
    }
}
