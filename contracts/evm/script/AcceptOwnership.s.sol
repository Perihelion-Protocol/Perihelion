// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Script, console2 } from "forge-std/Script.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { PerihelionTimelock } from "../src/PerihelionTimelock.sol";

/// @notice Builds the timelock governance calldata that completes the escrow handover:
///         1. escrow.acceptOwnership()             - the timelock becomes owner
///         2. escrow.setEndpointDelegate(timelock) - the LayerZero delegate moves to the timelock
///
///         Nothing is broadcast. The script prints, for each operation, the
///         `propose(...)` calldata a timelock owner submits, and the id plus
///         `execute(...)` calldata to run after the delay. Submit them through the
///         multisig, e.g. with `cast send <timelock> <calldata> --rpc-url $RPC`.
///
/// @dev Environment:
///        PERIHELION_ESCROW    - deployed escrow address (required)
///        PERIHELION_TIMELOCK  - timelock that is the nominated pending owner (required)
///        PERIHELION_SALT      - bytes32 salt, unique per operation (optional; default is
///                               keccak256("perihelion.handover.v1"))
///
///      forge script script/AcceptOwnership.s.sol --rpc-url $RPC
contract AcceptOwnership is Script {
    struct Op {
        address target;
        bytes data;
    }

    function run() external view returns (Op[] memory ops) {
        PerihelionEscrow escrow = PerihelionEscrow(payable(vm.envAddress("PERIHELION_ESCROW")));
        PerihelionTimelock timelock =
            PerihelionTimelock(payable(vm.envAddress("PERIHELION_TIMELOCK")));
        bytes32 salt = vm.envOr("PERIHELION_SALT", keccak256("perihelion.handover.v1"));
        ops = build(escrow, timelock, salt);
        _log(timelock, ops, salt);
    }

    /// @notice Build the ordered handover operations. Takes no environment input.
    function build(PerihelionEscrow escrow, PerihelionTimelock timelock, bytes32 salt)
        public
        view
        returns (Op[] memory ops)
    {
        require(
            escrow.pendingOwner() == address(timelock),
            "AcceptOwnership: timelock is not the pending owner"
        );

        ops = new Op[](2);
        ops[0] = Op(address(escrow), abi.encodeCall(PerihelionEscrow.acceptOwnership, ()));
        ops[1] = Op(
            address(escrow),
            abi.encodeCall(PerihelionEscrow.setEndpointDelegate, (address(timelock)))
        );
    }

    function _log(PerihelionTimelock timelock, Op[] memory ops, bytes32 salt) internal view {
        for (uint256 i = 0; i < ops.length; i++) {
            bytes32 id = timelock.hashOperation(ops[i].target, 0, ops[i].data, salt);
            console2.log("operation", i);
            console2.log("  target:", ops[i].target);
            console2.log("  id:");
            console2.logBytes32(id);
            console2.log("  propose calldata:");
            console2.logBytes(
                abi.encodeCall(PerihelionTimelock.propose, (ops[i].target, 0, ops[i].data, salt))
            );
            console2.log("  execute calldata:");
            console2.logBytes(
                abi.encodeCall(PerihelionTimelock.execute, (ops[i].target, 0, ops[i].data, salt))
            );
        }
    }
}
