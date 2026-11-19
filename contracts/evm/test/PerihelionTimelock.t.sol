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
        new PerihelionTimelock(owners, 1, 86399); // 1 day - 1 second
    }

    function test_RevertWhen_ConstructorDelayAboveMax() public {
        address[] memory owners = new address[](1);
        owners[0] = a;
        vm.expectRevert(PerihelionTimelock.InvalidConfig.selector);
        new PerihelionTimelock(owners, 1, 2592001); // 30 days + 1 second
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

    // --- Proposed event payload (issue #1059) --------------------------------
    //
    // The full calldata and salt must be recoverable from logs so co-signers
    // can verify what they are confirming without trusting off-chain data.

    /// @notice AC (#1059): Proposed carries target, value, data and salt, and
    ///         recomputing hashOperation from the logged fields yields the id.
    function test_Proposed_EventCarriesCalldataAndSalt() public {
        bytes memory data = _setValueData(1234);
        uint256 value = 0.25 ether;

        vm.recordLogs();
        vm.prank(a);
        bytes32 id = tl.propose(address(target), value, data, SALT);

        Vm.Log[] memory logs = vm.getRecordedLogs();
        // The Proposed event is the only log emitted by propose().
        assertEq(logs.length, 1, "propose must emit exactly one log");

        // topic0 = event signature, topic1 = id, topic2 = proposer.
        assertEq(
            logs[0].topics[0],
            keccak256("Proposed(bytes32,address,address,uint256,bytes,bytes32)"),
            "event signature"
        );
        assertEq(logs[0].topics[1], id, "indexed id");
        assertEq(
            logs[0].topics[2], bytes32(uint256(uint160(a))), "indexed proposer"
        );

        // Non-indexed payload: target, value, data, salt.
        (address loggedTarget, uint256 loggedValue, bytes memory loggedData, bytes32 loggedSalt) =
            abi.decode(logs[0].data, (address, uint256, bytes, bytes32));
        assertEq(loggedTarget, address(target), "logged target");
        assertEq(loggedValue, value, "logged value");
        assertEq(loggedData, data, "logged data");
        assertEq(loggedSalt, SALT, "logged salt");

        // The logged fields must reproduce the indexed id.
        assertEq(
            tl.hashOperation(loggedTarget, loggedValue, loggedData, loggedSalt),
            id,
            "hashOperation from logged fields must equal id"
        );
    }

    /// @notice AC (#1059): vm.expectEmit with the full payload matches.
    function test_Proposed_ExpectEmitFullPayload() public {
        bytes memory data = _setValueData(4321);
        bytes32 id = tl.hashOperation(address(target), 0, data, SALT);

        vm.expectEmit(true, true, false, true, address(tl));
        emit PerihelionTimelock.Proposed(id, a, address(target), 0, data, SALT);
        vm.prank(a);
        tl.propose(address(target), 0, data, SALT);
    }

    // --- msg.value reconciliation on execute (issue #1060) -------------------

    /// @notice AC (#1060): execute with msg.value == value succeeds and the
    ///         value is forwarded to the target.
    function test_Execute_MsgValueEqualsValue_Forwards() public {
        bytes memory data = _setValueData(55);
        uint256 value = 0.5 ether;
        bytes32 id = tl.hashOperation(address(target), value, data, SALT);

        vm.prank(a);
        tl.propose(address(target), value, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);

        vm.deal(a, value);
        vm.prank(a);
        tl.execute{ value: value }(address(target), value, data, SALT);

        assertEq(target.lastMsgValue(), value, "value forwarded to target");
        assertEq(address(tl).balance, 0, "no ETH stranded in timelock");
    }

    /// @notice AC (#1060): execute with msg.value == 0 succeeds when the
    ///         timelock is pre-funded via receive().
    function test_Execute_MsgValueZero_Prefunded_Succeeds() public {
        bytes memory data = _setValueData(66);
        uint256 value = 0.5 ether;
        bytes32 id = tl.hashOperation(address(target), value, data, SALT);

        vm.prank(a);
        tl.propose(address(target), value, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);

        // Fund the timelock directly.
        vm.deal(address(tl), value);

        vm.prank(a);
        tl.execute{ value: 0 }(address(target), value, data, SALT);

        assertEq(target.lastMsgValue(), value, "value forwarded from pre-funded balance");
        assertEq(address(tl).balance, 0, "pre-funded balance fully spent");
    }

    /// @notice AC (#1060): a msg.value that is neither 0 nor equal to value
    ///         reverts with the dedicated error.
    function test_RevertWhen_ExecuteMsgValueMismatch() public {
        bytes memory data = _setValueData(77);
        uint256 value = 0.5 ether;
        bytes32 id = tl.hashOperation(address(target), value, data, SALT);

        vm.prank(a);
        tl.propose(address(target), value, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);

        // Partial payment: neither 0 nor value.
        vm.deal(a, 1 ether);
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.MsgValueMismatch.selector);
        tl.execute{ value: 0.1 ether }(address(target), value, data, SALT);

        // Overpayment: also rejected.
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.MsgValueMismatch.selector);
        tl.execute{ value: 1 ether }(address(target), value, data, SALT);
    }

    /// @notice AC (#1060): a stray msg.value on a zero-value operation is not
    ///         silently accepted; it reverts and no ETH is stranded.
    function test_RevertWhen_ExecuteStrayMsgValueOnZeroValueOp() public {
        bytes memory data = _setValueData(88);
        bytes32 id = tl.hashOperation(address(target), 0, data, SALT);

        vm.prank(a);
        tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);

        vm.deal(a, 1 ether);
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.MsgValueMismatch.selector);
        tl.execute{ value: 1 ether }(address(target), 0, data, SALT);

        assertEq(address(tl).balance, 0, "no ETH stranded in timelock");
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

    // --- Revocation & monotonic clock (issue #283) --------------------------
    //
    // readyAt is set exactly once (when threshold is first reached) and never
    // cleared by revokeConfirmation. execute() enforces confirmations >= threshold
    // independently, so an under-threshold op is blocked from running but the
    // clock is not reset. A revoke/re-confirm cycle therefore cannot extend the
    // reaction window indefinitely.

    /// @notice AC1: confirm → threshold → revoke → re-confirm preserves readyAt.
    function test_Revoke_ReadyAtPreserved_AfterRevoke() public {
        bytes memory data = _setValueData(5);
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id); // threshold reached

        (, uint64 readyAtBefore,,) = tl.operations(id);
        assertGt(readyAtBefore, 0, "readyAt must be set after threshold");

        // b revokes — drops below threshold.
        vm.prank(b);
        tl.revokeConfirmation(id);
        (uint64 confs, uint64 readyAtAfterRevoke,,) = tl.operations(id);
        assertEq(confs, 1, "confirmations decremented");
        assertEq(
            readyAtAfterRevoke,
            readyAtBefore,
            "readyAt must not change on revoke - monotonic clock (issue #283)"
        );

        // c re-confirms — threshold restored, but readyAt unchanged.
        vm.warp(block.timestamp + 1 days); // advance time: must not shift the clock
        vm.prank(c);
        tl.confirm(id);
        (, uint64 readyAtAfterReconfirm,,) = tl.operations(id);
        assertEq(readyAtAfterReconfirm, readyAtBefore, "re-confirming must not reset readyAt");
    }

    /// @notice AC2: an operation below threshold cannot execute even after readyAt.
    function test_Revoke_BelowThresholdCannotExecuteAfterReadyAt() public {
        bytes memory data = _setValueData(6);
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id); // threshold reached, readyAt = now + DELAY

        // b immediately revokes — back to 1 confirmation, below threshold.
        vm.prank(b);
        tl.revokeConfirmation(id);

        // Advance past readyAt — operation is "ready" by time, but not by confirmations.
        vm.warp(block.timestamp + DELAY + 1);

        // execute must revert NotEnoughConfirmations, not NotReady.
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.NotEnoughConfirmations.selector);
        tl.execute(address(target), 0, data, SALT);
    }

    /// @notice Revoke of an operation that never reached threshold (no readyAt)
    ///         leaves readyAt at 0 — nothing to preserve.
    function test_Revoke_BeforeThreshold_ReadyAtStaysZero() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(7), SALT);
        // threshold = 2; only proposer (1 confirm) — not yet ready.

        vm.prank(a);
        tl.revokeConfirmation(id);

        (, uint64 readyAt,,) = tl.operations(id);
        assertEq(readyAt, 0, "readyAt should remain 0 when revoked before threshold");
    }

    /// @notice Revoke → re-confirm → execute: once readyAt has passed and
    ///         threshold is restored, execute succeeds (regression guard).
    function test_Revoke_ReconfirmAfterReadyAt_Executes() public {
        bytes memory data = _setValueData(8);
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id); // threshold reached, readyAt = now + DELAY

        (, uint64 readyAt,,) = tl.operations(id);

        // b revokes mid-delay.
        vm.warp(block.timestamp + DELAY / 2);
        vm.prank(b);
        tl.revokeConfirmation(id);

        // readyAt has passed (warp past the original readyAt).
        vm.warp(readyAt + 1);

        // b re-confirms — threshold restored, readyAt already elapsed.
        vm.prank(b);
        tl.confirm(id);

        // execute must succeed immediately (no extra delay).
        vm.prank(a);
        tl.execute(address(target), 0, data, SALT);
        assertEq(target.value(), 8);
    }

    // --- Cancellation policy ---------------------------------------------------
    //
    // Cancellation is symmetric with execution (issue #282 / #44): the same
    // M-of-N threshold required to execute a proposal is required to cancel it.
    // Each owner calls cancel(id) to submit a cancel-confirmation; once
    // `threshold` cancel-confirmations accumulate the operation is deleted and
    // Cancelled is emitted.
    //
    // This prevents a single compromised owner key from blocking governance
    // indefinitely by repeatedly cancelling proposals before they can execute.
    // An owner who merely disagrees with a proposal should use
    // revokeConfirmation, which already provides the single-owner "I withdraw
    // my support" primitive without giving veto power to any individual.

    /// @notice threshold - 1 cancel calls leave the operation intact.
    function test_Cancel_BelowThreshold_OperationIntact() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(1), SALT);

        // In a 2-of-3 setup, one cancel-confirmation is below threshold.
        vm.prank(b);
        tl.cancel(id);

        // Operation must still exist.
        (,,, bool exists) = tl.operations(id);
        assertTrue(exists, "operation must survive a single cancel below threshold");
        assertEq(tl.cancelConfirmations(id), 1);
        assertTrue(tl.cancelConfirmedBy(id, b));
    }

    /// @notice The threshold-th cancel call deletes the operation.
    function test_Cancel_AtThreshold_DeletesOperation() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(2), SALT);

        vm.prank(a);
        tl.cancel(id);
        (,,, bool exists) = tl.operations(id);
        assertTrue(exists, "still alive after first cancel");

        // Second cancel hits threshold (2-of-3).
        vm.prank(b);
        vm.expectEmit(true, false, false, false);
        emit PerihelionTimelock.Cancelled(id);
        tl.cancel(id);

        (,,, exists) = tl.operations(id);
        assertFalse(exists, "operation must be deleted after threshold cancel");
        // Cancel state cleaned up.
        assertEq(tl.cancelConfirmations(id), 0);
    }

    /// @notice AC: a single owner cannot cancel an operation that has reached
    ///         execution threshold (was at or above exec threshold).
    function test_Cancel_SingleOwnerCannotVetoThresholdReachedOp() public {
        bytes memory data = _setValueData(3);
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, data, SALT);
        vm.prank(b);
        tl.confirm(id); // threshold reached, readyAt set

        // One cancel-confirmation is not enough to kill it.
        vm.prank(c);
        tl.cancel(id);

        (,,, bool exists) = tl.operations(id);
        assertTrue(exists, "a single cancel must not remove a threshold-reached operation");
    }

    /// @notice AC: a single non-proposing owner cannot unilaterally cancel.
    function test_Cancel_SingleNonProposingOwnerCannotCancel() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(4), SALT);

        // c never confirmed; still only 1 cancel-confirmation — not enough.
        vm.prank(c);
        tl.cancel(id);

        (,,, bool exists) = tl.operations(id);
        assertTrue(exists, "single non-proposing owner must not unilaterally cancel");
    }

    /// @notice Non-owner cannot submit a cancel-confirmation.
    function test_RevertWhen_NonOwnerCancels() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(5), SALT);
        vm.prank(stranger);
        vm.expectRevert(PerihelionTimelock.NotOwner.selector);
        tl.cancel(id);
    }

    /// @notice Cancel of an already-executed operation reverts.
    function test_RevertWhen_CancelExecuted() public {
        bytes memory data = _setValueData(6);
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

    /// @notice Cancel of a non-existent operation reverts.
    function test_RevertWhen_CancelUnknown() public {
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.UnknownOperation.selector);
        tl.cancel(bytes32(uint256(0xDEAD)));
    }

    /// @notice An owner cannot submit duplicate cancel-confirmations.
    function test_RevertWhen_DuplicateCancelConfirmation() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(7), SALT);

        vm.prank(b);
        tl.cancel(id);

        vm.prank(b);
        vm.expectRevert(PerihelionTimelock.AlreadyCancelConfirmed.selector);
        tl.cancel(id);
    }

    /// @notice CancelConfirmed event is emitted on each cancel call.
    function test_CancelConfirmed_EventEmitted() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(8), SALT);

        vm.prank(b);
        vm.expectEmit(true, true, false, true);
        emit PerihelionTimelock.CancelConfirmed(id, b, 1);
        tl.cancel(id);
    }

    /// @notice All three owners cancelling a 2-of-3 op: threshold hit on
    ///         second call; third call reverts UnknownOperation (op is gone).
    function test_Cancel_ThirdCallAfterDeletion_Reverts() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(9), SALT);

        vm.prank(a);
        tl.cancel(id); // 1st — below threshold

        vm.prank(b);
        tl.cancel(id); // 2nd — threshold reached, op deleted

        // Op is gone; c's cancel must revert UnknownOperation.
        vm.prank(c);
        vm.expectRevert(PerihelionTimelock.UnknownOperation.selector);
        tl.cancel(id);
    }

    /// @notice Confirm + cancel-confirm by the same owner is valid: they are
    ///         independent paths. An owner who already confirmed an op may also
    ///         vote to cancel it.
    function test_Cancel_OwnerCanBothConfirmAndCancelConfirm() public {
        vm.prank(a);
        bytes32 id = tl.propose(address(target), 0, _setValueData(10), SALT);
        vm.prank(b);
        tl.confirm(id); // exec-confirm from b

        // a and b both cancel-confirm; threshold (2) is met on b's cancel.
        vm.prank(a);
        tl.cancel(id);
        vm.prank(b);
        tl.cancel(id); // deletion

        (,,, bool exists) = tl.operations(id);
        assertFalse(exists);
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
        bytes memory data =
            abi.encodeWithSelector(PerihelionTimelock.setDelay.selector, tl.MIN_DELAY() - 1);
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
        bytes memory data =
            abi.encodeWithSelector(PerihelionTimelock.setDelay.selector, tl.MAX_DELAY() + 1);
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

    // --- Removed-owner confirmations (issue #934) ---------------------------

    /// @notice AC (#934): a confirmation from an owner who has since been
    ///         removed must not count towards the execution threshold.
    function test_RemovedOwnerConfirmation_DoesNotCountTowardsThreshold() public {
        // 3-of-4 timelock so removing one owner keeps the threshold reachable.
        address d = address(0xD4);
        address[] memory owners = new address[](4);
        owners[0] = a;
        owners[1] = b;
        owners[2] = c;
        owners[3] = d;
        PerihelionTimelock t4 = new PerihelionTimelock(owners, 3, DELAY);

        // Pending operation confirmed by a, b and c (threshold reached).
        bytes memory data = _setValueData(77);
        bytes32 id = t4.hashOperation(address(target), 0, data, SALT);
        vm.prank(a);
        t4.propose(address(target), 0, data, SALT);
        vm.prank(b);
        t4.confirm(id);
        vm.prank(c);
        t4.confirm(id);

        // Remove c through governance (a, b, d confirm the removal).
        bytes memory removeData = abi.encodeWithSelector(PerihelionTimelock.removeOwner.selector, c);
        bytes32 removeId = t4.hashOperation(address(t4), 0, removeData, SALT);
        vm.prank(a);
        t4.propose(address(t4), 0, removeData, SALT);
        vm.prank(b);
        t4.confirm(removeId);
        vm.prank(d);
        t4.confirm(removeId);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        t4.execute(address(t4), 0, removeData, SALT);
        assertFalse(t4.isOwner(c), "c must be removed");

        // Only a and b are still owners: the removed owner's confirmation is
        // no longer counted, so execution fails for lack of confirmations.
        vm.prank(a);
        vm.expectRevert(PerihelionTimelock.NotEnoughConfirmations.selector);
        t4.execute(address(target), 0, data, SALT);
    }

    // --- Cancel then re-propose (issue #935) --------------------------------

    /// @notice AC (#935): an operation can be cancelled and re-proposed with
    ///         identical parameters, confirmed by the same owners, and executed.
    function test_CancelThenReproposeIdenticalOperation_Executes() public {
        bytes memory data = _setValueData(99);
        bytes32 id = tl.hashOperation(address(target), 0, data, SALT);

        // First proposal: a confirms, then a and b cancel it (threshold = 2).
        vm.prank(a);
        tl.propose(address(target), 0, data, SALT);
        vm.prank(a);
        tl.cancel(id);
        vm.prank(b);
        tl.cancel(id);
        (,,, bool exists) = tl.operations(id);
        assertFalse(exists, "operation must be cancelled");

        // Per-owner flags for the cancelled id are cleared.
        assertFalse(tl.confirmedBy(id, a), "confirmedBy must be cleared on cancel");
        assertFalse(tl.cancelConfirmedBy(id, a), "cancelConfirmedBy must be cleared on cancel");
        assertFalse(tl.cancelConfirmedBy(id, b), "cancelConfirmedBy must be cleared on cancel");

        // Re-propose the identical operation: the proposer's confirmation must
        // not hit AlreadyConfirmed.
        vm.prank(a);
        bytes32 id2 = tl.propose(address(target), 0, data, SALT);
        assertEq(id2, id, "identical parameters yield the same id");

        // The same owners confirm again and the operation executes.
        vm.prank(b);
        tl.confirm(id);
        vm.warp(block.timestamp + DELAY);
        vm.prank(a);
        tl.execute(address(target), 0, data, SALT);
        assertEq(target.value(), 99);
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
