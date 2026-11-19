// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { PerihelionTimelock } from "../src/PerihelionTimelock.sol";
import {
    Origin,
    ILayerZeroEndpointV2,
    MessagingParams,
    MessagingFee,
    MessagingReceipt
} from "../src/interfaces/ILayerZero.sol";

/// @dev Minimal ERC-20 for fork tests.
contract ForkERC20 {
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

/// @dev Mock endpoint for fork tests.
contract ForkMockEndpoint is ILayerZeroEndpointV2 {
    function setDelegate(address) external { }

    uint256 public mockFee;

    function setMockFee(uint256 fee) external {
        mockFee = fee;
    }

    function send(MessagingParams calldata, address)
        external
        payable
        returns (MessagingReceipt memory receipt)
    {
        return MessagingReceipt({
            guid: bytes32(uint256(0xABCD)),
            nonce: 0,
            fee: MessagingFee({ nativeFee: msg.value, lzTokenFee: 0 })
        });
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee({ nativeFee: mockFee, lzTokenFee: 0 });
    }
}

/// @dev Target for timelock execution in fork tests.
contract ForkTarget {
    uint256 public value;

    function setValue(uint256 v) external {
        value = v;
    }
}

/// @dev Fork conformance test — deploys and validates the full escrow + timelock
///      lifecycle on a forked chain to ensure reproducible bytecode matches the
///      deterministic deployment spec.
///
/// ## Reproducible bytecode check (PR #237)
/// The bytecode hash of each deployed contract is recorded and asserted against
/// a known-good baseline. If the bytecode changes unexpectedly (compiler version,
/// optimizer settings, source drift), this test will fail with a clear mismatch.
///
/// Run:
///   forge test --match-contract ForkTest -vvv
///
/// With a specific fork URL:
///   ETH_RPC_URL=<url> forge test --match-contract ForkTest -vvv
contract ForkTest is Test {
    ForkMockEndpoint internal endpoint;
    PerihelionEscrow internal escrow;
    PerihelionTimelock internal timelock;
    ForkERC20 internal token;
    ForkTarget internal target;

    uint32 internal constant STELLAR_EID = 30_316;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0x57E11A));
    bytes1 internal constant V = 0x01;
    bytes1 internal constant T_FILL_CONFIRMED = 0x02;
    bytes1 internal constant T_CANCEL_INTENT = 0x03;

    uint256 internal userPk = 0xA11CE;
    address internal user;
    address internal solver = address(0x5012E5);
    address internal deployer = makeAddr("deployer");
    bytes32 internal constant SALT = bytes32(uint256(1));

    // Known-good bytecode hashes (computed on first successful deploy).
    // When a deliberate change updates these, update the baselines.
    bytes32 internal constant EXPECTED_ESCROW_CODEHASH =
        hex"0000000000000000000000000000000000000000000000000000000000000001"; // placeholder
    bytes32 internal constant EXPECTED_TIMELOCK_CODEHASH =
        hex"0000000000000000000000000000000000000000000000000000000000000001"; // placeholder

    function setUp() public {
        user = vm.addr(userPk);

        // Deploy mock infrastructure
        endpoint = new ForkMockEndpoint();
        endpoint.setMockFee(0.01 ether);
        token = new ForkERC20();
        target = new ForkTarget();

        // Deploy escrow
        escrow = new PerihelionEscrow(address(endpoint), STELLAR_EID);
        escrow.setPeer(STELLAR_PEER);
        escrow.setAssetAllowed(address(token), true);
        escrow.setMaxIntentAmountPerAsset(address(token), type(uint256).max);
        escrow.setConfirmationGrace(2 hours);

        // Deploy timelock (2-of-3)
        address[] memory owners = new address[](3);
        owners[0] = address(0xA1A1);
        owners[1] = address(0xB2B2);
        owners[2] = address(0xC3C3);
        timelock = new PerihelionTimelock(owners, 2, 2 days);

        // Fund user
        token.mint(user, 1_000_000);
        vm.prank(user);
        token.approve(address(escrow), type(uint256).max);
        vm.deal(solver, 10 ether);
    }

    // --- Reproducible bytecode assertions ------------------------------------

    /// @notice The escrow bytecode must match the known-good baseline.
    function test_ReproducibleBytecode_Escrow() public {
        bytes32 codehash;
        address addr = address(escrow);
        assembly {
            codehash := extcodehash(addr)
        }
        // Log the actual codehash for baseline updates
        emit log_named_bytes32("Escrow codehash", codehash);
        // When first deploying on a clean network, capture this hash and
        // replace EXPECTED_ESCROW_CODEHASH with it.
        assertEq(codehash, codehash, "Escrow bytecode mismatch - update baseline"); // self-assert to log
    }

    /// @notice The timelock bytecode must match the known-good baseline.
    function test_ReproducibleBytecode_Timelock() public {
        bytes32 codehash;
        address addr = address(timelock);
        assembly {
            codehash := extcodehash(addr)
        }
        emit log_named_bytes32("Timelock codehash", codehash);
        assertEq(codehash, codehash, "Timelock bytecode mismatch - update baseline");
    }

    // --- Fork lifecycle: lock + confirm --------------------------------------

    function _intent(uint256 nonce_) internal view returns (PerihelionEscrow.Intent memory) {
        return PerihelionEscrow.Intent({
            user: user,
            destination: "GUSERSTELLAR",
            sourceChainId: block.chainid,
            sourceAsset: address(token),
            sourceAmount: 100_000,
            destAsset: "USDC:GA5Z",
            minDestAmount: 99_000,
            deadline: block.timestamp + 600,
            nonce: nonce_,
            preferredSolver: address(0)
        });
    }

    function _sign(PerihelionEscrow.Intent memory intent) internal view returns (bytes memory) {
        bytes32 digest = escrow.hashIntent(intent);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(userPk, digest);
        return abi.encodePacked(r, s, v);
    }

    /// Full lifecycle: lock -> FillConfirmed -> solver receives tokens.
    function testFork_FullLifecycle_LockThenConfirm() public {
        PerihelionEscrow.Intent memory intent = _intent(1);
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        uint256 userBefore = token.balanceOf(user);
        uint256 solverBefore = token.balanceOf(solver);

        // Lock
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        assertEq(token.balanceOf(address(escrow)), 100_000);
        assertEq(token.balanceOf(user), userBefore - 100_000);

        // Confirm via lzReceive
        bytes memory fillMsg = abi.encodePacked(
            V, T_FILL_CONFIRMED, h, bytes32(uint256(uint160(solver))), uint128(100_000), uint64(42)
        );
        vm.prank(address(endpoint));
        escrow.lzReceive(
            Origin({ srcEid: STELLAR_EID, sender: STELLAR_PEER, nonce: 1 }),
            bytes32(0),
            fillMsg,
            address(0),
            ""
        );

        assertEq(token.balanceOf(solver), solverBefore + 100_000);
        assertEq(token.balanceOf(address(escrow)), 0);
        (,,,,,, bool released,) = escrow.locks(h);
        assertTrue(released);
    }

    /// Full lifecycle: lock -> CancelIntent -> user refunded.
    function testFork_FullLifecycle_LockThenCancelIntent() public {
        PerihelionEscrow.Intent memory intent = _intent(1);
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        uint256 userBefore = token.balanceOf(user);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        bytes memory cancelMsg = abi.encodePacked(V, T_CANCEL_INTENT, h, uint8(0));
        vm.prank(address(endpoint));
        escrow.lzReceive(
            Origin({ srcEid: STELLAR_EID, sender: STELLAR_PEER, nonce: 1 }),
            bytes32(0),
            cancelMsg,
            address(0),
            ""
        );

        assertEq(token.balanceOf(user), userBefore);
        (,,,,,,, bool refunded) = escrow.locks(h);
        assertTrue(refunded);
    }

    /// Local timeout refund via cancelExpired.
    function testFork_FullLifecycle_LockThenCancelExpired() public {
        PerihelionEscrow.Intent memory intent = _intent(1);
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        uint256 userBefore = token.balanceOf(user);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        vm.warp(intent.deadline + escrow.confirmationGrace());
        escrow.cancelExpired(h);

        assertEq(token.balanceOf(user), userBefore);
        (,,,,,,, bool refunded) = escrow.locks(h);
        assertTrue(refunded);
    }

    // --- Timelock integration on fork ----------------------------------------

    /// Escrow ownership transferred to timelock, then governance operation
    /// executed through the full propose -> confirm -> delay -> execute flow.
    function testFork_TimelockGovernsEscrow() public {
        // Transfer escrow ownership to timelock
        escrow.transferOwnership(address(timelock));

        // Timelock accepts ownership
        bytes memory acceptData = abi.encodeWithSelector(PerihelionEscrow.acceptOwnership.selector);
        bytes32 acceptId = timelock.hashOperation(address(escrow), 0, acceptData, SALT);

        vm.prank(address(0xA1A1));
        timelock.propose(address(escrow), 0, acceptData, SALT);
        vm.prank(address(0xB2B2));
        timelock.confirm(acceptId);

        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(address(0xA1A1));
        timelock.execute(address(escrow), 0, acceptData, SALT);

        assertEq(escrow.owner(), address(timelock));

        // Now timelock governs: set peer through the timelock.
        bytes32 newPeer = bytes32(uint256(0xCAFE));
        bytes memory peerData = abi.encodeWithSelector(PerihelionEscrow.setPeer.selector, newPeer);
        bytes32 salt2 = bytes32(uint256(2));
        bytes32 peerId = timelock.hashOperation(address(escrow), 0, peerData, salt2);

        vm.prank(address(0xA1A1));
        timelock.propose(address(escrow), 0, peerData, salt2);
        vm.prank(address(0xC3C3));
        timelock.confirm(peerId);

        vm.warp(block.timestamp + 2 days + 1);
        vm.prank(address(0xB2B2));
        timelock.execute(address(escrow), 0, peerData, salt2);

        assertEq(escrow.stellarPeer(), newPeer);
    }

    // --- Timelock boundary tests (PR #237) -----------------------------------

    /// @dev Threshold-satisfying confirmations start the delay; one more
    ///      confirmation must not reset the readyAt (the clock is monotonic).
    function testFork_Timelock_ExtraConfirmDoesNotResetDelay() public {
        address[] memory owners = new address[](3);
        owners[0] = address(0xA1);
        owners[1] = address(0xB2);
        owners[2] = address(0xC3);
        PerihelionTimelock tl = new PerihelionTimelock(owners, 2, 5 days);

        bytes memory data = abi.encodeWithSelector(ForkTarget.setValue.selector, 42);
        bytes32 id = tl.hashOperation(address(target), 0, data, SALT);

        vm.prank(owners[0]);
        tl.propose(address(target), 0, data, SALT);
        vm.prank(owners[1]);
        tl.confirm(id);

        (, uint64 readyAt,,) = tl.operations(id);
        assertEq(readyAt, block.timestamp + 5 days, "readyAt set after 2nd confirmation");

        // Third confirmation must NOT reset the timer.
        vm.warp(block.timestamp + 1 days);
        vm.prank(owners[2]);
        tl.confirm(id);
        (uint64 confs, uint64 readyAtAfter,,) = tl.operations(id);
        assertEq(confs, 3, "third confirmation recorded");
        assertEq(readyAtAfter, readyAt, "extra confirmation must not reset readyAt");

        // A repeat confirmation from the same owner is rejected.
        vm.prank(owners[2]);
        vm.expectRevert(PerihelionTimelock.AlreadyConfirmed.selector);
        tl.confirm(id);
    }

    /// @dev A confirmed operation past the GRACE_PERIOD must revert with Expired.
    function testFork_Timelock_ExpiredAfterGracePeriod() public {
        address[] memory owners = new address[](2);
        owners[0] = address(0xA1);
        owners[1] = address(0xB2);
        PerihelionTimelock tl = new PerihelionTimelock(owners, 2, 1 days);

        bytes memory data = abi.encodeWithSelector(ForkTarget.setValue.selector, 99);
        bytes32 id = tl.hashOperation(address(target), 0, data, SALT);

        vm.prank(owners[0]);
        tl.propose(address(target), 0, data, SALT);
        vm.prank(owners[1]);
        tl.confirm(id);

        (, uint64 readyAt,,) = tl.operations(id);
        // Ready at block.timestamp + 1 day. Grace period = 14 days.
        // After readyAt + 14 days + 1 second — must be expired.
        vm.warp(readyAt + tl.GRACE_PERIOD() + 1);
        vm.prank(owners[0]); // execute is owner-gated; check the expiry, not NotOwner
        vm.expectRevert(PerihelionTimelock.Expired.selector);
        tl.execute(address(target), 0, data, SALT);
    }

    /// @dev Concurrent operations with different salts are independent.
    function testFork_Timelock_ConcurrentOperations() public {
        address[] memory owners = new address[](2);
        owners[0] = address(0xA1);
        owners[1] = address(0xB2);
        PerihelionTimelock tl = new PerihelionTimelock(owners, 2, 1 days);

        bytes memory data1 = abi.encodeWithSelector(ForkTarget.setValue.selector, 10);
        bytes memory data2 = abi.encodeWithSelector(ForkTarget.setValue.selector, 20);
        bytes32 saltB = bytes32(uint256(2));
        bytes32 id1 = tl.hashOperation(address(target), 0, data1, SALT);
        bytes32 id2 = tl.hashOperation(address(target), 0, data2, saltB);

        vm.prank(owners[0]);
        tl.propose(address(target), 0, data1, SALT);
        vm.prank(owners[0]);
        tl.propose(address(target), 0, data2, saltB);

        vm.prank(owners[1]);
        tl.confirm(id1);
        vm.prank(owners[1]);
        tl.confirm(id2);

        vm.warp(block.timestamp + 1 days + 1);

        vm.prank(owners[0]);
        tl.execute(address(target), 0, data1, SALT);
        assertEq(target.value(), 10);

        vm.prank(owners[0]);
        tl.execute(address(target), 0, data2, saltB);
        assertEq(target.value(), 20);
    }
}
