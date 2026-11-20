// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { DeployConfig } from "./lib/DeployConfig.sol";

/// @notice Deploys the Perihelion escrow and applies its full operating configuration
///         (peer, guardian, grace, asset allowlist, per-asset caps, rolling windows)
///         BEFORE nominating the new owner, so the escrow accepts locks as soon as
///         ownership is handed over and no setting needs a multi-day governance cycle.
/// @dev Environment:
///        PERIHELION_ENDPOINT   - LayerZero endpoint address (required)
///        PERIHELION_STELLAR_EID - LayerZero endpoint id of the Stellar settlement (required)
///        PERIHELION_CONFIG     - path to the JSON config (required); see script/lib/DeployConfig.sol
///      Ownership is two-step. The config's `owner` (the timelock) is nominated here and
///      must complete the handover with `AcceptOwnership.s.sol`. The LayerZero delegate is
///      handed over in that same governance batch.
///
///      forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
contract Deploy is Script {
    function run() external returns (PerihelionEscrow escrow) {
        address endpoint = vm.envAddress("PERIHELION_ENDPOINT");
        uint32 stellarEid = uint32(vm.envUint("PERIHELION_STELLAR_EID"));
        DeployConfig.Config memory cfg = DeployConfig.load(vm.envString("PERIHELION_CONFIG"));

        vm.startBroadcast();
        escrow = deploy(endpoint, stellarEid, cfg);
        vm.stopBroadcast();

        console2.log("PerihelionEscrow:", address(escrow));
        console2.log("  pendingOwner:", cfg.owner);
        console2.log("Run VerifyDeployment.s.sol after the timelock accepts ownership.");
    }

    /// @notice Deploy and configure an escrow from already-parsed arguments. `run` wraps
    ///         this in a broadcast. It takes no environment input, so it can be called
    ///         directly (for example from tests, which may run in parallel).
    function deploy(address endpoint, uint32 stellarEid, DeployConfig.Config memory cfg)
        public
        returns (PerihelionEscrow escrow)
    {
        escrow = new PerihelionEscrow(endpoint, stellarEid);
        _apply(escrow, cfg);
        if (cfg.owner != address(0)) {
            escrow.transferOwnership(cfg.owner);
        }
    }

    /// @dev Applies every setting in the config. Ordering is deliberate: the peer is set
    ///      first so the escrow can never be locked against a missing receiver, and the
    ///      per-asset caps are set only after the asset is allowlisted.
    function _apply(PerihelionEscrow escrow, DeployConfig.Config memory cfg) internal {
        escrow.setPeer(cfg.peer);
        escrow.setGuardian(cfg.guardian);
        escrow.setConfirmationGrace(cfg.confirmationGrace);

        for (uint256 i = 0; i < cfg.assets.length; i++) {
            address asset = cfg.assets[i];
            escrow.setAssetAllowed(asset, true);
            escrow.setMaxIntentAmountPerAsset(asset, cfg.assetMaxIntentAmounts[i]);
            if (cfg.assetRollingWindowCaps[i] > 0) {
                escrow.setRollingWindowCapForAsset(
                    asset, cfg.rollingWindowDuration, cfg.assetRollingWindowCaps[i]
                );
            }
        }
    }
}
