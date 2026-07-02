// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { MockERC20, MockEndpoint } from "./PerihelionEscrow.t.sol";

/// @dev Stateless property tests for the escrow's value-handling and guards.
contract PerihelionEscrowFuzzTest is Test {
    PerihelionEscrow internal escrow;
    MockERC20 internal token;
    MockEndpoint internal endpoint;

    uint32 internal constant STELLAR_EID = 30_316;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0x57E11A));

    // Wire-format tags for lzReceive messages (mirror PerihelionEscrow.t.sol).
    bytes1 internal constant V = 0x01;
    bytes1 internal constant T_FILL_CONFIRMED = 0x02;
    bytes1 internal constant T_CANCEL_INTENT = 0x03;

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
        vm.deal(solver, 100 ether);
    }

    function _intent(uint256 amount, uint256 deadline)
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
            minDestAmount: amount,
            deadline: deadline,
            nonce: 1,
            preferredSolver: address(0)
        });
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
        (,,, uint256 held,,,) = escrow.locks(h);
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
            (,,,,,, bool refunded) = escrow.locks(h);
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

    // =========================================================================
    // Nonce Replay Guard Property Tests (issue #103)
    // =========================================================================

    /// Helper: build a FillConfirmed message for lzReceive.
    function _fillConfirmed(bytes32 intentHash, address solverEvm)
        internal
        view
        returns (bytes memory)
    {
        bytes memory message = abi.encodePacked(
            V,
            T_FILL_CONFIRMED,
            intentHash,
            bytes32(uint256(uint160(solverEvm))), // 32-byte solver_evm (EVM address left-padded)
            uint128(100_000),
            uint64(block.timestamp)
        );
        return message;
    }

    /// Helper: build a CancelIntent message for lzReceive.
    function _cancelIntent(bytes32 intentHash, uint8 reason)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory message = abi.encodePacked(
            V,
            T_CANCEL_INTENT,
            intentHash,
            reason
        );
        return message;
    }

    /// Property: Nonce = 0 is always rejected.
    function testFuzz_NonceZeroRejected(bytes32 intentHash) public {
        // Create a locked intent first
        PerihelionEscrow.Intent memory intent = _intent(100_000, block.timestamp + 600);
        bytes memory sig = _sign(userPk, intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // Deliver FillConfirmed with nonce = 0 - must be rejected
        vm.expectRevert(PerihelionEscrow.StaleNonce.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 0, _fillConfirmed(h, solver));
    }

    /// Property: Each nonce is processed exactly once.
    /// Replaying the same nonce must always be rejected.
    function testFuzz_NonceReplayRejected(uint64 nonce) public {
        nonce = uint64(bound(nonce, 1, type(uint64).max));

        PerihelionEscrow.Intent memory intent = _intent(100_000, block.timestamp + 600);
        bytes memory sig = _sign(userPk, intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // First delivery should succeed
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, nonce, _fillConfirmed(h, solver));

        // Second delivery with same nonce must be rejected
        vm.expectRevert(PerihelionEscrow.StaleNonce.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, nonce, _fillConfirmed(h, solver));
    }

    /// Property: Out-of-order nonces within the bitmap window are all accepted.
    /// The EVM uses a bitmap-based nonce window supporting unordered delivery.
    function testFuzz_NonceUnorderedDelivery(
        uint64 baseNonce,
        uint64 nonce2,
        uint64 nonce3
    ) public {
        // Constrain to reasonable nonce range
        baseNonce = uint64(bound(baseNonce, 1, 1000));
        nonce2 = uint64(bound(nonce2, uint256(baseNonce) + 1, uint256(baseNonce) + 50));
        nonce3 = uint64(bound(nonce3, uint256(baseNonce) + 51, uint256(baseNonce) + 100));

        // Make sure nonces are distinct
        vm.assume(nonce2 != nonce3);
        vm.assume(nonce2 != baseNonce);
        vm.assume(nonce3 != baseNonce);

        // Lock three intents
        bytes32 h1 = _lockNonce(baseNonce);
        bytes32 h2 = _lockNonce(nonce2);
        bytes32 h3 = _lockNonce(nonce3);

        // Deliver in reverse order (highest nonce first)
        // All should be accepted due to unordered delivery support
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, nonce3, _fillConfirmed(h3, solver));
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, nonce2, _fillConfirmed(h2, solver));
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, baseNonce, _fillConfirmed(h1, solver));

        // Verify all were processed
        (,,,,, bool released1,) = escrow.locks(h1);
        (,,,,, bool released2,) = escrow.locks(h2);
        (,,,,, bool released3,) = escrow.locks(h3);
        assertEq(released1, true);
        assertEq(released2, true);
        assertEq(released3, true);

        // Replaying any nonce must now fail
        vm.expectRevert(PerihelionEscrow.StaleNonce.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, nonce3, _fillConfirmed(h3, solver));
    }

    /// Helper: lock an intent returning its hash, with provided nonce.
    function _lockNonce(uint64 nonce) internal returns (bytes32) {
        PerihelionEscrow.Intent memory intent = _intent(100_000, block.timestamp + 600);
        intent.nonce = nonce;
        bytes memory sig = _sign(userPk, intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);
        return h;
    }

    /// Property: Large nonce gaps advance the window appropriately.
    /// When a nonce far ahead arrives, the high-water mark updates.
    function testFuzz_NonceLargeGap(uint64 lowNonce, uint64 highNonce) public {
        lowNonce = uint64(bound(lowNonce, 1, 100));
        highNonce = uint64(bound(highNonce, uint256(lowNonce) + 65, uint256(lowNonce) + 200)); // > window size

        bytes32 h = _lockNonce(lowNonce);

        // Deliver high nonce - should advance window
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, highNonce, _fillConfirmed(h, solver));

        // The old nonce should now still work (bitmap allows sparse setting)
        // But the high-water mark should have advanced
        assertEq(escrow.inboundNonce(STELLAR_EID), highNonce);
    }
}
