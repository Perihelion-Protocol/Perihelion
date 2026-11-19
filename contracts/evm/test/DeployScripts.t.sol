// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { PerihelionTimelock } from "../src/PerihelionTimelock.sol";
import { Deploy } from "../script/Deploy.s.sol";
import { VerifyDeployment } from "../script/VerifyDeployment.s.sol";
import { AcceptOwnership } from "../script/AcceptOwnership.s.sol";
import { DeployConfig } from "../script/lib/DeployConfig.sol";
import { MockEndpoint, MockERC20 } from "./PerihelionEscrow.t.sol";

/// @dev Covers the deployment scripts (issue #1047). Tests call the scripts' env-free
///      entry points directly. `vm.setEnv` writes the process-wide environment, which
///      races when forge runs tests in parallel, so these tests never touch it.
contract DeployScriptsTest is Test {
    // Fixed addresses referenced by test/fixtures/deploy/*.json.
    address internal constant ASSET = address(0xc1);
    address internal constant TIMELOCK = address(0x7E11);
    uint32 internal constant STELLAR_EID = 30_111;

    MockEndpoint internal endpoint;

    function setUp() public {
        // Rolling-window durations must not exceed block.timestamp; forge starts at t=1.
        vm.warp(1_000_000);
        endpoint = new MockEndpoint();
        // Allowlisting requires contract code at the asset address.
        vm.etch(ASSET, address(new MockERC20()).code);
    }

    function _deploy(string memory cfgPath) internal returns (PerihelionEscrow) {
        return new Deploy().deploy(address(endpoint), STELLAR_EID, DeployConfig.load(cfgPath));
    }

    function _verifier() internal returns (VerifyDeployment) {
        return new VerifyDeployment();
    }

    // --- Deploy --------------------------------------------------------------

    function test_Deploy_AppliesFullConfigBeforeNominatingOwner() public {
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/full.json");

        assertEq(escrow.stellarPeer(), bytes32(uint256(0xabc)));
        assertEq(escrow.guardian(), address(0xa1));
        assertEq(escrow.confirmationGrace(), 7200);
        assertEq(escrow.rollingWindowDuration(), 86400);
        assertTrue(escrow.assetAllowed(ASSET));
        assertEq(escrow.maxIntentAmountPerAsset(ASSET), 1_000_000);
        assertEq(escrow.rollingWindowCapPerAsset(ASSET), 5_000_000);
        assertEq(escrow.pendingOwner(), TIMELOCK, "owner must be nominated, not yet transferred");
    }

    function test_Deploy_NoAssetsLeavesAllowlistEmpty() public {
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/no_assets.json");
        assertFalse(escrow.assetAllowed(ASSET));
        assertEq(escrow.pendingOwner(), address(0));
    }

    function test_Config_RevertsWhenPeerMissing() public {
        ConfigHarness harness = new ConfigHarness();
        vm.expectRevert(bytes("DeployConfig: missing peer"));
        harness.load("test/fixtures/deploy/missing_peer.json");
    }

    // --- Verify --------------------------------------------------------------

    function test_Verify_PassesForFullyConfiguredEscrow() public {
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/full.json");
        // Simulate the timelock completing the handover.
        vm.prank(TIMELOCK);
        escrow.acceptOwnership();

        VerifyDeployment verifier = _verifier();
        verifier.verify(escrow, DeployConfig.load("test/fixtures/deploy/full.json"), TIMELOCK);
    }

    function test_Verify_FailsWhenAssetNotAllowlisted() public {
        // Deployed without assets, verified against a config that requires one.
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/no_assets.json");
        DeployConfig.Config memory cfg = DeployConfig.load("test/fixtures/deploy/full.json");
        VerifyDeployment verifier = _verifier();

        vm.expectRevert(bytes("VerifyDeployment: asset is not allowlisted"));
        verifier.verify(escrow, cfg, address(0));
    }

    function test_Verify_FailsWhenCapDiffersFromConfig() public {
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/full.json");
        DeployConfig.Config memory cfg =
            DeployConfig.load("test/fixtures/deploy/mismatched_cap.json");
        VerifyDeployment verifier = _verifier();

        vm.expectRevert(bytes("VerifyDeployment: rolling-window cap does not match config"));
        verifier.verify(escrow, cfg, address(0));
    }

    function test_Verify_FailsWhenOwnerIsNotTimelock() public {
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/full.json");
        DeployConfig.Config memory cfg = DeployConfig.load("test/fixtures/deploy/full.json");
        VerifyDeployment verifier = _verifier();

        // Still pending (not accepted), so owner != timelock.
        vm.expectRevert(bytes("VerifyDeployment: owner is not the timelock"));
        verifier.verify(escrow, cfg, TIMELOCK);
    }

    // --- Handover calldata ---------------------------------------------------

    function test_AcceptOwnership_BuildsHandoverOperations() public {
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/full.json");

        PerihelionTimelock tl = _timelock();
        // The fixed owner address needs timelock code to be used as a PerihelionTimelock.
        vm.etch(TIMELOCK, address(tl).code);
        AcceptOwnership handover = new AcceptOwnership();

        AcceptOwnership.Op[] memory ops =
            handover.build(escrow, PerihelionTimelock(payable(TIMELOCK)), bytes32(0));
        assertEq(ops.length, 2);
        assertEq(ops[0].target, address(escrow));
        assertEq(ops[0].data, abi.encodeCall(PerihelionEscrow.acceptOwnership, ()));
        assertEq(ops[1].data, abi.encodeCall(PerihelionEscrow.setEndpointDelegate, (TIMELOCK)));
    }

    function test_AcceptOwnership_RevertsWhenTimelockNotPending() public {
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/no_assets.json");
        AcceptOwnership handover = new AcceptOwnership();

        vm.expectRevert(bytes("AcceptOwnership: timelock is not the pending owner"));
        handover.build(escrow, PerihelionTimelock(payable(TIMELOCK)), bytes32(0));
    }

    // --- setEndpointDelegate -------------------------------------------------

    function test_SetEndpointDelegate_OwnerOnly() public {
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/no_assets.json");
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        vm.prank(address(0xBAD));
        escrow.setEndpointDelegate(TIMELOCK);
    }

    function test_SetEndpointDelegate_RejectsZero() public {
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/no_assets.json");
        vm.prank(escrow.owner());
        vm.expectRevert(PerihelionEscrow.ZeroAddress.selector);
        escrow.setEndpointDelegate(address(0));
    }

    function test_SetEndpointDelegate_EmitsEvent() public {
        PerihelionEscrow escrow = _deploy("test/fixtures/deploy/no_assets.json");
        vm.expectEmit(true, false, false, true, address(escrow));
        emit PerihelionEscrow.EndpointDelegateSet(TIMELOCK);
        vm.prank(escrow.owner());
        escrow.setEndpointDelegate(TIMELOCK);
    }

    function _timelock() internal returns (PerihelionTimelock) {
        address[] memory owners = new address[](1);
        owners[0] = address(0x0111);
        return new PerihelionTimelock(owners, 1, 1 days);
    }
}

/// @dev Gives `DeployConfig.load` an external call boundary so reverts can be expected.
contract ConfigHarness {
    function load(string memory path) external view returns (DeployConfig.Config memory) {
        return DeployConfig.load(path);
    }
}
