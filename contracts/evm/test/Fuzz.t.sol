// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { MockERC20, MockEndpoint } from "./PerihelionEscrow.t.sol";
import { Origin } from "../src/interfaces/ILayerZero.sol";

/// @dev Stateless property tests for the escrow's value-handling, guards, and
///      nonce/replay protection.
contract PerihelionEscrowFuzzTest is Test {
    PerihelionEscrow internal escrow;
    MockERC20 internal token;
    MockEndpoint internal endpoint;

    uint32 internal constant STELLAR_EID = 30_316;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0x57E11A));

    uint256 internal userPk = 0xA11CE;
    address internal user;
    address internal solver = address(0x5012E5);

    function setUp() public {
        endpoint = new MockEndpoint();
        escrow = new PerihelionEscrow(address(endpoint), STELLAR_EID);
        escrow.setPeer(STELLAR_PEER);
        token = new MockERC20();
        user = vm.addr(userPk);

        token.mint(user, type(uint128).max);
        vm.prank(user);
        token.approve(address(escrow), type(uint256).max);
        escrow.setAssetAllowed(address(token), true);
        escrow.setMaxIntentAmountPerAsset(address(token), type(uint256).max);
        vm.deal(solver, 100 ether);
    }

    function _intent(uint256 amount, uint256 deadline, uint256 nonce)
        internal
        view
        returns (PerihelionEscrow.Intent memory)
    {
        return PerihelionEscrow.Intent({
            user: user,
            destination: "GUSERSTELLAR",
            sourceChainId: block.chainid,
            sourceAsset: address(token),
            sourceAmount: amount,
            destAsset: "USDC:GA5Z",
            // The contract rejects minDestAmount above 2^127-1 (AmountTooLarge).
            minDestAmount: amount > (type(uint128).max >> 1) ? (type(uint128).max >> 1) : amount,
            deadline: deadline,
            nonce: nonce,
            preferredSolver: address(0)
        });
    }

    function _intent(uint256 amount, uint256 deadline)
        internal
        view
        returns (PerihelionEscrow.Intent memory)
    {
        return _intent(amount, deadline, 1);
    }

    function _sign(uint256 pk, PerihelionEscrow.Intent memory intent)
        internal
        view
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.hashIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    /// The escrow records and holds exactly the amount pulled, for any amount.
    function testFuzz_LockHoldsExactAmount(uint128 amount) public {
        amount = uint128(bound(amount, 1, type(uint128).max));
        PerihelionEscrow.Intent memory intent = _intent(amount, block.timestamp + 600);
        bytes memory sig = _sign(userPk, intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        assertEq(token.balanceOf(address(escrow)), amount);
        (,,, uint256 held,,,,) = escrow.locks(h);
        assertEq(held, amount);
    }

    /// A signature from any key other than the user's is always rejected.
    function testFuzz_WrongSignerRejected(uint256 wrongPk) public {
        wrongPk = bound(wrongPk, 1, type(uint128).max);
        vm.assume(wrongPk != userPk);

        PerihelionEscrow.Intent memory intent = _intent(100_000, block.timestamp + 600);
        bytes memory sig = _sign(wrongPk, intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.InvalidSignature.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    /// Tampering with the amount after signing always invalidates the signature.
    function testFuzz_TamperedAmountRejected(uint128 signedAmount, uint128 sentAmount) public {
        signedAmount = uint128(bound(signedAmount, 1, type(uint128).max - 1));
        sentAmount = uint128(bound(sentAmount, 1, type(uint128).max));
        vm.assume(signedAmount != sentAmount);

        PerihelionEscrow.Intent memory intent = _intent(signedAmount, block.timestamp + 600);
        bytes memory sig = _sign(userPk, intent);
        intent.sourceAmount = sentAmount; // tamper post-signing

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.InvalidSignature.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    /// cancelExpired opens exactly at `deadline + confirmationGrace`, never before.
    function testFuzz_CancelExpiredBoundary(uint256 warpTo) public {
        uint256 deadline = block.timestamp + 600;
        PerihelionEscrow.Intent memory intent = _intent(100_000, deadline);
        bytes memory sig = _sign(userPk, intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        uint256 opensAt = deadline + escrow.confirmationGrace();
        warpTo = bound(warpTo, block.timestamp, opensAt + 30 days);
        vm.warp(warpTo);

        if (warpTo < opensAt) {
            vm.expectRevert(PerihelionEscrow.DeadlineNotPassed.selector);
            escrow.cancelExpired(h);
        } else {
            uint256 userBefore = token.balanceOf(user);
            escrow.cancelExpired(h);
            assertEq(token.balanceOf(user), userBefore + 100_000); // user made whole
            assertEq(token.balanceOf(address(escrow)), 0);
            (,,,,,,, bool refunded) = escrow.locks(h);
            assertTrue(refunded);
        }
    }

    /// A reserved intent can only be locked by its preferred solver.
    function testFuzz_PreferredSolverEnforced(address caller, address preferred) public {
        vm.assume(preferred != address(0));
        vm.assume(caller != preferred);
        vm.assume(caller != address(0));

        PerihelionEscrow.Intent memory intent = _intent(100_000, block.timestamp + 600);
        intent.preferredSolver = preferred;
        bytes memory sig = _sign(userPk, intent);

        vm.deal(caller, 1 ether);
        vm.prank(caller);
        vm.expectRevert(PerihelionEscrow.ReservedForSolver.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    // --- lzReceive authorization failure fuzz tests (PR #226) -----------------

    /// @dev Calling lzReceive from a non-endpoint address must always revert
    ///      with NotEndpoint, regardless of message content.
    function testFuzz_LzReceive_NotEndpoint(
        bytes32 intentHash,
        bytes32 solverWord,
        uint128 amount,
        uint64 ledger
    ) public {
        bytes memory message = abi.encodePacked(
            bytes1(0x01), bytes1(0x02), intentHash, solverWord, amount, ledger
        );

        // Call lzReceive from a random non-endpoint address — must revert NotEndpoint
        vm.prank(address(0xDEAD));
        vm.expectRevert(PerihelionEscrow.NotEndpoint.selector);
        escrow.lzReceive(
            Origin({ srcEid: STELLAR_EID, sender: STELLAR_PEER, nonce: 5 }),
            bytes32(0),
            message,
            address(0),
            ""
        );
    }

    /// @dev lzReceive from the endpoint but with an untrusted peer must always
    ///      revert with UntrustedPeer, regardless of message type/content.
    function testFuzz_LzReceive_UntrustedPeer(
        bytes32 msgTypeAndVersion,
        bytes32 arbitrarySender,
        bytes32 intentHash
    ) public {
        vm.assume(arbitrarySender != STELLAR_PEER);
        vm.assume(arbitrarySender != bytes32(0));

        // Build a minimal message with version, type, and hash
        bytes memory message = abi.encodePacked(
            bytes1(0x01),
            bytes1(0x02),
            intentHash,
            bytes32(uint256(uint160(address(0)))),
            uint128(0),
            uint64(0)
        );

        vm.expectRevert(PerihelionEscrow.UntrustedPeer.selector);
        endpoint.deliver(escrow, STELLAR_EID, arbitrarySender, 1, message);
    }

    /// @dev lzReceive with a stale nonce (zero) must revert StaleNonce.
    function testFuzz_LzReceive_ZeroNonceRejected(bytes32 intentHash) public {
        bytes memory message = abi.encodePacked(
            bytes1(0x01),
            bytes1(0x02),
            intentHash,
            bytes32(uint256(uint160(address(0)))),
            uint128(0),
            uint64(0)
        );

        vm.expectRevert(PerihelionEscrow.StaleNonce.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 0, message);
    }

    /// @dev lzReceive with an unknown message type must revert UnknownMessageType.
    function testFuzz_LzReceive_UnknownMessageType(uint8 badType) public {
        vm.assume(badType != 0x01 && badType != 0x02 && badType != 0x03);

        bytes memory message = abi.encodePacked(bytes1(0x01), bytes1(badType), bytes32(0));

        vm.expectRevert(PerihelionEscrow.UnknownMessageType.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, message);
    }

    /// @dev lzReceive with wrong protocol version must revert UnknownVersion.
    function testFuzz_LzReceive_BadVersion(uint8 badVersion) public {
        vm.assume(badVersion != 0x01);

        bytes memory message = abi.encodePacked(bytes1(badVersion), bytes1(0x02), bytes32(0));

        vm.expectRevert(PerihelionEscrow.UnknownVersion.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, message);
    }

    // --- Nonce / replay guard property tests (PR #224) -----------------------

    /// @dev Two intents with the same fields but different nonces produce distinct
    ///      intent hashes, so they can both be locked without collision.
    function testFuzz_NonceDifferentiatesIntents(uint128 amountA, uint128 amountB) public {
        amountA = uint128(bound(amountA, 1, type(uint128).max - 1));
        amountB = uint128(bound(amountB, 1, type(uint128).max));
        vm.assume(amountA != amountB);
        // Two locks can total more than the setUp mint; top the user up.
        token.mint(user, type(uint128).max);

        uint256 deadline = block.timestamp + 600;

        // Lock intent with nonce=1
        PerihelionEscrow.Intent memory intent1 = _intent(amountA, deadline, 1);
        bytes memory sig1 = _sign(userPk, intent1);
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent1, sig1);

        // Lock intent with nonce=2 and different amount — must succeed
        PerihelionEscrow.Intent memory intent2 = _intent(amountB, deadline, 2);
        bytes memory sig2 = _sign(userPk, intent2);
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent2, sig2);

        // Both locks independently recorded
        bytes32 h1 = escrow.hashIntent(intent1);
        bytes32 h2 = escrow.hashIntent(intent2);
        vm.assertEq(h1 != h2, true);

        (,,, uint256 held1,,,,) = escrow.locks(h1);
        (,,, uint256 held2,,,,) = escrow.locks(h2);
        assertEq(held1, amountA);
        assertEq(held2, amountB);
    }

    /// @dev Same intent replayed (same nonce) must revert with AlreadyLocked.
    function testFuzz_ReplaySameNonceRejected(uint128 amount) public {
        amount = uint128(bound(amount, 1, uint128(type(uint128).max / 2)));

        PerihelionEscrow.Intent memory intent = _intent(amount, block.timestamp + 600, 1);
        bytes memory sig = _sign(userPk, intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // Replay the exact same intent — must revert
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.AlreadyLocked.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    /// @dev Transport-layer nonce replay: delivering the same LayerZero nonce twice
    ///      must revert with StaleNonce.
    function testFuzz_LzNonceReplayRejected() public {
        PerihelionEscrow.Intent memory intent = _intent(100_000, block.timestamp + 600, 1);
        bytes memory sig = _sign(userPk, intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // Confirm with nonce=1 (first delivery)
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, _fillConfirmed(h));

        // Replay same nonce=1 — must revert StaleNonce
        vm.expectRevert(PerihelionEscrow.StaleNonce.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, _fillConfirmed(h));
    }

    /// @dev Out-of-order delivery: nonce 5 lands before nonce 3; 3 must still be
    ///      accepted (bitmap allows unordered), but 5 replayed must be stale.
    function testFuzz_LzNonceUnorderedDelivery() public {
        PerihelionEscrow.Intent memory intent = _intent(100_000, block.timestamp + 600, 1);
        bytes memory sig = _sign(userPk, intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // Deliver nonce=5 first (unordered)
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 5, _fillConfirmed(h));

        // Nonce=3 is still new — need a second lock to confirm
        PerihelionEscrow.Intent memory intent2 = _intent(200_000, block.timestamp + 600, 2);
        bytes memory sig2 = _sign(userPk, intent2);
        bytes32 h2 = escrow.hashIntent(intent2);
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent2, sig2);

        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 3, _fillConfirmed(h2));

        // Replay nonce=5 — must revert StaleNonce
        vm.expectRevert(PerihelionEscrow.StaleNonce.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 5, _fillConfirmed(h));
    }

    // --- Helpers -------------------------------------------------------------

    function _fillConfirmed(bytes32 intentHash) internal pure returns (bytes memory) {
        return abi.encodePacked(
            bytes1(0x01), // V = PROTOCOL_VERSION
            bytes1(0x02), // T_FILL_CONFIRMED
            intentHash,
            bytes32(uint256(uint160(address(0x5012E5)))), // solver
            uint128(type(uint128).max >> 1), // >= any minDestAmount the fuzzer can produce
            uint64(12_345)
        );
    }
}
