// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { MockERC20, MockEndpoint } from "./PerihelionEscrow.t.sol";
import { MessagingReceipt, MessagingFee, MessagingParams } from "../src/interfaces/ILayerZero.sol";

/// @notice User revocation of signed intents before a solver locks them (#1053).
contract CancelIntentTest is Test {
    uint32 internal constant STELLAR_EID = 30_168;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0xBEEF));

    PerihelionEscrow internal escrow;
    MockEndpoint internal endpoint;
    MockERC20 internal token;

    uint256 internal userPk = 0xA11CE;
    address internal user;
    address internal solver = address(0x501);
    address internal otherUser = address(0xB0B);

    event IntentRevoked(bytes32 indexed intentHash, address indexed user);

    function setUp() public {
        endpoint = new MockEndpoint();
        escrow = new PerihelionEscrow(address(endpoint), STELLAR_EID);
        escrow.setPeer(STELLAR_PEER);

        token = new MockERC20();
        user = vm.addr(userPk);
        token.mint(user, 1_000_000);
        vm.prank(user);
        token.approve(address(escrow), type(uint256).max);

        escrow.setAssetAllowed(address(token), true);
        escrow.setMaxIntentAmountPerAsset(address(token), type(uint256).max);
        vm.deal(solver, 10 ether);

        // The mock endpoint's send() reverts in this harness; stub it so the lock path
        // under test is the escrow's own validation, not the mock.
        MessagingReceipt memory receipt = MessagingReceipt({
            guid: bytes32(uint256(1)),
            nonce: 1,
            fee: MessagingFee({ nativeFee: 0, lzTokenFee: 0 })
        });
        vm.mockCall(
            address(endpoint),
            abi.encodeWithSelector(MockEndpoint.send.selector),
            abi.encode(receipt)
        );
    }

    function _intent(uint256 nonce) internal view returns (PerihelionEscrow.Intent memory) {
        return PerihelionEscrow.Intent({
            user: user,
            destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            sourceChainId: block.chainid,
            sourceAsset: address(token),
            sourceAmount: 100_000,
            destAsset: "USDC:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            minDestAmount: 990_000,
            deadline: block.timestamp + 600,
            nonce: nonce,
            preferredSolver: address(0)
        });
    }

    function _sign(PerihelionEscrow.Intent memory intent) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, escrow.hashIntent(intent));
        return abi.encodePacked(r, s, v);
    }

    function _lock(PerihelionEscrow.Intent memory intent) internal {
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_CancelMarksIntentAndEmits() public {
        PerihelionEscrow.Intent memory intent = _intent(1);
        bytes32 h = escrow.hashIntent(intent);

        vm.expectEmit(true, true, false, true, address(escrow));
        emit IntentRevoked(h, user);
        vm.prank(user);
        escrow.cancelIntent(h);

        assertTrue(escrow.cancelledIntent(user, h));
    }

    function test_RevertWhen_LockAfterCancel() public {
        PerihelionEscrow.Intent memory intent = _intent(1);
        bytes32 h = escrow.hashIntent(intent);
        vm.prank(user);
        escrow.cancelIntent(h);

        bytes memory sig = _sign(intent);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.IntentCancelled.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_CancelOnlyAffectsSignerIntent() public {
        // Another account revoking the same hash writes only its own slot, so the
        // signer's intent still locks.
        PerihelionEscrow.Intent memory intent = _intent(2);
        bytes32 h = escrow.hashIntent(intent);
        vm.prank(otherUser);
        escrow.cancelIntent(h);

        assertFalse(escrow.cancelledIntent(user, h));
        _lock(intent);
        (, address lockUser,,,,,,) = escrow.locks(h);
        assertEq(lockUser, user);
    }

    function test_CancelDoesNotAffectOtherIntents() public {
        PerihelionEscrow.Intent memory cancelled = _intent(3);
        PerihelionEscrow.Intent memory kept = _intent(4);
        vm.prank(user);
        escrow.cancelIntent(escrow.hashIntent(cancelled));

        _lock(kept);
        (, address keptUser,,,,,,) = escrow.locks(escrow.hashIntent(kept));
        assertEq(keptUser, user);
    }

    function test_CancelIsIdempotent() public {
        bytes32 h = escrow.hashIntent(_intent(5));
        vm.startPrank(user);
        escrow.cancelIntent(h);
        escrow.cancelIntent(h);
        vm.stopPrank();
        assertTrue(escrow.cancelledIntent(user, h));
    }

    function test_RevertWhen_CancelAfterLock() public {
        PerihelionEscrow.Intent memory intent = _intent(6);
        bytes32 h = escrow.hashIntent(intent);
        _lock(intent);

        vm.prank(user);
        vm.expectRevert(PerihelionEscrow.AlreadyLocked.selector);
        escrow.cancelIntent(h);
    }

    function test_CancelWorksWhenPaused() public {
        // Consent withdrawal must not depend on the admin pause switch.
        PerihelionEscrow.Intent memory intent = _intent(7);
        bytes32 h = escrow.hashIntent(intent);
        escrow.pause();

        vm.prank(user);
        escrow.cancelIntent(h);
        assertTrue(escrow.cancelledIntent(user, h));
    }
}
