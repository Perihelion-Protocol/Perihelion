// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { MockERC20, MockEndpoint } from "./PerihelionEscrow.t.sol";
import { MessagingReceipt, MessagingFee } from "../src/interfaces/ILayerZero.sol";

/// @dev Smart account that accepts exactly one (digest, signature) pair. Accepting only
///      the unwrapped inner bytes proves the escrow strips the ERC-6492 wrapper before
///      it calls ERC-1271.
contract StrictWallet {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bytes32 public immutable expectedDigest;
    bytes32 public immutable expectedSigHash;

    constructor(bytes32 digest, bytes memory sig) {
        expectedDigest = digest;
        expectedSigHash = keccak256(sig);
    }

    function isValidSignature(bytes32 hash, bytes calldata sig) external view returns (bytes4) {
        if (hash == expectedDigest && keccak256(sig) == expectedSigHash) return MAGIC;
        return bytes4(0xffffffff);
    }

    /// @dev Lets the account grant the escrow an allowance on its own token balance.
    function approveToken(MockERC20 token, address spender) external {
        token.approve(spender, type(uint256).max);
    }
}

/// @notice ERC-6492 handling of counterfactual and deployed smart-account signatures (#1054).
contract ERC6492Test is Test {
    uint32 internal constant STELLAR_EID = 30_168;
    bytes32 internal constant STELLAR_PEER = bytes32(uint256(0xBEEF));
    bytes32 internal constant ERC6492_MAGIC =
        0x6492649264926492649264926492649264926492649264926492649264926492;

    PerihelionEscrow internal escrow;
    MockEndpoint internal endpoint;
    MockERC20 internal token;
    address internal solver = address(0x501);
    address internal factory = address(0xFAC7);

    function setUp() public {
        endpoint = new MockEndpoint();
        escrow = new PerihelionEscrow(address(endpoint), STELLAR_EID);
        escrow.setPeer(STELLAR_PEER);
        token = new MockERC20();
        escrow.setAssetAllowed(address(token), true);
        escrow.setMaxIntentAmountPerAsset(address(token), type(uint256).max);
        vm.deal(solver, 10 ether);

        // The mock endpoint's send() reverts in this harness; stub the receipt so the
        // lock path under test is the escrow's own validation.
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

    function _intent(address user, uint256 nonce)
        internal
        view
        returns (PerihelionEscrow.Intent memory)
    {
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

    /// @dev ERC-6492 wrapper: `abi.encode(factory, factoryCalldata, innerSig) ‖ MAGIC`.
    function _wrap(bytes memory innerSig) internal view returns (bytes memory) {
        return abi.encodePacked(
            abi.encode(factory, abi.encodeWithSignature("deploy()"), innerSig), ERC6492_MAGIC
        );
    }

    /// @dev Give `account` code that accepts `innerSig` for `intent`, with funds and an
    ///      allowance to the escrow.
    function _deployWallet(
        address account,
        PerihelionEscrow.Intent memory intent,
        bytes memory innerSig
    ) internal {
        vm.etch(account, address(new StrictWallet(escrow.hashIntent(intent), innerSig)).code);
        token.mint(account, 1_000_000);
        vm.prank(account);
        token.approve(address(escrow), type(uint256).max);
    }

    function test_DeployedAccount_ReceivesUnwrappedSignature() public {
        address account = address(0x7A11E7);
        bytes memory innerSig = hex"c0ffee";
        PerihelionEscrow.Intent memory intent = _intent(account, 1);
        _deployWallet(account, intent, innerSig);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, _wrap(innerSig));

        (, address lockUser,,,,,,) = escrow.locks(escrow.hashIntent(intent));
        assertEq(lockUser, account);
    }

    function test_DeployedAccount_WrongInnerSignatureRejected() public {
        address account = address(0x7A11E8);
        PerihelionEscrow.Intent memory intent = _intent(account, 2);
        _deployWallet(account, intent, hex"c0ffee");

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.InvalidSignature.selector);
        escrow.lock{ value: 0.01 ether }(intent, _wrap(hex"baad"));
    }

    function test_UndeployedAccount_RevertsWithDedicatedError() public {
        address counterfactual = vm.addr(0xC0DE);
        assertEq(counterfactual.code.length, 0);

        PerihelionEscrow.Intent memory intent = _intent(counterfactual, 3);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.UndeployedSmartAccount.selector);
        escrow.lock{ value: 0.01 ether }(intent, _wrap(hex"c0ffee"));
    }

    function test_DeployedAccount_MalformedWrapperReverts() public {
        address account = address(0x7A11E9);
        PerihelionEscrow.Intent memory intent = _intent(account, 4);
        _deployWallet(account, intent, hex"c0ffee");

        // Suffix present, body is not an ABI-encoded (address, bytes, bytes).
        bytes memory bogus = abi.encodePacked(hex"deadbeef", ERC6492_MAGIC);
        vm.prank(solver);
        vm.expectRevert();
        escrow.lock{ value: 0.01 ether }(intent, bogus);
    }

    function test_EOA_PlainSignatureStillWorks() public {
        uint256 pk = 0xA11CE;
        address user = vm.addr(pk);
        token.mint(user, 1_000_000);
        vm.prank(user);
        token.approve(address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent(user, 5);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, escrow.hashIntent(intent));
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, abi.encodePacked(r, s, v));

        (, address lockUser,,,,,,) = escrow.locks(escrow.hashIntent(intent));
        assertEq(lockUser, user);
    }

    function test_UndeployedEOA_WrongSignerIsInvalidSignature() public {
        // Plain 65-byte path is unchanged: a signature from another key is rejected.
        address user = vm.addr(0xBADBAD);
        PerihelionEscrow.Intent memory intent = _intent(user, 6);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(0x1234, escrow.hashIntent(intent));
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.InvalidSignature.selector);
        escrow.lock{ value: 0.01 ether }(intent, abi.encodePacked(r, s, v));
    }
}
