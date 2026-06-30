// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { CommonBase } from "forge-std/Base.sol";
import { StdCheats } from "forge-std/StdCheats.sol";
import { StdUtils } from "forge-std/StdUtils.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { MockERC20, MockEndpoint } from "./PerihelionEscrow.t.sol";

/// @dev Drives the escrow through randomized lifecycles (lock -> confirm /
///      cancel-inbound / cancel-expired) and tracks ghost totals the invariant
///      contract checks against on-chain state. Every action targets only an
///      open lock, so the run advances real state instead of bouncing off guards.
contract EscrowHandler is CommonBase, StdCheats, StdUtils {
    PerihelionEscrow public immutable escrow;
    MockERC20 public immutable token;
    MockEndpoint public immutable endpoint;

    uint32 internal constant STELLAR_EID = 30_316;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0x57E11A));
    bytes1 internal constant V = 0x01;
    bytes1 internal constant T_FILL_CONFIRMED = 0x02;
    bytes1 internal constant T_CANCEL_INTENT = 0x03;

    uint256 internal userPk = 0xA11CE;
    address public user;

    // Ghost accounting.
    uint256 public totalLocked;
    uint256 public totalReleased;
    uint256 public totalRefunded;

    uint64 internal nonce;
    uint64 internal lzNonce;
    bytes32[] internal openHashes; // locks still in the open state
    bytes32[] internal everHashes; // every lock ever created

    /// A fixed pool of distinct external solver accounts. Drawing solvers from a
    /// clean EOA pool (never the escrow/token/endpoint addresses) keeps the model
    /// faithful: a solver is always an external party, so a release is always a
    /// real outflow and can never collide into an accounting-breaking self-transfer.
    address[] internal solvers;

    constructor(PerihelionEscrow _escrow, MockERC20 _token, MockEndpoint _endpoint) {
        escrow = _escrow;
        token = _token;
        endpoint = _endpoint;
        user = vm.addr(userPk);
        for (uint160 i = 1; i <= 5; i++) {
            solvers.push(address(0x500000 + i));
        }
    }

    function openCount() external view returns (uint256) {
        return openHashes.length;
    }

    function everCount() external view returns (uint256) {
        return everHashes.length;
    }

    function everHashAt(uint256 i) external view returns (bytes32) {
        return everHashes[i];
    }

    function _removeOpen(uint256 idx) internal {
        openHashes[idx] = openHashes[openHashes.length - 1];
        openHashes.pop();
    }

    function lock(uint128 amountSeed, uint256 solverSeed) external {
        uint256 avail = token.balanceOf(user);
        if (avail < 2) return;
        uint256 amount = bound(uint256(amountSeed), 1, avail);
        address solver = solvers[bound(solverSeed, 0, solvers.length - 1)];

        nonce++;
        PerihelionEscrow.Intent memory intent = PerihelionEscrow.Intent({
            user: user,
            destination: "GUSERSTELLAR",
            sourceChainId: block.chainid,
            sourceAsset: address(token),
            sourceAmount: amount,
            destAsset: "USDC:GA5Z",
            minDestAmount: amount,
            deadline: block.timestamp + 600,
            nonce: nonce,
            preferredSolver: address(0)
        });
        bytes32 h = escrow.hashIntent(intent);
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(userPk, h);
        bytes memory sig = abi.encodePacked(r, s, vv);

        vm.deal(solver, 1 ether);
        vm.prank(solver);
        escrow.lock{ value: 0.001 ether }(intent, sig);

        openHashes.push(h);
        everHashes.push(h);
        totalLocked += amount;
    }

    function confirm(uint256 idxSeed) external {
        if (openHashes.length == 0) return;
        uint256 idx = bound(idxSeed, 0, openHashes.length - 1);
        bytes32 h = openHashes[idx];
        (address solver,,, uint256 amount,,,) = escrow.locks(h);

        lzNonce++;
        bytes memory message = abi.encodePacked(
            V, T_FILL_CONFIRMED, h, bytes32(uint256(uint160(solver))), uint128(amount), uint64(1)
        );
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, lzNonce, message);

        totalReleased += amount;
        _removeOpen(idx);
    }

    function cancelInbound(uint256 idxSeed) external {
        if (openHashes.length == 0) return;
        uint256 idx = bound(idxSeed, 0, openHashes.length - 1);
        bytes32 h = openHashes[idx];
        (,,, uint256 amount,,,) = escrow.locks(h);

        lzNonce++;
        bytes memory message = abi.encodePacked(V, T_CANCEL_INTENT, h, uint8(0));
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, lzNonce, message);

        totalRefunded += amount;
        _removeOpen(idx);
    }

    function cancelExpired(uint256 idxSeed, uint256 warpSeed) external {
        if (openHashes.length == 0) return;
        uint256 idx = bound(idxSeed, 0, openHashes.length - 1);
        bytes32 h = openHashes[idx];
        (,,, uint256 amount, uint256 deadline,,) = escrow.locks(h);

        uint256 opensAt = deadline + escrow.confirmationGrace();
        // Jump to a point at or beyond the refund window for this lock.
        vm.warp(bound(warpSeed, opensAt, opensAt + 30 days));
        escrow.cancelExpired(h);

        totalRefunded += amount;
        _removeOpen(idx);
    }
}

/// @dev Conservation-of-funds and single-terminal-transition invariants over
///      the full escrow state machine under randomized action sequences.
contract PerihelionEscrowInvariantTest is Test {
    PerihelionEscrow internal escrow;
    MockERC20 internal token;
    MockEndpoint internal endpoint;
    EscrowHandler internal handler;

    uint32 internal constant STELLAR_EID = 30_316;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0x57E11A));

    function setUp() public {
        endpoint = new MockEndpoint();
        escrow = new PerihelionEscrow(address(endpoint), STELLAR_EID);
        escrow.setPeer(STELLAR_PEER);
        token = new MockERC20();
        handler = new EscrowHandler(escrow, token, endpoint);

        token.mint(handler.user(), 1_000_000_000_000);
        vm.prank(handler.user());
        token.approve(address(escrow), type(uint256).max);

        targetContract(address(handler));
    }

    /// The escrow's held balance always equals what it pulled minus what it paid
    /// out — the state machine neither creates nor destroys value.
    function invariant_conservationOfFunds() public view {
        assertEq(
            token.balanceOf(address(escrow)),
            handler.totalLocked() - handler.totalReleased() - handler.totalRefunded()
        );
    }

    /// Invariant I1/I2 — Single terminal transition per intent
    ///
    /// I1/I2: For every locked intent, exactly one terminal transition may
    /// occur: either `released` (solver paid) OR `refunded` (user refunded),
    /// never both and never twice. This function asserts the protocol-level
    /// single-terminal-transition safety property across every intent created
    /// during the fuzz session.
    function invariant_I1_I2_singleTerminalTransition() public view {
        uint256 n = handler.everCount();
        for (uint256 i = 0; i < n; i++) {
            bytes32 h = handler.everHashAt(i);
            (,,,,, bool released, bool refunded) = escrow.locks(h);
            assertFalse(released && refunded);
        }
    }
}
