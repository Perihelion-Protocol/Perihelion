// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { DeployConfig } from "./lib/DeployConfig.sol";

/// @notice Asserts that a deployed escrow matches its configuration file and prints the
///         effective configuration. Reverts on the first missing or mismatched setting, so
///         it can gate a deployment pipeline.
/// @dev Environment:
///        PERIHELION_ESCROW - deployed escrow address (required)
///        PERIHELION_CONFIG - path to the same JSON config used by Deploy.s.sol (required)
///        PERIHELION_TIMELOCK - expected final owner (optional). If set, the escrow must be
///                              owned by it. Otherwise the pending owner is checked when present.
///
///      forge script script/VerifyDeployment.s.sol --rpc-url $RPC
contract VerifyDeployment is Script {
    function run() external view {
        PerihelionEscrow escrow = PerihelionEscrow(payable(vm.envAddress("PERIHELION_ESCROW")));
        DeployConfig.Config memory cfg = DeployConfig.load(vm.envString("PERIHELION_CONFIG"));
        address expectedOwner = vm.envOr("PERIHELION_TIMELOCK", address(0));
        verify(escrow, cfg, expectedOwner);
    }

    /// @notice Assert the escrow against a parsed config. Takes no environment input so
    ///         it can be called directly. `expectedOwner` may be zero.
    function verify(PerihelionEscrow escrow, DeployConfig.Config memory cfg, address expectedOwner)
        public
        view
    {
        _verifyCore(escrow, cfg);
        _verifyAssets(escrow, cfg);
        _verifyOwner(escrow, cfg, expectedOwner);
        _printEffective(escrow);
    }

    function _verifyCore(PerihelionEscrow escrow, DeployConfig.Config memory cfg) internal view {
        require(
            escrow.stellarPeer() == cfg.peer, "VerifyDeployment: stellarPeer does not match config"
        );
        require(escrow.stellarPeer() != bytes32(0), "VerifyDeployment: stellarPeer is unset");
        require(
            escrow.guardian() == cfg.guardian, "VerifyDeployment: guardian does not match config"
        );
        require(escrow.guardian() != address(0), "VerifyDeployment: guardian is unset");
        require(
            escrow.confirmationGrace() == cfg.confirmationGrace,
            "VerifyDeployment: confirmationGrace does not match config"
        );
        require(!escrow.paused(), "VerifyDeployment: escrow is paused");
    }

    function _verifyAssets(PerihelionEscrow escrow, DeployConfig.Config memory cfg) internal view {
        require(cfg.assets.length > 0, "VerifyDeployment: config lists no allowlisted assets");
        for (uint256 i = 0; i < cfg.assets.length; i++) {
            address asset = cfg.assets[i];
            require(escrow.assetAllowed(asset), "VerifyDeployment: asset is not allowlisted");
            require(
                escrow.maxIntentAmountPerAsset(asset) == cfg.assetMaxIntentAmounts[i],
                "VerifyDeployment: per-asset max does not match config"
            );
            require(
                escrow.maxIntentAmountPerAsset(asset) > 0,
                "VerifyDeployment: per-asset max is unset"
            );
            require(
                escrow.rollingWindowCapPerAsset(asset) == cfg.assetRollingWindowCaps[i],
                "VerifyDeployment: rolling-window cap does not match config"
            );
        }
        if (cfg.assetRollingWindowCaps.length > 0) {
            bool anyCap;
            for (uint256 i = 0; i < cfg.assetRollingWindowCaps.length; i++) {
                if (cfg.assetRollingWindowCaps[i] > 0) anyCap = true;
            }
            if (anyCap) {
                require(
                    escrow.rollingWindowDuration() == cfg.rollingWindowDuration,
                    "VerifyDeployment: rolling-window duration does not match config"
                );
            }
        }
    }

    function _verifyOwner(PerihelionEscrow escrow, DeployConfig.Config memory cfg, address expected)
        internal
        view
    {
        if (expected != address(0)) {
            require(escrow.owner() == expected, "VerifyDeployment: owner is not the timelock");
        } else if (cfg.owner != address(0)) {
            require(
                escrow.owner() == cfg.owner || escrow.pendingOwner() == cfg.owner,
                "VerifyDeployment: neither owner nor pending owner matches config"
            );
        }
    }

    function _printEffective(PerihelionEscrow escrow) internal view {
        console2.log("Effective configuration for", address(escrow));
        console2.log("  owner:", escrow.owner());
        console2.log("  pendingOwner:", escrow.pendingOwner());
        console2.log("  guardian:", escrow.guardian());
        console2.log("  confirmationGrace (s):", escrow.confirmationGrace());
        console2.log("  rollingWindowDuration (s):", escrow.rollingWindowDuration());
        console2.log("  stellarEid:", escrow.stellarEid());
        console2.logBytes32(escrow.stellarPeer());
        console2.log("Verification passed.");
    }
}
