// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script } from "forge-std/Script.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";

/// @notice Deploys the Perihelion escrow.
/// @dev Configure before running:
///        PERIHELION_ENDPOINT   - LayerZero endpoint address
///        PERIHELION_STELLAR_EID - LayerZero endpoint id of the Stellar settlement
///        PERIHELION_STELLAR_PEER (optional) - 32-byte Stellar settlement peer
///      forge script script/Deploy.s.sol --rpc-url $RPC --broadcast
contract Deploy is Script {
    function run() external returns (PerihelionEscrow escrow) {
        address endpoint = vm.envAddress("PERIHELION_ENDPOINT");
        uint32 stellarEid = uint32(vm.envUint("PERIHELION_STELLAR_EID"));
        bytes32 stellarPeer = vm.envOr("PERIHELION_STELLAR_PEER", bytes32(0));

        vm.startBroadcast();
        escrow = new PerihelionEscrow(endpoint, stellarEid);
        if (stellarPeer != bytes32(0)) {
            escrow.setPeer(stellarPeer);
        }
        vm.stopBroadcast();
    }
}
