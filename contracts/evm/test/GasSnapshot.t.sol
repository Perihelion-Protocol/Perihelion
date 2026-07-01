// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { PerihelionTimelock } from "../src/PerihelionTimelock.sol";
import { IERC20 } from "../src/IERC20.sol";
import {
    Origin,
    ILayerZeroEndpoint,
    MessagingParams,
    MessagingFee
} from "../src/interfaces/ILayerZero.sol";

/// @dev Minimal mock ERC-20 for gas snapshot tests.
contract GasSnapshotERC20 is IERC20 {
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

/// @dev Mock endpoint for gas snapshot tests.
contract GasSnapshotEndpoint is ILayerZeroEndpoint {
    uint256 public mockFee;

    function setMockFee(uint256 fee) external {
        mockFee = fee;
    }

    function send(MessagingParams calldata, address) external payable returns (bytes32) {
        return bytes32(uint256(0xABCD));
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee({ nativeFee: mockFee, lzTokenFee: 0 });
    }
}

/// @dev Target contract for timelock execute gas snapshot.
contract GasSnapshotTarget {
    uint256 public value;

    function setValue(uint256 v) external payable {
        value = v;
    }
}

/// @dev Gas snapshot tests for hot paths. Run with `forge snapshot`.
///      These tests establish baselines for gas cost of critical operations:
///      - lock
///      - lzReceive (FillConfirmed and CancelIntent)
///      - cancelExpired
///      - timelock execute
contract GasSnapshotTest is Test {
    PerihelionEscrow internal escrow;
    PerihelionTimelock internal timelock;
    GasSnapshotERC20 internal token;
    GasSnapshotEndpoint internal endpoint;
    GasSnapshotTarget internal target;

    uint32 internal constant STELLAR_EID = 30_316;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0x57E11A));

    address internal solver = address(0x5012E5);
    uint256 internal userPk = 0xA11CE;
    address internal user = address(0);

    bytes1 internal constant V = 0x01;
    bytes1 internal constant T_FILL_CONFIRMED = 0x02;
    bytes1 internal constant T_CANCEL_INTENT = 0x03;
    bytes32 internal constant SALT = bytes32(uint256(1));

    function setUp() public {
        endpoint = new GasSnapshotEndpoint();
        endpoint.setMockFee(0.01 ether);
        escrow = new PerihelionEscrow(address(endpoint), STELLAR_EID);
        escrow.setPeer(STELLAR_PEER);

        token = new GasSnapshotERC20();
        target = new GasSnapshotTarget();

        user = vm.addr(userPk);
        token.mint(user, 1_000_000);
        vm.prank(user);
        token.approve(address(escrow), type(uint256).max);

        vm.deal(solver, 10 ether);
    }

    function _intent() internal view returns (PerihelionEscrow.Intent memory) {
        return PerihelionEscrow.Intent({
            user: user,
            destination: "GUSERSTELLAR",
            sourceChainId: block.chainid,
            sourceAsset: address(token),
            sourceAmount: 100_000,
            destAsset: "USDC:GA5Z",
            minDestAmount: 99_000,
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

    /// @notice Base gas cost for lock operation (pull + store + send).
    function testGas_lock() public {
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        // Gas emitted via forge snapshot
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    /// @notice Gas cost for lzReceive processing FillConfirmed (release).
    function testGas_lzReceive_fillConfirmed() public {
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        // Initial lock
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // Inbound FillConfirmed via lzReceive
        bytes memory message = _fillConfirmed(h, solver);
        vm.prank(address(endpoint));
        // Gas emitted via forge snapshot
        escrow.lzReceive(
            Origin({ srcEid: STELLAR_EID, sender: STELLAR_PEER, nonce: 1 }),
            bytes32(0),
            message,
            address(0),
            ""
        );
    }

    /// @notice Gas cost for lzReceive processing CancelIntent (refund).
    function testGas_lzReceive_cancelIntent() public {
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        // Initial lock
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // Inbound CancelIntent via lzReceive
        bytes memory message = _cancelIntent(h);
        vm.prank(address(endpoint));
        // Gas emitted via forge snapshot
        escrow.lzReceive(
            Origin({ srcEid: STELLAR_EID, sender: STELLAR_PEER, nonce: 1 }),
            bytes32(0),
            message,
            address(0),
            ""
        );
    }

    /// @notice Gas cost for local timeout refund via cancelExpired.
    function testGas_cancelExpired() public {
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        // Initial lock
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // Advance past deadline + grace
        vm.warp(intent.deadline + escrow.confirmationGrace());

        // Gas emitted via forge snapshot
        escrow.cancelExpired(h);
    }

    /// @notice Gas cost for timelock execute operation.
    function testGas_timelockExecute() public {
        address[] memory owners = new address[](3);
        owners[0] = address(0xA1);
        owners[1] = address(0xB2);
        owners[2] = address(0xC3);
        timelock = new PerihelionTimelock(owners, 2, 2 days);

        bytes memory data = abi.encodeWithSelector(GasSnapshotTarget.setValue.selector, 42);
        bytes32 id = timelock.hashOperation(address(target), 0, data, bytes32(uint256(1)));

        vm.prank(owners[0]);
        timelock.propose(address(target), 0, data, SALT);

        vm.prank(owners[1]);
        timelock.confirm(id);

        vm.warp(block.timestamp + 2 days);

        // Advance to ready time + grace period end (within GRACE_PERIOD)
        (, uint64 readyAt,,) = timelock.operations(id);
        vm.warp(readyAt + 1);

        vm.prank(owners[0]);
        // Gas emitted via forge snapshot
        timelock.execute(address(target), 0, data, SALT);
    }
}
