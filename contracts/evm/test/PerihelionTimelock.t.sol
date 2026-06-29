// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionTimelock } from "../src/PerihelionTimelock.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { MockEndpoint } from "./PerihelionEscrow.t.sol";

/// @dev Records the calls the timelock makes, so execution can be asserted.
contract MockTarget {
    uint256 public value;
    uint256 public lastMsgValue;

    function setValue(uint256 v) external payable {
        value = v;
        lastMsgValue = msg.value;
    }

    function boom() external pure {
        revert("boom");
    }
}

contract PerihelionTimelockTest is Test {
    PerihelionTimelock internal tl;
    MockTarget internal target;

    address internal a = address(0xA1);
    address internal b = address(0xB2);
    address internal c = address(0xC3);
    address internal stranger = address(0xDEAD);

    uint256 internal constant DELAY = 2 days;
    bytes32 internal constant SALT = bytes32(uint256(1));

    function setUp() public {
        address[] memory owners = new address[](3);
        owners[0] = a;
        owners[1] = b;
        owners[2] = c;
        tl = new PerihelionTimelock(owners, 2, DELAY); // 2-of-3
        target = new MockTarget();
    }

    function _setValueData(uint256 v) internal pure returns (bytes memory) {
        return abi.encodeWithSelector(MockTarget.setValue.selector, v);
    }

    // --- Construction --------------------------------------------------------

    function test_Construction() public view {
        assertEq(tl.ownerCount(), 3);
        assertEq(tl.threshold(), 2);
        assertEq(tl.delay(), DELAY);
        assertTrue(tl.isOwner(a));
        assertFalse(tl.isOwner(stranger));
    }

    function test_RevertWhen_ThresholdZero() public {
        address[] memory owners = new address[](1);
        owners[0] = a;
        vm.expectRevert(PerihelionTimelock.InvalidConfig.selector);
        new PerihelionTimelock(owners, 0, DELAY);
    }

    function test_RevertWhen_ThresholdAboveOwners() public {
        address[] memory owners = new address[](1);
        owners[0] = a;
        vm.expectRevert(PerihelionTimelock.InvalidConfig.selector);
        new PerihelionTimelock(owners, 2, DELAY);
    }

    function test_RevertWhen_DuplicateOwner() public {
        address[] memory owners = new address[](2);
        owners[0] = a;
        owners[1] = a;
        vm.expectRevert(PerihelionTimelock.InvalidConfig.selector);
        new PerihelionTimelock(owners, 1, DELAY);
    }

    function test_RevertWhen_ZeroOwner() public {
        address[] memory owners = new address[](1);
        owners[0] = address(0);
        vm.expectRevert(PerihelionTimelock.InvalidConfig.selector);
        new PerihelionTimelock(owners, 1, DELAY);
    }

    function test_RevertWhen_ConstructorDelayBelowMin() public {
        address[] memory owners = new address[](1);
        owners[0] = a;
        vm.expectRevert(PerihelionTimelock.InvalidConfig.selector);
        new PerihelionTimelock(owners, 1, tl.MIN_DELAY() - 1);
    }

    function test_RevertWhen_ConstructorDelayAboveMax() public {
        address[] memory owners = new address[](1);
        owners[0] = a;
        vm.expectRevert(PerihelionTimelock.InvalidConfig.selector);
        new PerihelionTimelock(owners, 1, tl.MAX_DELAY() + 1);
    }

    // --- Happy path ----------------------------------------------------------

    function test_ProposeConfirmDelayExecute() public {
        bytes memory data = _setValueData(42);

        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, data, SALT);

        // One confirmation (proposer) is below threshold: not ready yet.
        (, uint64 readyAt,,) = tl.operations(id);
        assertEq(readyAt, 0);

        vm.prank(b);
        tl.confirm(id);
        (, readyAt,,) = tl.operations(id);
        assertEq(readyAt, block.timestamp + DELAY);

        // Too early.
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.NotReady.selector);
        tl.execute(address(target), 0, data, SALT);

        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        tl.execute(address(target), 0, data, SALT);
        assertEq(target.value(), 42);

        (,, bool executed,) = tl.operations(id);
        assertTrue(executed);
    }

    function test_ExecuteForwardsValue() public {
        bytes memory data = _setValueData(7);
        vm.deal(address(tl), 1 ether);
        bytes32 id = tl.hashOperation(address(target), 0.5 ether, data, SALT);

        vm.prank(a);
        tl.propose(address(target), 0.5 ether, data, SALT);
        vm.prank(b);
        tl.confirm(id);

        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        tl.execute(address(target), 0.5 ether, data, SALT);
        assertEq(target.lastMsgValue(), 0.5 ether);
    }

    // --- Guards --------------------------------------------------------------

    function test_RevertWhen_NonOwnerProposes() public {
        vm.prank(stranger);
        vm.expectRevert(PerihelionTimelock.NotOwner.selector);
        tl.propose(address(target), 0, _setValueData(1), SALT);
    }

    function test_RevertWhen_ExecuteBelowThreshold() public {
        bytes memory data = _setValueData(1);
        vm.prank(a);
        tl.propose(address(target), 0, data, SALT);
        // Only the proposer has confirmed (1 < 2): never reaches the delay gate.
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.NotEnoughConfirmations.selector);
        tl.execute(address(target), 0, data, SALT);
    }

    function test_RevertWhen_DoubleConfirm() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(1), SALT);
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.AlreadyConfirmed.selector);
        tl.confirm(id);
    }

    function test_RevertWhen_DoubleExecute() public {
        bytes memory data = _setValueData(9);
        bytes32 id = tl.hashOperation(address(target), 0, data, SALT);
        vm.prank(a);
        tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        tl.execute(address(target), 0, data, SALT);

        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.AlreadyExecuted.selector);
        tl.execute(address(target), 0, data, SALT);
    }

    function test_RevertWhen_ExecuteFails() public {
        bytes memory data = abi.encodeWithSelector(MockTarget.boom.selector);
        bytes32 id = tl.hashOperation(address(target), 0, data, SALT);
        vm.prank(a);
        tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.CallFailed.selector);
        tl.execute(address(target), 0, data, SALT);
    }

    // --- Expiry ----------------------------------------------------------------

    function test_ExecuteJustBeforeExpiry_Succeeds() public {
        bytes memory data = _setValueData(11);
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);

        (, uint64 readyAt,,) = tl.operations(id);
        assertEq(tl.expiryOf(id), readyAt + tl.GRACE_PERIOD());

        // One second before expiry: still executable.
        vm.warp(readyAt + tl.GRACE_PERIOD());
        vm.prank(a);
        tl.execute(address(target), 0, data, SALT);
        assertEq(target.value(), 11);
    }

    function test_RevertWhen_ExecuteAfterExpiry() public {
        bytes memory data = _setValueData(12);
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);

        (, uint64 readyAt,,) = tl.operations(id);
        vm.warp(readyAt + tl.GRACE_PERIOD() + 1);
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.Expired.selector);
        tl.execute(address(target), 0, data, SALT);
    }

    function test_ExpiryOf_ZeroBeforeReady() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(1), SALT);
        // Only proposer confirmed: not ready yet.
        assertEq(tl.expiryOf(id), 0);
    }

    // --- Revocation & cancellation ------------------------------------------

    function test_RevokeResetsTimelock() public {
        bytes memory data = _setValueData(5);
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);

        // b revokes -> back below threshold -> readyAt cleared.
        vm.prank(b);
        tl.revokeConfirmation(id);
        (uint64 confs, uint64 readyAt,,) = tl.operations(id);
        assertEq(confs, 1);
        assertEq(readyAt, 0);

        // Re-confirming restarts the full delay from now.
        vm.warp(block.timestamp + 1 days);
        vm.prank(c);
        tl.confirm(id);
        (, readyAt,,) = tl.operations(id);
        assertEq(readyAt, block.timestamp + DELAY);
    }

    // --- Cancellation policy ---------------------------------------------------
    //
    // Deliberate choice (documented in SECURITY.md / TECHNICAL-ARCHITECTURE.md
    // §6.1 T10): cancellation stays 1-of-N. Any single owner — not just the
    // proposer or a threshold — may cancel a pending (un-executed) operation.
    // This is a cheap liveness valve (anyone can clear a stuck or contested op
    // without needing to assemble the same threshold that confirms), at the
    // acknowledged cost that one dissenting owner can repeatedly cancel
    // operations a majority supports, stalling that specific action (not the
    // multisig's ability to act in general — re-proposing is equally cheap).
    // Symmetric (threshold-to-cancel) and proposer-only alternatives were
    // considered and rejected for now: both reduce the cancel path's
    // liveness without removing the underlying need for owners to coordinate
    // on what should run, which is a process/governance concern, not a
    // contract one.

    function test_Cancel() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(1), SALT);
        vm.prank(b);
        tl.cancel(id);
        (,,, bool exists) = tl.operations(id);
        assertFalse(exists);
    }

    /// @notice Pins the deliberate 1-of-N policy: a single non-proposing
    ///         owner can unilaterally cancel, even one who never confirmed.
    function test_Cancel_BySingleNonProposingOwner_Succeeds() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(2), SALT);
        // c never confirmed this op, yet a single owner suffices to cancel.
        vm.prank(c);
        tl.cancel(id);
        (,,, bool exists) = tl.operations(id);
        assertFalse(exists);
    }

    function test_RevertWhen_NonOwnerCancels() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(3), SALT);
        vm.prank(stranger);
        vm.expectRevert(PerihelionTimelock.NotOwner.selector);
        tl.cancel(id);
    }

    function test_RevertWhen_CancelExecuted() public {
        bytes memory data = _setValueData(4);
        bytes32 id = tl.hashOperation(address(target), 0, data, SALT);
        vm.prank(a);
        tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        tl.execute(address(target), 0, data, SALT);

        vm.prank(c);
        vm.expectRevert(PerihelionTimelock.AlreadyExecuted.selector);
        tl.cancel(id);
    }

    // --- Self-administered config -------------------------------------------

    function test_RevertWhen_ConfigCalledDirectly() public {
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.NotSelf.selector);
        tl.addOwner(stranger);
    }

    function test_AddOwnerThroughGovernance() public {
        bytes memory data = abi.encodeWithSelector(PerihelionTimelock.addOwner.selector, stranger);
        bytes32 id = tl.hashOperation(address(tl), 0, data, SALT);
        vm.prank(a);
        tl.propose(address(tl), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        tl.execute(address(tl), 0, data, SALT);

        assertTrue(tl.isOwner(stranger));
        assertEq(tl.ownerCount(), 4);
    }

    function test_RevertWhen_SetDelayBelowMin() public {
        bytes memory data = abi.encodeWithSelector(PerihelionTimelock.setDelay.selector, tl.MIN_DELAY() - 1);
        bytes32 id = tl.hashOperation(address(tl), 0, data, SALT);
        vm.prank(a);
        tl.propose(address(tl), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.CallFailed.selector); // inner InvalidConfig
        tl.execute(address(tl), 0, data, SALT);
    }

    function test_RevertWhen_SetDelayAboveMax() public {
        bytes memory data = abi.encodeWithSelector(PerihelionTimelock.setDelay.selector, tl.MAX_DELAY() + 1);
        bytes32 id = tl.hashOperation(address(tl), 0, data, SALT);
        vm.prank(a);
        tl.propose(address(tl), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.CallFailed.selector); // inner InvalidConfig
        tl.execute(address(tl), 0, data, SALT);
    }

    function test_SetDelayAtMinBoundarySucceeds() public {
        uint256 newDelay = tl.MIN_DELAY();
        bytes memory data = abi.encodeWithSelector(PerihelionTimelock.setDelay.selector, newDelay);
        bytes32 id = tl.hashOperation(address(tl), 0, data, SALT);
        vm.prank(a);
        tl.propose(address(tl), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        tl.execute(address(tl), 0, data, SALT);
        assertEq(tl.delay(), newDelay);
    }

    function test_RevertWhen_RemoveOwnerBreaksThreshold() public {
        // Drop to 2 owners first via governance would still satisfy 2-of-2; removing
        // a third owner is fine, but removing below threshold must revert. Build a
        // 2-of-2 timelock and try to remove one.
        address[] memory owners = new address[](2);
        owners[0] = a;
        owners[1] = b;
        PerihelionTimelock t2 = new PerihelionTimelock(owners, 2, DELAY);

        bytes memory data = abi.encodeWithSelector(PerihelionTimelock.removeOwner.selector, b);
        bytes32 id = t2.hashOperation(address(t2), 0, data, SALT);
        vm.prank(a);
        t2.propose(address(t2), 0, data, SALT);
        vm.prank(b);
        t2.confirm(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.CallFailed.selector); // inner InvalidConfig
        t2.execute(address(t2), 0, data, SALT);
    }

    // --- End-to-end: timelock owns the escrow --------------------------------

    function test_TimelockOwnsAndGovernsEscrow() public {
        MockEndpoint endpoint = new MockEndpoint();
        PerihelionEscrow escrow = new PerihelionEscrow(address(endpoint), 30_316);

        // Hand the escrow to the timelock via the two-step handover.
        escrow.transferOwnership(address(tl));
        bytes memory acceptData = abi.encodeWithSelector(PerihelionEscrow.acceptOwnership.selector);
        bytes32 acceptId = tl.hashOperation(address(escrow), 0, acceptData, SALT);
        vm.prank(a);
        tl.propose(address(escrow), 0, acceptData, SALT);
        vm.prank(b);
        tl.confirm(acceptId);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        tl.execute(address(escrow), 0, acceptData, SALT);
        assertEq(escrow.owner(), address(tl));

        // Now a peer rotation must go through the full timelocked flow.
        bytes32 newPeer = bytes32(uint256(0xCAFE));
        bytes memory peerData = abi.encodeWithSelector(PerihelionEscrow.setPeer.selector, newPeer);
        bytes32 salt2 = bytes32(uint256(2));
        bytes32 peerId = tl.hashOperation(address(escrow), 0, peerData, salt2);
        vm.prank(a);
        tl.propose(address(escrow), 0, peerData, salt2);
        vm.prank(c);
        tl.confirm(peerId);
        vm.warp(block.timestamp + DELAY);
        vm.prank(b);
        tl.execute(address(escrow), 0, peerData, salt2);
        assertEq(escrow.stellarPeer(), newPeer);
    }

    /// @notice Pins the dead-value-path failure mode (issue: timelock forwards
    ///         `value` but the escrow's admin setters are non-payable): a
    ///         mistaken non-zero-value admin op reverts cleanly with
    ///         CallFailed, only after the full propose/confirm/delay cycle.
    function test_RevertWhen_NonZeroValueTargetsNonPayableEscrowFunction() public {
        MockEndpoint endpoint = new MockEndpoint();
        PerihelionEscrow escrow = new PerihelionEscrow(address(endpoint), 30_316);
        escrow.transferOwnership(address(tl));
        bytes memory acceptData = abi.encodeWithSelector(PerihelionEscrow.acceptOwnership.selector);
        bytes32 acceptId = tl.hashOperation(address(escrow), 0, acceptData, SALT);
        vm.prank(a);
        tl.propose(address(escrow), 0, acceptData, SALT);
        vm.prank(b);
        tl.confirm(acceptId);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        tl.execute(address(escrow), 0, acceptData, SALT);

        // Mistaken op: setPeer is non-payable, but the proposer attaches value.
        vm.deal(address(tl), 1 ether);
        bytes32 newPeer = bytes32(uint256(0xCAFE));
        bytes memory peerData = abi.encodeWithSelector(PerihelionEscrow.setPeer.selector, newPeer);
        bytes32 salt3 = bytes32(uint256(3));
        bytes32 peerId = tl.hashOperation(address(escrow), 1 ether, peerData, salt3);
        vm.prank(a);
        tl.propose(address(escrow), 1 ether, peerData, salt3);
        vm.prank(b);
        tl.confirm(peerId);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.CallFailed.selector);
        tl.execute(address(escrow), 1 ether, peerData, salt3);
    }
}
