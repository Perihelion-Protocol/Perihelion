// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { IERC20 } from "../src/IERC20.sol";
import { Origin, MessagingParams, MessagingFee, ILayerZeroEndpoint } from "../src/interfaces/ILayerZero.sol";

/// @notice Fork tests validating the escrow against a real LayerZero endpoint
///         and real ERC-20s (USDC, USDT) on a forked network.
///
/// Gated on FORK_RPC_URL being set; skipped entirely if absent. Run with:
///     export FORK_RPC_URL=<mainnet-rpc-url>
///     forge test --match-contract ForkTest -vvv
///
/// These tests are NOT part of the default CI and are designed for scheduled
/// or manual execution to catch integration mismatches the mocks paper over.
contract ForkTest is Test {
    // Ethereum mainnet addresses (LayerZero V2, USDC, USDT).
    address internal constant LZ_ENDPOINT  = 0x1a44076050125825900e736c501f859c50fE728c;
    address internal constant USDC         = 0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48;
    address internal constant USDT         = 0xdAC17F958D2ee523a2206206994597C13D831ec7;
    uint32  internal constant STELLAR_EID  = 30_316;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0x57E11A));

    PerihelionEscrow internal escrow;

    address internal owner = address(this);
    address internal solver = address(0x5012E5);
    uint256 internal userPk = 0xA11CE;
    address internal user;

    event Locked(bytes32 indexed intentHash, address indexed solver, address indexed user, address asset, uint256 amount);
    event Refunded(bytes32 indexed intentHash, address indexed user, uint256 amount, uint8 reason);

    modifier onlyWithFork() {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            return;
        }
        _;
    }

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) {
            return;
        }
        vm.createSelectFork(rpc);

        escrow = new PerihelionEscrow(LZ_ENDPOINT, STELLAR_EID);
        escrow.setPeer(STELLAR_PEER);

        user = vm.addr(userPk);
        // Fund solver with ETH for LZ fees.
        vm.deal(solver, 10 ether);
    }

    // --- Helpers -----------------------------------------------------------

    function _intent(address asset) internal view returns (PerihelionEscrow.Intent memory) {
        return PerihelionEscrow.Intent({
            user: user,
            destination: "GUSERSTELLAR",
            sourceChainId: block.chainid,
            sourceAsset: asset,
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

    // --- Real ERC-20 tests ------------------------------------------------

    function _approve(address token, address spender, uint256 amount) internal {
        (bool ok,) = token.call(abi.encodeWithSelector(bytes4(keccak256("approve(address,uint256)")), spender, amount));
        require(ok, "approve failed");
    }

    /// @notice Lock with real USDC on a fork: verifies that the transfer-from
    ///         succeeds and the lock event fires with the correct amount.
    function test_LockWithRealUSDC() public onlyWithFork {
        deal(USDC, user, 1_000_000);
        vm.prank(user);
        _approve(USDC, address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent(USDC);
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.expectEmit(true, true, true, true);
        emit Locked(h, solver, user, USDC, 100_000);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    /// @notice Lock with real USDT on a fork: USDT's non-standard transferFrom
    ///         (no return value) exercises the low-level call path in
    ///         _safeTransferFrom.
    function test_LockWithRealUSDT() public onlyWithFork {
        deal(USDT, user, 1_000_000);
        vm.prank(user);
        _approve(USDT, address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent(USDT);
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.expectEmit(true, true, true, true);
        emit Locked(h, solver, user, USDT, 100_000);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    /// @notice Lock with insufficient fee: the real endpoint's quote is
    ///         non-zero, so a solver sending 0 should revert FeeTooLow.
    function test_RevertWhen_LockFeeTooLowOnRealEndpoint() public onlyWithFork {
        deal(USDC, user, 1_000_000);
        vm.prank(user);
        _approve(USDC, address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent(USDC);
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.FeeTooLow.selector);
        escrow.lock{ value: 0 }(intent, sig);
    }

    /// @notice Lock with real USDC: verify measured-delta records the correct
    ///         amount. Since USDC is not fee-on-transfer, the recorded amount
    ///         equals the requested amount (subject to 6-decimal precision).
    function test_MeasuredDeltaOnMainnet_USDC() public onlyWithFork {
        deal(USDC, user, 1_000_000);
        vm.prank(user);
        _approve(USDC, address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent(USDC);
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        (,,, uint256 lAmount,,,) = escrow.locks(h);
        assertEq(lAmount, 100_000);
    }

    /// @notice Endpoint authority: verify that lzReceive called directly (not
    ///         from the endpoint) reverts with NotEndpoint, confirming the
    ///         real endpoint would be the sole caller.
    function test_RevertWhen_LzReceiveNotFromRealEndpoint() public onlyWithFork {
        address attacker = address(0xBEEF);
        vm.prank(attacker);
        vm.expectRevert(PerihelionEscrow.NotEndpoint.selector);
        escrow.lzReceive(
            Origin({ srcEid: STELLAR_EID, sender: STELLAR_PEER, nonce: 1 }),
            bytes32(0),
            "",
            address(0),
            ""
        );
    }
}
