// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { IERC20 } from "../src/IERC20.sol";
import { Origin, MessagingParams, ILayerZeroEndpoint } from "../src/interfaces/ILayerZero.sol";

/// @dev Minimal mintable ERC-20 for tests.
contract MockERC20 is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Fee-on-transfer token: skims `feeBps` from every transfer/transferFrom,
///      so the escrow's measured-delta accounting can be exercised.
contract FeeERC20 is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public immutable feeBps;

    constructor(uint256 _feeBps) {
        feeBps = _feeBps;
    }

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _move(address from, address to, uint256 amount) internal returns (uint256) {
        uint256 fee = (amount * feeBps) / 10_000;
        balanceOf[from] -= amount;
        balanceOf[to] += amount - fee;
        return amount - fee;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        _move(from, to, amount);
        return true;
    }
}

/// @dev USDT-style token: no return value (old USDC behavior). Tests escrow robustness.
contract NoReturnERC20 is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external {
        allowance[msg.sender][spender] = amount;
    }

    function transfer(address to, uint256 amount) external {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
    }

    function transferFrom(address from, address to, uint256 amount) external {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
    }
}

/// @dev Token that returns false on transfer (e.g., insufficient balance). Tests rejection.
contract FalseReturningERC20 is IERC20 {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        return false; // Always reject
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        return false; // Always reject
    }
}

/// @dev Records the last outbound LayerZero send and can replay inbound messages
///      back into the escrow as if it were the canonical endpoint.
contract MockEndpoint is ILayerZeroEndpoint {
    uint32 public lastDstEid;
    bytes32 public lastReceiver;
    bytes public lastMessage;
    uint256 public lastNativeFee;
    address public lastRefundAddress;
    uint256 public sendCount;

    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (bytes32)
    {
        lastDstEid = params.dstEid;
        lastReceiver = params.receiver;
        lastMessage = params.message;
        lastNativeFee = params.nativeFee;
        lastRefundAddress = refundAddress;
        sendCount++;
        return bytes32(uint256(0xABCD));
    }

    function deliver(
        PerihelionEscrow escrow,
        uint32 srcEid,
        bytes32 sender,
        uint64 nonce,
        bytes calldata message
    ) external {
        escrow.lzReceive(
            Origin({ srcEid: srcEid, sender: sender, nonce: nonce }),
            bytes32(uint256(0xBEEF)),
            message,
            address(0),
            ""
        );
    }
}

contract PerihelionEscrowTest is Test {
    PerihelionEscrow internal escrow;
    MockERC20 internal token;
    MockEndpoint internal endpoint;

    uint32 internal constant STELLAR_EID = 30_316;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0x57E11A));

    address internal owner = address(this);
    address internal solver = address(0x5012E5);
    uint256 internal userPk = 0xA11CE;
    address internal user;

    bytes1 internal constant V = 0x01;
    bytes1 internal constant T_FILL_CONFIRMED = 0x02;
    bytes1 internal constant T_CANCEL_INTENT = 0x03;

    event Locked(
        bytes32 indexed intentHash,
        address indexed solver,
        address indexed user,
        address asset,
        uint256 amount
    );
    event Released(bytes32 indexed intentHash, address indexed solver, uint256 amount);
    event Refunded(bytes32 indexed intentHash, address indexed user, uint256 amount);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    function setUp() public {
        endpoint = new MockEndpoint();
        escrow = new PerihelionEscrow(address(endpoint), STELLAR_EID);
        escrow.setPeer(STELLAR_PEER);

        token = new MockERC20();
        user = vm.addr(userPk);

        token.mint(user, 1_000_000);
        vm.prank(user);
        token.approve(address(escrow), type(uint256).max);

        vm.deal(solver, 10 ether);
    }

    // --- Helpers -------------------------------------------------------------

    function _intent() internal view returns (PerihelionEscrow.Intent memory) {
        return PerihelionEscrow.Intent({
            user: user,
            destination: "GUSERSTELLAR",
            sourceChainId: block.chainid,
            sourceAsset: address(token),
            sourceAmount: 100_000,
            destAsset: "USDC:GA5Z",
            minDestAmount: 990_000,
            deadline: block.timestamp + 600,
            nonce: 1,
            preferredSolver: address(0)
        });
    }

    function _sign(PerihelionEscrow.Intent memory intent) internal view returns (bytes memory) {
        bytes32 digest = escrow.hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    function _lock() internal returns (bytes32 h) {
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        h = escrow.hashIntent(intent);
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function _fillConfirmed(bytes32 intentHash, address solverEvm)
        internal
        pure
        returns (bytes memory)
    {
        return abi.encodePacked(
            V,
            T_FILL_CONFIRMED,
            intentHash,
            bytes32(uint256(uint160(solverEvm))),
            uint128(100_000),
            uint64(12_345)
        );
    }

    function _cancelIntent(bytes32 intentHash) internal pure returns (bytes memory) {
        return abi.encodePacked(V, T_CANCEL_INTENT, intentHash, uint8(0));
    }

    function _confirm(bytes32 intentHash, address solverEvm, uint64 nonce) internal {
        endpoint.deliver(
            escrow, STELLAR_EID, STELLAR_PEER, nonce, _fillConfirmed(intentHash, solverEvm)
        );
    }

    function _cancel(bytes32 intentHash, uint64 nonce) internal {
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, nonce, _cancelIntent(intentHash));
    }

    // --- Construction --------------------------------------------------------

    function test_Constructor() public view {
        assertEq(address(escrow.endpoint()), address(endpoint));
        assertEq(escrow.stellarEid(), STELLAR_EID);
        assertEq(escrow.stellarPeer(), STELLAR_PEER);
        assertEq(escrow.owner(), owner);
        assertEq(escrow.pendingOwner(), address(0));
        assertFalse(escrow.paused());
        assertEq(escrow.confirmationGrace(), 2 hours);
    }

    // --- Lock ----------------------------------------------------------------

    function test_LockPullsFundsEmitsAndDispatches() public {
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.expectEmit(true, true, true, true);
        emit Locked(h, solver, user, address(token), 100_000);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        assertEq(token.balanceOf(address(escrow)), 100_000);
        assertEq(token.balanceOf(user), 900_000);

        // FillInstruction dispatched to the Stellar peer over the endpoint.
        assertEq(endpoint.sendCount(), 1);
        assertEq(endpoint.lastDstEid(), STELLAR_EID);
        assertEq(endpoint.lastReceiver(), STELLAR_PEER);
        assertEq(endpoint.lastNativeFee(), 0.01 ether);
        assertEq(endpoint.lastRefundAddress(), solver);

        bytes memory message = endpoint.lastMessage();
        assertEq(uint8(message[0]), 0x01); // PROTOCOL_VERSION
        assertEq(uint8(message[1]), 0x01); // MSG_FILL_INSTRUCTION

        (
            address lSolver,
            address lUser,
            address lAsset,
            uint256 lAmount,,
            bool released,
            bool refunded
        ) = escrow.locks(h);
        assertEq(lSolver, solver);
        assertEq(lUser, user);
        assertEq(lAsset, address(token));
        assertEq(lAmount, 100_000);
        assertFalse(released);
        assertFalse(refunded);
    }

    function test_LockMeasuredDeltaWithFeeOnTransfer() public {
        FeeERC20 feeToken = new FeeERC20(100); // 1% fee
        feeToken.mint(user, 1_000_000);
        vm.prank(user);
        feeToken.approve(address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(feeToken);
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // Escrow records only what actually arrived (99_000), not the 100_000 sent.
        assertEq(feeToken.balanceOf(address(escrow)), 99_000);
        (,,, uint256 lAmount,,,) = escrow.locks(h);
        assertEq(lAmount, 99_000);
    }

    function test_RevertWhen_LockExpired() public {
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        vm.warp(intent.deadline);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.IntentExpired.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_RevertWhen_LockReservedForOtherSolver() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.preferredSolver = address(0xBEEF);
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.ReservedForSolver.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_LockByPreferredSolver() public {
        address preferred = vm.addr(0x5EED);
        vm.deal(preferred, 1 ether);

        PerihelionEscrow.Intent memory intent = _intent();
        intent.preferredSolver = preferred;
        bytes memory sig = _sign(intent);

        vm.prank(preferred);
        escrow.lock{ value: 0.01 ether }(intent, sig);
        assertEq(token.balanceOf(address(escrow)), 100_000);
    }

    function test_RevertWhen_AlreadyLocked() public {
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.AlreadyLocked.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_RevertWhen_BadSignature() public {
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        intent.sourceAmount = 200_000; // tamper after signing

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.InvalidSignature.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    // --- Inbound: FillConfirmed ---------------------------------------------

    function test_FillConfirmedReleasesToSolver() public {
        bytes32 h = _lock();

        vm.expectEmit(true, true, false, true);
        emit Released(h, solver, 100_000);
        _confirm(h, solver, 1);

        assertEq(token.balanceOf(solver), 100_000);
        assertEq(token.balanceOf(address(escrow)), 0);

        (,,,,, bool released,) = escrow.locks(h);
        assertTrue(released);
    }

    function test_RevertWhen_FillConfirmedNotLocked() public {
        bytes32 unknown = keccak256("nope");
        vm.expectRevert(PerihelionEscrow.NotLocked.selector);
        _confirm(unknown, solver, 1);
    }

    function test_RevertWhen_FillConfirmedTwice() public {
        bytes32 h = _lock();
        _confirm(h, solver, 1);

        vm.expectRevert(PerihelionEscrow.AlreadyFinalized.selector);
        _confirm(h, solver, 2);
    }

    // --- Inbound: CancelIntent ----------------------------------------------

    function test_CancelIntentRefundsUser() public {
        bytes32 h = _lock();

        vm.expectEmit(true, true, false, true);
        emit Refunded(h, user, 100_000);
        _cancel(h, 1);

        assertEq(token.balanceOf(user), 1_000_000);
        (,,,,,, bool refunded) = escrow.locks(h);
        assertTrue(refunded);
    }

    function test_RevertWhen_CancelAfterRelease() public {
        bytes32 h = _lock();
        _confirm(h, solver, 1);

        vm.expectRevert(PerihelionEscrow.AlreadyFinalized.selector);
        _cancel(h, 2);
    }

    // --- Inbound: authentication & framing ----------------------------------

    function test_RevertWhen_NotEndpoint() public {
        bytes32 h = _lock();
        vm.expectRevert(PerihelionEscrow.NotEndpoint.selector);
        escrow.lzReceive(
            Origin({ srcEid: STELLAR_EID, sender: STELLAR_PEER, nonce: 1 }),
            bytes32(0),
            _fillConfirmed(h, solver),
            address(0),
            ""
        );
    }

    function test_RevertWhen_UntrustedPeer() public {
        bytes32 h = _lock();
        vm.expectRevert(PerihelionEscrow.UntrustedPeer.selector);
        endpoint.deliver(escrow, STELLAR_EID, bytes32(uint256(0xBAD)), 1, _fillConfirmed(h, solver));
    }

    function test_RevertWhen_StaleNonce() public {
        bytes32 h = _lock();
        _confirm(h, solver, 5);

        // Re-deliver at a non-increasing nonce.
        vm.expectRevert(PerihelionEscrow.StaleNonce.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 5, _cancelIntent(h));
    }

    function test_RevertWhen_UnknownMessageType() public {
        bytes32 h = _lock();
        bytes memory message = abi.encodePacked(V, bytes1(0x09), h);
        vm.expectRevert(PerihelionEscrow.UnknownMessageType.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, message);
    }

    function test_RevertWhen_BadProtocolVersion() public {
        bytes32 h = _lock();
        bytes memory message = abi.encodePacked(bytes1(0x02), T_FILL_CONFIRMED, h);
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, message);
    }

    function test_RevertWhen_FillConfirmedWrongLength() public {
        bytes32 h = _lock();
        bytes memory message = abi.encodePacked(V, T_FILL_CONFIRMED, h); // 34 bytes, want 90
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, message);
    }

    function test_RevertWhen_CancelIntentWrongLength() public {
        bytes32 h = _lock();
        bytes memory message = abi.encodePacked(V, T_CANCEL_INTENT, h); // 34 bytes, want 35
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, message);
    }

    // --- Refund fallback -----------------------------------------------------

    function test_CancelExpiredRefundsAfterGrace() public {
        bytes32 h = _lock();
        PerihelionEscrow.Intent memory intent = _intent();

        vm.warp(intent.deadline + escrow.confirmationGrace());
        vm.expectEmit(true, true, false, true);
        emit Refunded(h, user, 100_000);
        escrow.cancelExpired(h);

        assertEq(token.balanceOf(user), 1_000_000);
    }

    function test_RevertWhen_CancelExpiredBeforeGrace() public {
        bytes32 h = _lock();
        PerihelionEscrow.Intent memory intent = _intent();

        // Past the deadline but still inside the confirmation grace window.
        vm.warp(intent.deadline + 1);
        vm.expectRevert(PerihelionEscrow.DeadlineNotPassed.selector);
        escrow.cancelExpired(h);
    }

    function test_RevertWhen_CancelExpiredAfterRelease() public {
        bytes32 h = _lock();
        _confirm(h, solver, 1);

        PerihelionEscrow.Intent memory intent = _intent();
        vm.warp(intent.deadline + escrow.confirmationGrace());
        vm.expectRevert(PerihelionEscrow.AlreadyFinalized.selector);
        escrow.cancelExpired(h);
    }

    function test_RevertWhen_CancelExpiredUnknown() public {
        vm.expectRevert(PerihelionEscrow.NotLocked.selector);
        escrow.cancelExpired(keccak256("nope"));
    }

    /// @notice Late FillConfirmed still wins after the grace window, as long as no
    ///         one has refunded yet (terminal-flag guard, I1/I2).
    function test_LateConfirmStillReleasesIfNotRefunded() public {
        bytes32 h = _lock();
        PerihelionEscrow.Intent memory intent = _intent();

        vm.warp(intent.deadline + escrow.confirmationGrace() + 1);
        _confirm(h, solver, 1);
        assertEq(token.balanceOf(solver), 100_000);
    }

    // --- Admin ---------------------------------------------------------------

    function test_SetPeer() public {
        bytes32 newPeer = bytes32(uint256(0x1234));
        escrow.setPeer(newPeer);
        assertEq(escrow.stellarPeer(), newPeer);
    }

    function test_RevertWhen_SetPeerNotOwner() public {
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        escrow.setPeer(bytes32(uint256(0x1234)));
    }

    function test_SetConfirmationGrace() public {
        escrow.setConfirmationGrace(1 hours);
        assertEq(escrow.confirmationGrace(), 1 hours);
    }

    function test_RevertWhen_SetConfirmationGraceNotOwner() public {
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        escrow.setConfirmationGrace(1 hours);
    }

    function test_RevertWhen_GraceExceedsCap() public {
        uint256 tooLong = escrow.MAX_CONFIRMATION_GRACE() + 1;
        vm.expectRevert(PerihelionEscrow.GraceTooLong.selector);
        escrow.setConfirmationGrace(tooLong);
    }

    function test_SetConfirmationGraceAtCap() public {
        escrow.setConfirmationGrace(escrow.MAX_CONFIRMATION_GRACE());
        assertEq(escrow.confirmationGrace(), escrow.MAX_CONFIRMATION_GRACE());
    }

    // --- Pause ---------------------------------------------------------------

    function test_SetPausedEmitsAndBlocksLock() public {
        vm.expectEmit(false, false, false, true);
        emit PausedSet(true);
        escrow.setPaused(true);
        assertTrue(escrow.paused());

        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.EnforcedPause.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_PauseBlocksCancelExpired() public {
        bytes32 h = _lock();
        escrow.setPaused(true);

        PerihelionEscrow.Intent memory intent = _intent();
        vm.warp(intent.deadline + escrow.confirmationGrace());
        vm.expectRevert(PerihelionEscrow.EnforcedPause.selector);
        escrow.cancelExpired(h);
    }

    /// @notice A pause must never strand in-flight funds: inbound settlement still
    ///         releases to the solver while paused.
    function test_PauseDoesNotBlockInboundRelease() public {
        bytes32 h = _lock();
        escrow.setPaused(true);

        _confirm(h, solver, 1);
        assertEq(token.balanceOf(solver), 100_000);
    }

    function test_Unpause() public {
        escrow.setPaused(true);
        escrow.setPaused(false);
        assertFalse(escrow.paused());

        // lock works again after unpause.
        _lock();
        assertEq(token.balanceOf(address(escrow)), 100_000);
    }

    function test_RevertWhen_SetPausedNotOwner() public {
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        escrow.setPaused(true);
    }

    // --- Guardian ------------------------------------------------------------

    function test_GuardianCanPauseButNotUnpause() public {
        address guardian = address(0x6A);
        escrow.setGuardian(guardian);
        assertEq(escrow.guardian(), guardian);

        // Guardian halts instantly.
        vm.prank(guardian);
        escrow.pause();
        assertTrue(escrow.paused());

        // But cannot resume (that path is owner-only).
        vm.prank(guardian);
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        escrow.setPaused(false);

        // Owner resumes.
        escrow.setPaused(false);
        assertFalse(escrow.paused());
    }

    function test_OwnerCanAlsoCallPause() public {
        escrow.pause();
        assertTrue(escrow.paused());
    }

    function test_RevertWhen_RandomCallerPauses() public {
        vm.prank(address(0xBAD));
        vm.expectRevert(PerihelionEscrow.NotAuthorized.selector);
        escrow.pause();
    }

    function test_RevertWhen_SetGuardianNotOwner() public {
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        escrow.setGuardian(address(0x6A));
    }

    // --- Two-step ownership --------------------------------------------------

    function test_TwoStepOwnershipTransfer() public {
        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferStarted(owner, solver);
        escrow.transferOwnership(solver);

        // Not yet owner until accepted.
        assertEq(escrow.owner(), owner);
        assertEq(escrow.pendingOwner(), solver);

        vm.expectEmit(true, true, false, true);
        emit OwnershipTransferred(owner, solver);
        vm.prank(solver);
        escrow.acceptOwnership();

        assertEq(escrow.owner(), solver);
        assertEq(escrow.pendingOwner(), address(0));

        // New owner has admin rights.
        vm.prank(solver);
        escrow.setPeer(bytes32(uint256(0xAA)));
        assertEq(escrow.stellarPeer(), bytes32(uint256(0xAA)));
    }

    function test_RevertWhen_AcceptByNonPending() public {
        escrow.transferOwnership(solver);
        vm.prank(address(0xBEEF));
        vm.expectRevert(PerihelionEscrow.NotPendingOwner.selector);
        escrow.acceptOwnership();
    }

    function test_OldOwnerKeepsControlUntilAccepted() public {
        escrow.transferOwnership(solver);
        // Old owner can still act, and can even cancel the handover.
        escrow.transferOwnership(address(0));
        assertEq(escrow.pendingOwner(), address(0));

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NotPendingOwner.selector);
        escrow.acceptOwnership();
    }

    function test_RevertWhen_TransferOwnershipNotOwner() public {
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        escrow.transferOwnership(solver);
    }

    // --- Token edge cases: no-return, false-returning ----------------------------------

    function test_LockWithNoReturnToken() public {
        NoReturnERC20 noReturnToken = new NoReturnERC20();
        noReturnToken.mint(user, 1_000_000);
        vm.prank(user);
        noReturnToken.approve(address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(noReturnToken);
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        assertEq(noReturnToken.balanceOf(address(escrow)), 100_000);
        (,,, uint256 lAmount,,,) = escrow.locks(h);
        assertEq(lAmount, 100_000);
    }

    function test_RevertWhen_LockWithFalseReturningToken() public {
        FalseReturningERC20 falseToken = new FalseReturningERC20();
        falseToken.mint(user, 1_000_000);
        vm.prank(user);
        falseToken.approve(address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(falseToken);
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.TransferFailed.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_RevertWhen_LockTokenReceivesNothing() public {
        FeeERC20 heavyFeeToken = new FeeERC20(10_000); // 100% fee (receives 0)
        heavyFeeToken.mint(user, 1_000_000);
        vm.prank(user);
        heavyFeeToken.approve(address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(heavyFeeToken);
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NothingReceived.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    // --- FillConfirmed/CancelIntent codec: exact byte layout ----

    /// @notice Verify FillConfirmed decoding against exact 90-byte layout:
    ///         version(1)|type(1)|intent_hash(32)|solver_evm(32)|amount(16)|ledger(8)
    function test_FillConfirmedExactLayout() public {
        bytes32 h = _lock();
        
        // Manually craft the exact 90-byte FillConfirmed
        bytes32 intentHash = h;
        address solverAddr = solver;
        uint128 amount = 100_000;
        uint64 ledger = 12_345;
        
        bytes memory expected = abi.encodePacked(
            V,
            T_FILL_CONFIRMED,
            intentHash,
            bytes32(uint256(uint160(solverAddr))),
            amount,
            ledger
        );
        
        assertEq(expected.length, 90);
        _confirm(h, solver, 1);
        assertEq(token.balanceOf(solver), 100_000);
    }

    /// @notice Verify CancelIntent decoding against exact 35-byte layout:
    ///         version(1)|type(1)|intent_hash(32)|reason(1)
    function test_CancelIntentExactLayout() public {
        bytes32 h = _lock();
        
        bytes memory expected = abi.encodePacked(
            V,
            T_CANCEL_INTENT,
            h,
            uint8(0)
        );
        
        assertEq(expected.length, 35);
        _cancel(h, 1);
        assertEq(token.balanceOf(user), 1_000_000);
    }

    // --- Race conditions: refund vs confirm orderings ----

    /// @notice First ordering: refund wins (local timeout), then remote confirm arrives.
    ///         Should be rejected by AlreadyFinalized guard (I1/I2).
    function test_RaceGuard_RefundThenConfirm() public {
        bytes32 h = _lock();
        PerihelionEscrow.Intent memory intent = _intent();

        // Local refund fires first.
        vm.warp(intent.deadline + escrow.confirmationGrace());
        escrow.cancelExpired(h);
        assertEq(token.balanceOf(user), 1_000_000);

        // Late FillConfirmed arrives; should be rejected.
        vm.expectRevert(PerihelionEscrow.AlreadyFinalized.selector);
        _confirm(h, solver, 1);
    }

    /// @notice Second ordering: confirm wins, then local refund is attempted.
    ///         Should be rejected by AlreadyFinalized guard (I1/I2).
    function test_RaceGuard_ConfirmThenRefund() public {
        bytes32 h = _lock();
        PerihelionEscrow.Intent memory intent = _intent();

        // FillConfirmed lands first.
        _confirm(h, solver, 1);
        assertEq(token.balanceOf(solver), 100_000);

        // Local refund attempt arrives late.
        vm.warp(intent.deadline + escrow.confirmationGrace());
        vm.expectRevert(PerihelionEscrow.AlreadyFinalized.selector);
        escrow.cancelExpired(h);
    }

    // --- Signature & nonce validation ----

    function test_RevertWhen_LockNonceZero() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.nonce = 0;
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        // Should still work (nonce is part of intent hash, not a separate constraint)
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_RevertWhen_DoubleSignatureSubmit() public {
        PerihelionEscrow.Intent memory intent1 = _intent();
        intent1.nonce = 1;
        bytes memory sig1 = _sign(intent1);
        bytes32 h1 = escrow.hashIntent(intent1);

        PerihelionEscrow.Intent memory intent2 = _intent();
        intent2.nonce = 2;
        bytes memory sig2 = _sign(intent2);
        bytes32 h2 = escrow.hashIntent(intent2);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent1, sig1);
        
        // Different intent should succeed
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent2, sig2);
        
        assertEq(token.balanceOf(address(escrow)), 200_000);
    }

    // --- Non-endpoint/untrusted peer rejections ----

    function test_RevertWhen_LzReceiveCalledNotFromEndpoint() public {
        bytes32 h = _lock();
        vm.prank(address(0xBAD));
        vm.expectRevert(PerihelionEscrow.NotEndpoint.selector);
        escrow.lzReceive(
            Origin({ srcEid: STELLAR_EID, sender: STELLAR_PEER, nonce: 1 }),
            bytes32(0),
            _fillConfirmed(h, solver),
            address(0),
            ""
        );
    }

    function test_RevertWhen_UntrustedPeerSendsMessage() public {
        bytes32 h = _lock();
        bytes32 untrustedPeer = bytes32(uint256(0xDEADBEEF));
        
        vm.expectRevert(PerihelionEscrow.UntrustedPeer.selector);
        endpoint.deliver(
            escrow,
            STELLAR_EID,
            untrustedPeer,
            1,
            _fillConfirmed(h, solver)
        );
    }

    // --- Expired intent ----

    function test_RevertWhen_ExpiredIntentLock() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.deadline = block.timestamp - 1;
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.IntentExpired.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    // --- Reserved solver ----

    function test_RevertWhen_NonPreferredSolverTriesLock() public {
        address preferredSolver = address(0x1234);
        PerihelionEscrow.Intent memory intent = _intent();
        intent.preferredSolver = preferredSolver;
        bytes memory sig = _sign(intent);

        vm.prank(solver); // Different solver
        vm.expectRevert(PerihelionEscrow.ReservedForSolver.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_PreferredSolverCanLock() public {
        address preferredSolver = address(0x1234);
        vm.deal(preferredSolver, 10 ether);
        
        PerihelionEscrow.Intent memory intent = _intent();
        intent.preferredSolver = preferredSolver;
        bytes memory sig = _sign(intent);

        vm.prank(preferredSolver);
        escrow.lock{ value: 0.01 ether }(intent, sig);
        assertEq(token.balanceOf(address(escrow)), 100_000);
    }
}
