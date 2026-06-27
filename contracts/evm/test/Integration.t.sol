// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { Origin, MessagingParams, MessagingFee, ILayerZeroEndpoint } from "../src/interfaces/ILayerZero.sol";
import { MockERC20 } from "./PerihelionEscrow.t.sol";

/// @dev A cross-chain relay that stands in for both the LayerZero transport and
///      the Stellar settlement counterparty. The escrow dispatches its outbound
///      `FillInstruction` here (as it would to the real endpoint); the test then
///      asks the relay to play Stellar's side by delivering a real wire-format
///      `FillConfirmed`/`CancelIntent` back through `lzReceive` — exactly the
///      bytes the Soroban contract emits (see contracts/shared/wire-vectors).
///
///      This makes the round trip a true integration: the escrow's send and
///      receive legs, peer/nonce authentication, and the terminal-state guards
///      are all exercised against a counterparty that speaks the pinned protocol.
contract StellarRelay is ILayerZeroEndpoint {
    bytes1 private constant VERSION = 0x01;
    bytes1 private constant T_FILL_INSTRUCTION = 0x01;
    bytes1 private constant T_FILL_CONFIRMED = 0x02;
    bytes1 private constant T_CANCEL_INTENT = 0x03;

    PerihelionEscrow public escrow;
    bytes32 public peer;
    uint32 public eid;

    uint64 public inboundNonce;
    uint256 public fillInstructionCount;
    bytes32 public lastFillIntentHash;

    function init(PerihelionEscrow escrow_, bytes32 peer_, uint32 eid_) external {
        escrow = escrow_;
        peer = peer_;
        eid = eid_;
    }

    /// @inheritdoc ILayerZeroEndpoint
    function quote(MessagingParams calldata, address)
        external
        pure
        returns (MessagingFee memory)
    {
        return MessagingFee({ nativeFee: 0, lzTokenFee: 0 });
    }

    /// @inheritdoc ILayerZeroEndpoint
    /// @dev Captures the escrow's outbound FillInstruction (the source->Stellar leg).
    function send(MessagingParams calldata params, address) external payable returns (bytes32) {
        bytes calldata m = params.message;
        require(m.length >= 34, "relay: short message");
        require(m[0] == VERSION && m[1] == T_FILL_INSTRUCTION, "relay: not FillInstruction");
        // intent_hash is the first abi-encoded field, immediately after the header.
        bytes32 h;
        assembly {
            h := calldataload(add(m.offset, 2))
        }
        lastFillIntentHash = h;
        fillInstructionCount++;
        return bytes32(uint256(0xA11CE));
    }

    /// @dev Stellar settled: deliver a FillConfirmed authorizing the solver payout.
    function deliverFillConfirmed(
        bytes32 intentHash,
        address solverEvm,
        uint128 amount,
        uint64 ledger
    ) external {
        bytes memory message = abi.encodePacked(
            VERSION,
            T_FILL_CONFIRMED,
            intentHash,
            bytes32(uint256(uint160(solverEvm))),
            amount,
            ledger
        );
        _deliver(message);
    }

    /// @dev Stellar cancelled: deliver a CancelIntent triggering the user refund.
    function deliverCancel(bytes32 intentHash, uint8 reason) external {
        bytes memory message = abi.encodePacked(VERSION, T_CANCEL_INTENT, intentHash, reason);
        _deliver(message);
    }

    function _deliver(bytes memory message) internal {
        inboundNonce++;
        escrow.lzReceive(
            Origin({ srcEid: eid, sender: peer, nonce: inboundNonce }),
            bytes32(uint256(0xBEEF)),
            message,
            address(0),
            ""
        );
    }
}

contract IntegrationTest is Test {
    PerihelionEscrow internal escrow;
    StellarRelay internal relay;
    MockERC20 internal token;

    uint32 internal constant STELLAR_EID = 30_316;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0x57E11A));

    uint256 internal userPk = 0xA11CE;
    address internal user;
    address internal solver = address(0x5012E5);

    function setUp() public {
        relay = new StellarRelay();
        escrow = new PerihelionEscrow(address(relay), STELLAR_EID);
        escrow.setPeer(STELLAR_PEER);
        relay.init(escrow, STELLAR_PEER, STELLAR_EID);

        token = new MockERC20();
        user = vm.addr(userPk);
        token.mint(user, 1_000_000);
        vm.prank(user);
        token.approve(address(escrow), type(uint256).max);
        vm.deal(solver, 10 ether);
    }

    function _intent(uint256 nonce) internal view returns (PerihelionEscrow.Intent memory) {
        return PerihelionEscrow.Intent({
            user: user,
            destination: "GUSERSTELLAR",
            sourceChainId: block.chainid,
            sourceAsset: address(token),
            sourceAmount: 100_000,
            destAsset: "USDC:GA5Z",
            minDestAmount: 990_000,
            deadline: block.timestamp + 600,
            nonce: nonce,
            preferredSolver: address(0)
        });
    }

    function _lock(PerihelionEscrow.Intent memory intent) internal returns (bytes32 h) {
        bytes32 digest = escrow.hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        h = digest;
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, abi.encodePacked(r, s, v));
    }

    // --- Full round trips ----------------------------------------------------

    function test_RoundTrip_Settle() public {
        PerihelionEscrow.Intent memory intent = _intent(1);
        bytes32 h = _lock(intent);

        // The source -> Stellar leg actually dispatched, carrying our intent hash.
        assertEq(relay.fillInstructionCount(), 1);
        assertEq(relay.lastFillIntentHash(), h);
        assertEq(token.balanceOf(address(escrow)), 100_000);

        // Stellar settles and confirms back; the escrow pays the solver.
        relay.deliverFillConfirmed(h, solver, 100_000, 42);

        assertEq(token.balanceOf(solver), 100_000);
        assertEq(token.balanceOf(address(escrow)), 0);
        (,,,,, bool released, bool refunded) = escrow.locks(h);
        assertTrue(released);
        assertFalse(refunded);
    }

    /// The escrow pays whoever Stellar confirms, which need not be the address
    /// that locked — the solver can nominate a distinct EVM payout address.
    function test_RoundTrip_PayoutAddressIndependentOfLocker() public {
        address payout = address(0xDECAF0);
        bytes32 h = _lock(_intent(1));

        relay.deliverFillConfirmed(h, payout, 100_000, 42);

        assertEq(token.balanceOf(payout), 100_000);
        assertEq(token.balanceOf(solver), 0);
    }

    function test_RoundTrip_CancelFromStellar() public {
        bytes32 h = _lock(_intent(1));

        relay.deliverCancel(h, 0); // CANCEL_REASON_EXPIRED

        assertEq(token.balanceOf(user), 1_000_000);
        (,,,,,, bool refunded) = escrow.locks(h);
        assertTrue(refunded);
    }

    /// Local timeout refunds the user; a FillConfirmed that lands afterwards
    /// must lose the race (single terminal transition across the bridge).
    function test_RoundTrip_LocalTimeoutThenLateConfirmRejected() public {
        PerihelionEscrow.Intent memory intent = _intent(1);
        bytes32 h = _lock(intent);

        vm.warp(intent.deadline + escrow.confirmationGrace());
        escrow.cancelExpired(h);
        assertEq(token.balanceOf(user), 1_000_000);

        // The relay's late settlement reverts inside lzReceive.
        vm.expectRevert(PerihelionEscrow.AlreadyFinalized.selector);
        relay.deliverFillConfirmed(h, solver, 100_000, 99);
    }

    /// Two concurrent intents resolve independently, and value is conserved.
    function test_TwoIntents_SettleOneCancelOther() public {
        bytes32 h1 = _lock(_intent(1));
        bytes32 h2 = _lock(_intent(2));
        assertEq(token.balanceOf(address(escrow)), 200_000);

        relay.deliverFillConfirmed(h1, solver, 100_000, 1);
        relay.deliverCancel(h2, 0);

        assertEq(token.balanceOf(solver), 100_000); // settled leg paid out
        assertEq(token.balanceOf(user), 900_000); // refunded leg returned (started 1_000_000, locked 200_000, got 100_000 back)
        assertEq(token.balanceOf(address(escrow)), 0); // fully drained
    }
}
