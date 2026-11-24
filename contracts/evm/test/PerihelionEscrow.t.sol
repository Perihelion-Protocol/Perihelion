// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { Test } from "forge-std/Test.sol";
import { PerihelionEscrow } from "../src/PerihelionEscrow.sol";
import { IERC20 } from "../src/IERC20.sol";
import {
    Origin,
    MessagingParams,
    MessagingFee,
    MessagingReceipt,
    ILayerZeroEndpointV2
} from "../src/interfaces/ILayerZero.sol";

/// @dev Minimal mintable ERC-20 for tests.
contract MockERC20 is IERC20 {
    // Optional EIP-20 metadata (IERC20 declares these; mocks don't track supply).
    function name() external pure returns (string memory) {
        return "Mock";
    }

    function symbol() external pure returns (string memory) {
        return "MOCK";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

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
    // Optional EIP-20 metadata (IERC20 declares these; mocks don't track supply).
    function name() external pure returns (string memory) {
        return "Mock";
    }

    function symbol() external pure returns (string memory) {
        return "MOCK";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

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

/// @dev USDT-style token: no return value on transfer/transferFrom (old USDC behavior).
///      Does not inherit IERC20 to allow the void return type; the escrow
///      exercises it via low-level calls in _safeTransfer / _safeTransferFrom.
contract NoReturnERC20 {
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
        assembly {
            return(0, 0)
        } // no return data, mimicking USDT
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        assembly {
            return(0, 0)
        } // no return data, mimicking USDT
    }
}

/// @dev Token that returns false on transfer (e.g., insufficient balance). Tests rejection.
contract FalseReturningERC20 is IERC20 {
    // Optional EIP-20 metadata (IERC20 declares these; mocks don't track supply).
    function name() external pure returns (string memory) {
        return "Mock";
    }

    function symbol() external pure returns (string memory) {
        return "MOCK";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

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

/// @dev RevertOnZeroERC20: reverts on transfer/transferFrom when amount == 0,
///      mimicking tokens that reject zero-value transfers (e.g., some USDT-like
///      implementations on certain networks).
contract RevertOnZeroERC20 is IERC20 {
    // Optional EIP-20 metadata (IERC20 declares these; mocks don't track supply).
    function name() external pure returns (string memory) {
        return "Mock";
    }

    function symbol() external pure returns (string memory) {
        return "MOCK";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _checkNonZero(uint256 amount) private pure {
        if (amount == 0) revert("zero transfer");
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _checkNonZero(amount);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _checkNonZero(amount);
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Token that returns false on transfer but succeeds on transferFrom.
///      Tests the release/refund path specifically — lock via transferFrom works,
///      but the subsequent release/refund via transfer fails.
contract ReleaseFalseReturningERC20 is IERC20 {
    // Optional EIP-20 metadata (IERC20 declares these; mocks don't track supply).
    function name() external pure returns (string memory) {
        return "Mock";
    }

    function symbol() external pure returns (string memory) {
        return "MOCK";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address, uint256) external returns (bool) {
        return false; // Always reject on transfer (release/refund)
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev USDC/USDT-style token with an issuer-controlled blocklist. Transfers to or
///      from a blocklisted address revert, mimicking the real tokens' behaviour.
contract BlocklistERC20 is IERC20 {
    // Optional EIP-20 metadata (IERC20 declares these; mocks don't track supply).
    function name() external pure returns (string memory) {
        return "Mock";
    }

    function symbol() external pure returns (string memory) {
        return "MOCK";
    }

    function decimals() external pure returns (uint8) {
        return 18;
    }

    function totalSupply() external pure returns (uint256) {
        return 0;
    }

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blocked;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function setBlocked(address who, bool isBlocked) external {
        blocked[who] = isBlocked;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function _check(address from, address to) internal view {
        require(!blocked[from] && !blocked[to], "blocklisted");
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _check(msg.sender, to);
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        _check(from, to);
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Minimal ERC-1271 smart-contract wallet for tests. Returns the magic
///      value when `valid` is true, otherwise an arbitrary non-magic value.
contract MockERC1271Wallet {
    bytes4 internal constant MAGIC = 0x1626ba7e;
    bool public valid;

    constructor(bool _valid) {
        valid = _valid;
    }

    function setValid(bool _valid) external {
        valid = _valid;
    }

    function isValidSignature(bytes32, bytes calldata) external view returns (bytes4) {
        return valid ? MAGIC : bytes4(0xffffffff);
    }
}

/// @dev Records the last outbound LayerZero send and can replay inbound messages
///      back into the escrow as if it were the canonical endpoint.
contract MockEndpoint is ILayerZeroEndpointV2 {
    function setDelegate(address) external { }

    uint32 public lastDstEid;
    bytes32 public lastReceiver;
    bytes public lastMessage;
    bytes public lastOptions;
    uint256 public lastNativeFee;
    address public lastRefundAddress;
    uint256 public sendCount;

    receive() external payable { }

    /// @dev Fee returned by quote(); 0 means any msg.value >= 0 passes.
    uint256 public mockFee;

    function setMockFee(uint256 fee) external {
        mockFee = fee;
    }

    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (MessagingReceipt memory receipt)
    {
        lastDstEid = params.dstEid;
        lastReceiver = params.receiver;
        lastMessage = params.message;
        lastOptions = params.options;
        lastNativeFee = msg.value;
        lastRefundAddress = refundAddress;
        sendCount++;
        return MessagingReceipt({
            guid: bytes32(uint256(0xABCD)),
            nonce: 0,
            fee: MessagingFee({ nativeFee: msg.value, lzTokenFee: 0 })
        });
    }

    function quote(MessagingParams calldata, address) external view returns (MessagingFee memory) {
        return MessagingFee({ nativeFee: mockFee, lzTokenFee: 0 });
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
        uint256 amount,
        string destination,
        string destAsset,
        uint128 minDestAmount,
        uint64 deadline
    );
    event Released(
        bytes32 indexed intentHash,
        address indexed solver,
        uint256 amount,
        uint128 fillAmount,
        uint64 fillLedger,
        uint128 minDestAmount
    );
    event Refunded(bytes32 indexed intentHash, address indexed user, uint256 amount, uint8 reason);
    event RefundedLocalTimeout(bytes32 indexed intentHash, address indexed user, uint256 amount);
    event PeerSet(bytes32 peer);
    event ConfirmationGraceSet(uint256 secondsGrace);
    event GuardianSet(address indexed guardian);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferCancelled(address indexed previousOwner);
    event EnforcedOptionsSet(bytes options);
    event Skimmed(address indexed token, address indexed to, uint256 amount);
    event TransferDeferred(
        bytes32 indexed intentHash, address indexed token, address indexed recipient, uint256 amount
    );
    event Claimed(address indexed token, address indexed to, uint256 amount);

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
    }

    // --- Helpers -------------------------------------------------------------

    function _intent() internal view returns (PerihelionEscrow.Intent memory) {
        return PerihelionEscrow.Intent({
            user: user,
            destination: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
            sourceChainId: block.chainid,
            sourceAsset: address(token),
            sourceAmount: 100_000,
            destAsset: "USDC:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
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

    /// @dev Allowlists `asset` with no per-asset cap, the configuration a deployment applies
    ///      before the escrow accepts locks for it (see script/Deploy.s.sol).
    function _allowAsset(address asset) internal {
        escrow.setAssetAllowed(asset, true);
        escrow.setMaxIntentAmountPerAsset(asset, type(uint256).max);
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
            uint128(990_000), // == _intent().minDestAmount
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
        endpoint.setMockFee(0.01 ether); // quote == msg.value, so nothing is refunded
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.expectEmit(true, true, true, true);
        emit Locked(
            h,
            solver,
            user,
            address(token),
            100_000,
            intent.destination,
            intent.destAsset,
            uint128(intent.minDestAmount),
            uint64(intent.deadline)
        );

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        assertEq(token.balanceOf(address(escrow)), 100_000);
        assertEq(token.balanceOf(user), 900_000);

        // FillInstruction dispatched to the Stellar peer over the endpoint.
        assertEq(endpoint.sendCount(), 1);
        assertEq(endpoint.lastDstEid(), STELLAR_EID);
        assertEq(endpoint.lastReceiver(), STELLAR_PEER);
        // The escrow forwards only the quoted fee (0 with the mock) and refunds the rest.
        assertEq(endpoint.lastNativeFee(), 0);
        assertEq(endpoint.lastRefundAddress(), solver);

        bytes memory message = endpoint.lastMessage();
        assertEq(uint8(message[0]), 0x01); // PROTOCOL_VERSION
        assertEq(uint8(message[1]), 0x01); // MSG_FILL_INSTRUCTION

        (
            address lSolver,
            address lUser,
            address lAsset,
            uint256 lAmount,
            ,
            ,
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
        _allowAsset(address(feeToken));
        feeToken.mint(user, 1_000_000);
        vm.prank(user);
        feeToken.approve(address(escrow), type(uint256).max);
        escrow.setAssetAllowed(address(feeToken), true);
        escrow.setMaxIntentAmountPerAsset(address(feeToken), type(uint256).max);

        escrow.setAssetAllowed(address(feeToken), true);
        escrow.setMaxIntentAmountPerAsset(address(feeToken), type(uint256).max);
        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(feeToken);
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // Escrow records only what actually arrived (99_000), not the 100_000 sent.
        assertEq(feeToken.balanceOf(address(escrow)), 99_000);
        (,,, uint256 lAmount,,,,) = escrow.locks(h);
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

    function test_LockBelowFeeReverts() public {
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);

        // Under mockEndpoint, mockFee is returned
        uint256 quotedFee = escrow.quoteFee(intent, solver);

        vm.prank(solver);
        escrow.lock{ value: quotedFee }(intent, sig);
        assertEq(token.balanceOf(address(escrow)), 100_000);
    }

    function test_QuoteFee_MatchesPayerFee() public {
        PerihelionEscrow.Intent memory intent = _intent();
        uint256 feeWithSolver = escrow.quoteFee(intent, solver);
        assertEq(feeWithSolver, endpoint.mockFee());

        vm.prank(solver);
        uint256 feeMsgSender = escrow.quoteFee(intent);
        assertEq(feeMsgSender, feeWithSolver);
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

    // --- ERC-1271 contract wallets (Issue #932) ------------------------------

    function test_LockWithERC1271Wallet() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(true);
        token.mint(address(wallet), 1_000_000);
        vm.prank(address(wallet));
        token.approve(address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent();
        intent.user = address(wallet);
        bytes32 h = escrow.hashIntent(intent);

        // Contract wallets sign via isValidSignature; the raw bytes are opaque
        // to the escrow.
        bytes memory sig = hex"deadbeef";

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        assertEq(token.balanceOf(address(escrow)), 100_000);
        (,,, uint256 lAmount,,,,) = escrow.locks(h);
        assertEq(lAmount, 100_000);
    }

    function test_RevertWhen_ERC1271SignatureInvalid() public {
        MockERC1271Wallet wallet = new MockERC1271Wallet(false);
        token.mint(address(wallet), 1_000_000);
        vm.prank(address(wallet));
        token.approve(address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent();
        intent.user = address(wallet);
        bytes memory sig = hex"deadbeef";

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.InvalidSignature.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    // --- Asset allowlist (Issue #335) ----------------------------------------

    function test_RevertWhen_AssetNotAllowed() public {
        MockERC20 unknownToken = new MockERC20();
        unknownToken.mint(user, 1_000_000);
        vm.prank(user);
        unknownToken.approve(address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(unknownToken);
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.AssetNotAllowed.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_SetAssetAllowed() public {
        MockERC20 newToken = new MockERC20();
        newToken.mint(user, 1_000_000);
        vm.prank(user);
        newToken.approve(address(escrow), type(uint256).max);

        _allowAsset(address(newToken));
        assertTrue(escrow.assetAllowed(address(newToken)));

        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(newToken);
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);
        assertEq(newToken.balanceOf(address(escrow)), 100_000);
    }

    function test_RevertWhen_SetAssetAllowedNonContract() public {
        address eoa = address(0xE0A);
        vm.expectRevert(PerihelionEscrow.NotAContract.selector);
        escrow.setAssetAllowed(eoa, true);
    }

    function test_RevokeAssetAllowed() public {
        assertTrue(escrow.assetAllowed(address(token))); // allowed by default in setUp

        escrow.setAssetAllowed(address(token), false);
        assertFalse(escrow.assetAllowed(address(token)));

        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.AssetNotAllowed.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    // --- Per-asset admin setters share the allowlist precondition (Issue #1055) ---

    function test_RevertWhen_SetMaxIntentAmountPerAssetNotAllowed() public {
        MockERC20 unknownToken = new MockERC20();
        assertFalse(escrow.assetAllowed(address(unknownToken)));

        vm.expectRevert(PerihelionEscrow.AssetNotAllowed.selector);
        escrow.setMaxIntentAmountPerAsset(address(unknownToken), 1_000);
    }

    function test_RevertWhen_SetMaxIntentAmountPerAssetEOA() public {
        address eoa = address(0xE0A);
        vm.expectRevert(PerihelionEscrow.AssetNotAllowed.selector);
        escrow.setMaxIntentAmountPerAsset(eoa, 1_000);
    }

    function test_RevertWhen_SetMaxIntentAmountPerAssetZeroAddress() public {
        vm.expectRevert(PerihelionEscrow.AssetNotAllowed.selector);
        escrow.setMaxIntentAmountPerAsset(address(0), 1_000);
    }

    function test_RevertWhen_SetRollingWindowCapForAssetNotAllowed() public {
        MockERC20 unknownToken = new MockERC20();
        vm.expectRevert(PerihelionEscrow.AssetNotAllowed.selector);
        escrow.setRollingWindowCapForAsset(address(unknownToken), 1_000);
    }

    /// @notice Full flow: allowlist -> set caps -> disallow (caps/bucket cleared)
    ///         -> re-allow (caps stay zero until explicitly reconfigured).
    function test_DisallowAssetClearsCapsAndReAllowRequiresReconfiguration() public {
        MockERC20 newToken = new MockERC20();
        newToken.mint(user, 1_000_000);
        vm.prank(user);
        newToken.approve(address(escrow), type(uint256).max);

        // 1. Allowlist and configure caps.
        escrow.setAssetAllowed(address(newToken), true);
        escrow.setMaxIntentAmountPerAsset(address(newToken), 500_000);
        escrow.setRollingWindowCapForAsset(address(newToken), 400_000);

        assertEq(escrow.maxIntentAmountPerAsset(address(newToken)), 500_000);
        assertEq(escrow.rollingWindowCap(address(newToken)), 400_000);

        // 2. Disallow: per-asset cap, window cap and rolling bucket are cleared.
        escrow.setAssetAllowed(address(newToken), false);
        assertFalse(escrow.assetAllowed(address(newToken)));
        assertEq(escrow.maxIntentAmountPerAsset(address(newToken)), 0);
        assertEq(escrow.rollingWindowCap(address(newToken)), 0);
        assertEq(escrow.rollingWindowUsed(address(newToken)), 0);

        // 3. Re-allow: caps stay at zero until explicitly reconfigured.
        escrow.setAssetAllowed(address(newToken), true);
        assertTrue(escrow.assetAllowed(address(newToken)));
        assertEq(escrow.maxIntentAmountPerAsset(address(newToken)), 0);
        assertEq(escrow.rollingWindowCap(address(newToken)), 0);

        // With a zero cap, locking against the re-allowed asset is rejected.
        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(newToken);
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.IntentTooLarge.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // Explicit reconfiguration restores usability.
        escrow.setMaxIntentAmountPerAsset(address(newToken), type(uint256).max);
        escrow.setRollingWindowCapForAsset(address(newToken), type(uint256).max);
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);
        assertEq(newToken.balanceOf(address(escrow)), 100_000);
    }

    // --- String field validation --------------------------------------------

    /// Build a string of `n` repeated 'A' bytes.
    function _str(uint256 n) private pure returns (string memory) {
        bytes memory b = new bytes(n);
        for (uint256 i = 0; i < n; i++) {
            b[i] = bytes1("A");
        }
        return string(b);
    }

    function test_RevertWhen_DestinationEmpty() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.destination = "";
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.StringFieldEmpty.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_RevertWhen_DestinationTooLong() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.destination = _str(escrow.MAX_DESTINATION_LEN() + 1); // 57 bytes
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.StringFieldTooLong.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_RevertWhen_DestAssetEmpty() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.destAsset = "";
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.StringFieldEmpty.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_RevertWhen_DestAssetTooLong() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.destAsset = _str(escrow.MAX_DEST_ASSET_LEN() + 1); // 70 bytes
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.StringFieldTooLong.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_LockAtMaxDestinationLength() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.destination = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"; // exactly 56 chars, a valid strkey
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig); // must not revert
    }

    // --- Destination / asset strkey validation (#1052) -----------------------

    function test_RevertWhen_DestinationIsNotAStrkey() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.destination = "GUSERSTELLAR";
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.MalformedDestination.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_RevertWhen_DestinationChecksumIsBad() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.destination = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHE";
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.MalformedDestination.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_RevertWhen_DestAssetIsNotCanonical() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.destAsset = "XLM"; // must be `native`
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.MalformedDestAsset.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    /// @dev A malformed intent must be refused before any LayerZero fee is paid: the
    ///      solver is not charged and no FillInstruction is dispatched.
    function test_MalformedIntentPaysNoFee() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.destination = "GUSERSTELLAR";
        bytes memory sig = _sign(intent);
        uint256 solverBefore = solver.balance;
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.MalformedDestination.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
        assertEq(solver.balance, solverBefore);
        assertEq(endpoint.sendCount(), 0);
    }

    function test_LockAtMaxDestAssetLength() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.destAsset = "ABCDEFGHIJKL:GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"; // exactly 69 bytes: 12-char code + issuer
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig); // must not revert
    }

    // --- Inbound: FillConfirmed ---------------------------------------------

    function test_FillConfirmedReleasesToSolver() public {
        bytes32 h = _lock();

        vm.expectEmit(true, true, false, true);
        emit Released(h, solver, 100_000, 990_000, 12_345, 990_000);
        _confirm(h, solver, 1);

        assertEq(token.balanceOf(solver), 100_000);
        assertEq(token.balanceOf(address(escrow)), 0);

        (,,,,,, bool released,) = escrow.locks(h);
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
        emit Refunded(h, user, 100_000, 0);
        _cancel(h, 1);

        assertEq(token.balanceOf(user), 1_000_000);
        (,,,,,,, bool refunded) = escrow.locks(h);
        assertTrue(refunded);
    }

    function test_RevertWhen_CancelAfterRelease() public {
        bytes32 h = _lock();
        _confirm(h, solver, 1);

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

    /// @notice Issue #1049: a packet carrying the Stellar peer bytes32 from a different source
    ///         endpoint id is refused, and it does not consume the nonce on the real pathway.
    function test_RevertWhen_WrongSourceEidWithCorrectSender() public {
        bytes32 h = _lock();

        vm.expectRevert(PerihelionEscrow.UntrustedPeer.selector);
        endpoint.deliver(escrow, STELLAR_EID + 1, STELLAR_PEER, 1, _cancelIntent(h));

        // The same nonce is still accepted from the genuine Stellar pathway.
        _cancel(h, 1);
        (,,,,,, bool released, bool refunded) = escrow.locks(h);
        assertFalse(released);
        assertTrue(refunded);
    }

    /// @notice Issue #1050: the endpoint may open only the genuine Stellar pathway.
    function test_AllowInitializePath_OnlyStellarPathway() public view {
        assertTrue(
            escrow.allowInitializePath(
                Origin({ srcEid: STELLAR_EID, sender: STELLAR_PEER, nonce: 0 })
            )
        );
        assertFalse(
            escrow.allowInitializePath(
                Origin({ srcEid: STELLAR_EID + 1, sender: STELLAR_PEER, nonce: 0 })
            )
        );
        assertFalse(
            escrow.allowInitializePath(
                Origin({ srcEid: STELLAR_EID, sender: bytes32(uint256(0xBAD)), nonce: 0 })
            )
        );
    }

    /// @notice Issue #1050: unordered delivery, so the endpoint never waits on a nonce.
    function test_NextNonce_IsUnordered() public view {
        assertEq(escrow.nextNonce(STELLAR_EID, STELLAR_PEER), 0);
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
        vm.expectRevert(PerihelionEscrow.UnknownVersion.selector);
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
        emit RefundedLocalTimeout(h, user, 100_000);
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
        vm.expectEmit(false, false, false, false);
        emit PeerSet(bytes32(uint256(0x1234)));
        bytes32 newPeer = bytes32(uint256(0x1234));
        escrow.setPeer(newPeer);
        assertEq(escrow.stellarPeer(), newPeer);
    }

    function test_RevertWhen_SetPeerNotOwner() public {
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        escrow.setPeer(bytes32(uint256(0x1234)));
    }

    function test_RevertWhen_SetPeerZero() public {
        vm.expectRevert(PerihelionEscrow.ZeroAddress.selector);
        escrow.setPeer(bytes32(0));
    }

    function test_RevertWhen_LockWithoutPeer() public {
        // Fresh escrow with no peer configured but an allowlisted asset.
        PerihelionEscrow fresh = new PerihelionEscrow(address(endpoint), STELLAR_EID);
        fresh.setAssetAllowed(address(token), true);
        fresh.setMaxIntentAmountPerAsset(address(token), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);

        uint256 userBefore = token.balanceOf(user);
        uint256 escrowBefore = token.balanceOf(address(fresh));

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.ZeroAddress.selector);
        fresh.lock{ value: 0.01 ether }(intent, sig);

        // Reverts before pulling funds.
        assertEq(token.balanceOf(user), userBefore);
        assertEq(token.balanceOf(address(fresh)), escrowBefore);
    }

    function test_SetConfirmationGrace() public {
        vm.expectEmit(false, false, false, false);
        emit ConfirmationGraceSet(1 hours);
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
        vm.expectEmit(false, false, false, false);
        emit ConfirmationGraceSet(escrow.MAX_CONFIRMATION_GRACE());
        escrow.setConfirmationGrace(escrow.MAX_CONFIRMATION_GRACE());
        assertEq(escrow.confirmationGrace(), escrow.MAX_CONFIRMATION_GRACE());
    }

    function test_SetGuardianEvent() public {
        vm.expectEmit(true, false, false, false);
        emit GuardianSet(address(0x6A));
        escrow.setGuardian(address(0x6A));
        assertEq(escrow.guardian(), address(0x6A));
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

    function test_CancelExpiredStillWorksWhilePaused() public {
        bytes32 h = _lock();
        escrow.setPaused(true);

        PerihelionEscrow.Intent memory intent = _intent();
        vm.warp(intent.deadline + escrow.confirmationGrace());
        escrow.cancelExpired(h);

        assertEq(token.balanceOf(user), 1_000_000);
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
        escrow.cancelOwnershipTransfer();
        assertEq(escrow.pendingOwner(), address(0));

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NotPendingOwner.selector);
        escrow.acceptOwnership();
    }

    function test_RevertWhen_TransferOwnershipToZero() public {
        vm.expectRevert(PerihelionEscrow.ZeroAddress.selector);
        escrow.transferOwnership(address(0));
    }

    /// @dev A zero-address proposal must not clear a live handover; only
    ///      cancelOwnershipTransfer does that.
    function test_RevertWhen_ZeroTransferKeepsPendingOwner() public {
        escrow.transferOwnership(solver);
        vm.expectRevert(PerihelionEscrow.ZeroAddress.selector);
        escrow.transferOwnership(address(0));
        assertEq(escrow.pendingOwner(), solver);
    }

    function test_RevertWhen_TransferOwnershipToCurrentOwner() public {
        vm.expectRevert(PerihelionEscrow.TransferToCurrentOwner.selector);
        escrow.transferOwnership(owner);
        assertEq(escrow.pendingOwner(), address(0));
    }

    function test_RevertWhen_TransferOwnershipNotOwner() public {
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        escrow.transferOwnership(solver);
    }

    function test_RevertWhen_CancelOwnershipTransferNoPending() public {
        // Owner calls cancel with no pending transfer: must be NoPendingOwner,
        // not NotOwner.
        vm.expectRevert(PerihelionEscrow.NoPendingOwner.selector);
        escrow.cancelOwnershipTransfer();
    }

    function test_CancelOwnershipTransferClearsPending() public {
        escrow.transferOwnership(solver);
        assertEq(escrow.pendingOwner(), solver);

        vm.expectEmit(true, false, false, false);
        emit OwnershipTransferCancelled(owner);
        escrow.cancelOwnershipTransfer();
        assertEq(escrow.pendingOwner(), address(0));
    }

    // --- Token edge cases: no-return, false-returning ----------------------------------

    function test_LockWithNoReturnToken() public {
        NoReturnERC20 noReturnToken = new NoReturnERC20();
        _allowAsset(address(noReturnToken));
        noReturnToken.mint(user, 1_000_000);
        vm.prank(user);
        noReturnToken.approve(address(escrow), type(uint256).max);
        escrow.setAssetAllowed(address(noReturnToken), true);
        escrow.setMaxIntentAmountPerAsset(address(noReturnToken), type(uint256).max);

        escrow.setAssetAllowed(address(noReturnToken), true);
        escrow.setMaxIntentAmountPerAsset(address(noReturnToken), type(uint256).max);
        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(noReturnToken);
        bytes memory sig = _sign(intent);
        bytes32 h = escrow.hashIntent(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        assertEq(noReturnToken.balanceOf(address(escrow)), 100_000);
        (,,, uint256 lAmount,,,,) = escrow.locks(h);
        assertEq(lAmount, 100_000);
    }

    function test_RevertWhen_LockWithFalseReturningToken() public {
        FalseReturningERC20 falseToken = new FalseReturningERC20();
        _allowAsset(address(falseToken));
        falseToken.mint(user, 1_000_000);
        vm.prank(user);
        falseToken.approve(address(escrow), type(uint256).max);
        escrow.setAssetAllowed(address(falseToken), true);
        escrow.setMaxIntentAmountPerAsset(address(falseToken), type(uint256).max);

        escrow.setAssetAllowed(address(falseToken), true);
        escrow.setMaxIntentAmountPerAsset(address(falseToken), type(uint256).max);
        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(falseToken);
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.TransferFailed.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_RevertWhen_LockTokenReceivesNothing() public {
        FeeERC20 heavyFeeToken = new FeeERC20(10_000); // 100% fee (receives 0)
        _allowAsset(address(heavyFeeToken));
        heavyFeeToken.mint(user, 1_000_000);
        vm.prank(user);
        heavyFeeToken.approve(address(escrow), type(uint256).max);
        escrow.setAssetAllowed(address(heavyFeeToken), true);
        escrow.setMaxIntentAmountPerAsset(address(heavyFeeToken), type(uint256).max);

        escrow.setAssetAllowed(address(heavyFeeToken), true);
        escrow.setMaxIntentAmountPerAsset(address(heavyFeeToken), type(uint256).max);
        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(heavyFeeToken);
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NothingReceived.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    // --- Under-delivery enforcement (Issue #334) ----

    /// @notice Verify that fillAmount below minDestAmount reverts with UnderDelivered.
    function test_RevertWhen_FillConfirmedUnderDelivered() public {
        bytes32 h = _lock();

        // Craft a FillConfirmed with fillAmount < minDestAmount (990_000)
        bytes memory msgUnderDelivered = abi.encodePacked(
            V,
            T_FILL_CONFIRMED,
            h,
            bytes32(uint256(uint160(solver))),
            uint128(989_999), // below minDestAmount of 990_000
            uint64(12_345)
        );
        vm.expectRevert(PerihelionEscrow.UnderDelivered.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, msgUnderDelivered);
    }

    /// @notice Verify that fillAmount == minDestAmount succeeds.
    function test_FillConfirmedAtMinDestAmount() public {
        bytes32 h = _lock();

        bytes memory msgExact = abi.encodePacked(
            V,
            T_FILL_CONFIRMED,
            h,
            bytes32(uint256(uint160(solver))),
            uint128(990_000), // exactly minDestAmount
            uint64(12_345)
        );
        vm.expectEmit(true, true, false, true);
        emit Released(h, solver, 100_000, 990_000, 12_345, 990_000);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, msgExact);

        assertEq(token.balanceOf(solver), 100_000);
    }

    // --- FillConfirmed amount field is informational -------------------------

    /// @notice The `amount` field in FillConfirmed is informational; the escrow
    ///         always releases `l.amount` (measured-delta), regardless of the
    ///         value encoded in the message. This test confirms that a message
    ///         carrying a wildly different amount still releases exactly the
    ///         locked balance.
    function test_FillConfirmedReleasesLockAmountNotMessageAmount() public {
        bytes32 h = _lock(); // locks 100_000 tokens

        // Craft a FillConfirmed with amount field = 999_999 (much bigger than locked).
        bytes memory msgWithBigAmount = abi.encodePacked(
            V,
            T_FILL_CONFIRMED,
            h,
            bytes32(uint256(uint160(solver))),
            uint128(999_999), // informational field — must NOT change the released amount
            uint64(1)
        );
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, msgWithBigAmount);

        // Solver receives exactly l.amount = 100_000, not 999_999.
        assertEq(token.balanceOf(solver), 100_000);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    /// @notice Symmetric: message amount smaller than locked still releases l.amount.
    /// @notice A FillConfirmed reporting less than minDestAmount is rejected outright, so
    ///         the lock can never be released for an under-delivered fill.
    function test_RevertWhen_FillConfirmedAmountIsSmaller() public {
        bytes32 h = _lock(); // locks 100_000 tokens

        bytes memory msgWithSmallAmount = abi.encodePacked(
            V,
            T_FILL_CONFIRMED,
            h,
            bytes32(uint256(uint160(solver))),
            uint128(1), // tiny: must not release
            uint64(1)
        );
        vm.expectRevert(PerihelionEscrow.UnderDelivered.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, msgWithSmallAmount);

        assertEq(token.balanceOf(address(escrow)), 100_000);
        assertEq(token.balanceOf(solver), 0);
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
            V, T_FILL_CONFIRMED, intentHash, bytes32(uint256(uint160(solverAddr))), amount, ledger
        );

        assertEq(expected.length, 90);
        _confirm(h, solver, 1);
        assertEq(token.balanceOf(solver), 100_000);
    }

    /// @notice Verify CancelIntent decoding against exact 35-byte layout:
    ///         version(1)|type(1)|intent_hash(32)|reason(1)
    function test_CancelIntentExactLayout() public {
        bytes32 h = _lock();

        bytes memory expected = abi.encodePacked(V, T_CANCEL_INTENT, h, uint8(0));

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

        // Late FillConfirmed arrives after the refund and reverts: the lock is finalized.
        vm.expectRevert(PerihelionEscrow.AlreadyFinalized.selector);
        _confirm(h, solver, 1);
    }

    /// @notice Inbound ordering: CancelIntent arrives first, then FillConfirmed.
    ///         The CancelIntent must win and the subsequent FillConfirmed must
    ///         be rejected with AlreadyFinalized (protocol I1/I2).
    function test_RaceGuard_InboundCancelThenConfirm() public {
        bytes32 h = _lock();

        // Inbound CancelIntent delivered first.
        _cancel(h, 1);
        assertEq(token.balanceOf(user), 1_000_000);

        // Subsequent FillConfirmed reverts: the finalized lock is never released.
        vm.expectRevert(PerihelionEscrow.AlreadyFinalized.selector);
        _confirm(h, solver, 2);
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
        endpoint.deliver(escrow, STELLAR_EID, untrustedPeer, 1, _fillConfirmed(h, solver));
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

    // --- #39: WrongChain check -------------------------------------------

    function test_RevertWhen_LockWrongChain() public {
        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceChainId = block.chainid + 1; // mismatch
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.WrongChain.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    function test_LockCorrectChain() public {
        // Ensure the default _intent() (uses block.chainid) still works.
        _lock();
        assertEq(token.balanceOf(address(escrow)), 100_000);
    }

    // --- #40: MIN_CONFIRMATION_GRACE ----------------------------------------

    /// @notice Cross-language constant test (#1067).
    ///         The Stellar `dispatch_confirmation` cutoff is
    ///         `deadline + MIN_DISPATCH_WINDOW`, and a FillConfirmed dispatched at
    ///         that cutoff still needs DVN verification and executor delivery
    ///         before it lands on EVM. The EVM `cancelExpired` opens at
    ///         `deadline + confirmationGrace`, so the minimum grace must exceed
    ///         the dispatch window by a positive latency budget `L`:
    ///
    ///             MIN_CONFIRMATION_GRACE >= MIN_DISPATCH_WINDOW + LATENCY_BUDGET
    ///
    ///         The Soroban constants are read from the settlement contract source
    ///         so this test fails if either side drifts without the other.
    function test_MinConfirmationGraceCoversDispatchWindowPlusLatency() public view {
        uint256 minDispatchWindow = _sorobanConst("MIN_DISPATCH_WINDOW");
        uint256 latencyBudget = _sorobanConst("CROSS_CHAIN_LATENCY_BUDGET");

        // Sanity: the Soroban constants must be non-zero and the budget positive.
        assertGt(minDispatchWindow, 0, "MIN_DISPATCH_WINDOW must be > 0");
        assertGt(latencyBudget, 0, "CROSS_CHAIN_LATENCY_BUDGET must be > 0");

        uint256 minGrace = escrow.MIN_CONFIRMATION_GRACE();
        assertGe(
            minGrace,
            minDispatchWindow + latencyBudget,
            "MIN_CONFIRMATION_GRACE must cover MIN_DISPATCH_WINDOW + CROSS_CHAIN_LATENCY_BUDGET"
        );

        // The default grace must also satisfy the inequality.
        assertGe(escrow.confirmationGrace(), minDispatchWindow + latencyBudget);
    }

    /// @dev Parse `pub const <name>: u64 = <value>;` from the Soroban settlement
    ///      source. Reverts the test if the constant is missing or unparsable.
    function _sorobanConst(string memory name) internal view returns (uint256) {
        string memory path = "../soroban/settlement/src/constants.rs";
        string memory src = vm.readFile(path);
        bytes memory haystack = bytes(src);
        bytes memory needle = bytes(string.concat("pub const ", name, ": u64 = "));

        uint256 start = _indexOf(haystack, needle);
        require(start != type(uint256).max, string.concat("missing const ", name));
        start += needle.length;

        uint256 value;
        uint256 digits;
        while (start < haystack.length) {
            bytes1 c = haystack[start];
            if (c == bytes1("_")) {
                start++;
                continue;
            }
            if (c < bytes1("0") || c > bytes1("9")) break;
            value = value * 10 + (uint8(c) - uint8(bytes1("0")));
            digits++;
            start++;
        }
        require(digits > 0, string.concat("unparsable const ", name));
        return value;
    }

    /// @dev First index of `needle` in `haystack`, or type(uint256).max.
    function _indexOf(bytes memory haystack, bytes memory needle)
        internal
        pure
        returns (uint256)
    {
        if (needle.length == 0 || haystack.length < needle.length) {
            return type(uint256).max;
        }
        for (uint256 i = 0; i <= haystack.length - needle.length; i++) {
            bool matched = true;
            for (uint256 j = 0; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    matched = false;
                    break;
                }
            }
            if (matched) return i;
        }
        return type(uint256).max;
    }

    function test_RevertWhen_GraceBelowMinimum() public {
        uint256 tooShort = escrow.MIN_CONFIRMATION_GRACE() - 1;
        vm.expectRevert(PerihelionEscrow.GraceTooShort.selector);
        escrow.setConfirmationGrace(tooShort);
    }

    function test_SetConfirmationGraceAtMinimum() public {
        escrow.setConfirmationGrace(escrow.MIN_CONFIRMATION_GRACE());
        assertEq(escrow.confirmationGrace(), escrow.MIN_CONFIRMATION_GRACE());
    }

    /// @notice The minimum grace must still be enough for a FillConfirmed
    ///         dispatched at the Stellar cutoff to land before `cancelExpired`
    ///         opens (#1067). A confirm at the cutoff plus the latency budget
    ///         must release, not race the refund.
    function test_ConfirmAtDispatchCutoffPlusLatencyStillReleases() public {
        bytes32 h = _lock();
        PerihelionEscrow.Intent memory intent = _intent();

        uint256 minDispatchWindow = _sorobanConst("MIN_DISPATCH_WINDOW");
        uint256 latencyBudget = _sorobanConst("CROSS_CHAIN_LATENCY_BUDGET");

        // Configure the minimum grace and land the confirm at the latest
        // possible dispatch time plus the full latency budget.
        escrow.setConfirmationGrace(escrow.MIN_CONFIRMATION_GRACE());
        vm.warp(intent.deadline + minDispatchWindow + latencyBudget);

        _confirm(h, solver, 1);
        assertEq(token.balanceOf(solver), 100_000);

        // The refund window must not have opened yet.
        vm.expectRevert(PerihelionEscrow.AlreadyFinalized.selector);
        escrow.cancelExpired(h);
    }

    function test_RevertWhen_GraceAboveMaximum() public {
        uint256 tooLong = escrow.MAX_CONFIRMATION_GRACE() + 1;
        vm.expectRevert(PerihelionEscrow.GraceTooLong.selector);
        escrow.setConfirmationGrace(tooLong);
    }

    // --- #37: CancelIntent reason decoding ----------------------------------

    function test_CancelIntentSurfacesReason() public {
        bytes32 h = _lock();
        // reason = 0x01 (ADMIN)
        bytes memory msg_ = abi.encodePacked(bytes1(0x01), bytes1(0x03), h, uint8(0x01));

        vm.expectEmit(true, true, false, true);
        emit Refunded(h, user, 100_000, 0x01);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, msg_);
    }

    function test_RevertWhen_CancelIntentUnknownReason() public {
        bytes32 h = _lock();
        bytes memory msg_ = abi.encodePacked(bytes1(0x01), bytes1(0x03), h, uint8(0x99));
        vm.expectRevert(PerihelionEscrow.MalformedPayload.selector);
        endpoint.deliver(escrow, STELLAR_EID, STELLAR_PEER, 1, msg_);
    }

    function test_CancelExpiredEmitsRefundedLocalTimeout() public {
        bytes32 h = _lock();
        PerihelionEscrow.Intent memory intent = _intent();
        vm.warp(intent.deadline + escrow.confirmationGrace());

        vm.expectEmit(true, true, false, true);
        emit RefundedLocalTimeout(h, user, 100_000);
        escrow.cancelExpired(h);
    }

    // --- #38: Fee quote and underpayment ------------------------------------

    function test_RevertWhen_LockFeeTooLow() public {
        endpoint.setMockFee(0.05 ether);
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.FeeTooLow.selector);
        escrow.lock{ value: 0.01 ether }(intent, sig); // below the 0.05 ether quote
    }

    function test_LockWithEndpointFeeSucceeds() public {
        endpoint.setMockFee(0.01 ether);
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);

        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);
        assertEq(token.balanceOf(address(escrow)), 100_000);
    }

    // --- Guardian pause DoS mitigation (T11) ---------------------------------

    function test_GuardianPause_SetsExpiry() public {
        address g = address(0x6A);
        escrow.setGuardian(g);
        uint256 expectedExpiry = block.timestamp + escrow.GUARDIAN_PAUSE_TTL();

        vm.prank(g);
        escrow.pause();

        assertTrue(escrow.paused());
        assertEq(escrow.guardianPauseExpiry(), expectedExpiry);
    }

    function test_GuardianPause_AutoExpiresAfterTTL() public {
        address g = address(0x6A);
        escrow.setGuardian(g);

        vm.prank(g);
        escrow.pause();
        uint256 expiry = escrow.guardianPauseExpiry();

        // Before TTL: decayGuardianPause reverts.
        vm.expectRevert(PerihelionEscrow.PauseNotExpired.selector);
        escrow.decayGuardianPause();

        // Anyone can dismiss once TTL elapses.
        vm.warp(expiry);
        vm.prank(address(0xA1A1A1));
        escrow.decayGuardianPause();

        assertFalse(escrow.paused());
        assertEq(escrow.guardianPauseExpiry(), 0);
    }

    function test_DecayGuardianPause_SetsCooldown() public {
        address g = address(0x6A);
        escrow.setGuardian(g);

        vm.prank(g);
        escrow.pause();
        vm.warp(block.timestamp + escrow.GUARDIAN_PAUSE_TTL());
        escrow.decayGuardianPause();

        uint256 expectedCooldown = block.timestamp + escrow.GUARDIAN_PAUSE_TTL();
        assertEq(escrow.guardianPauseCooldownUntil(), expectedCooldown);

        // Guardian cannot re-pause while in cooldown.
        vm.prank(g);
        vm.expectRevert(PerihelionEscrow.GuardianCooldown.selector);
        escrow.pause();
    }

    function test_GuardianCooldown_ExpiresAndAllowsRePause() public {
        address g = address(0x6A);
        escrow.setGuardian(g);
        uint256 start = block.timestamp;

        vm.prank(g);
        escrow.pause();

        vm.warp(start + escrow.GUARDIAN_PAUSE_TTL());
        escrow.decayGuardianPause();

        // After cooldown window, guardian can pause again.
        vm.warp(start + 2 * escrow.GUARDIAN_PAUSE_TTL());
        vm.prank(g);
        escrow.pause();

        assertTrue(escrow.paused());
    }

    function test_OwnerPause_NoAutoExpiry() public {
        escrow.pause(); // owner calls, not guardian
        assertTrue(escrow.paused());
        assertEq(escrow.guardianPauseExpiry(), 0); // indefinite

        // decayGuardianPause reverts — this is an owner pause.
        vm.expectRevert(PerihelionEscrow.PauseNotGuardianInitiated.selector);
        escrow.decayGuardianPause();
    }

    function test_OwnerRatifiesPause_RemovesAutoExpiry() public {
        address g = address(0x6A);
        escrow.setGuardian(g);

        vm.prank(g);
        escrow.pause();
        assertGt(escrow.guardianPauseExpiry(), 0); // guardian set expiry

        // Owner calls setPaused(true) — converts to indefinite owner pause.
        escrow.setPaused(true);
        assertEq(escrow.guardianPauseExpiry(), 0);
        assertTrue(escrow.paused());

        // decayGuardianPause now reverts (no guardian pause active).
        vm.expectRevert(PerihelionEscrow.PauseNotGuardianInitiated.selector);
        escrow.decayGuardianPause();
    }

    /// @dev Incident: leaked guardian pauses, the pause decays, and the cooldown
    ///      locks out the guardian slot. Owner rotates to a fresh key, which must
    ///      be able to pause at once rather than waiting out the old cooldown.
    function test_GuardianRotation_NewGuardianPausesImmediately() public {
        address leaked = address(0x6A);
        address fresh = address(0x6B);
        escrow.setGuardian(leaked);

        vm.prank(leaked);
        escrow.pause();
        vm.warp(block.timestamp + escrow.GUARDIAN_PAUSE_TTL());
        escrow.decayGuardianPause();
        assertGt(escrow.guardianPauseCooldownUntil(), block.timestamp);

        // Still inside the leaked key's cooldown: the old key is locked out.
        vm.prank(leaked);
        vm.expectRevert(PerihelionEscrow.GuardianCooldown.selector);
        escrow.pause();

        escrow.setGuardian(fresh);
        assertEq(escrow.guardianPauseCooldownUntil(), 0);

        vm.prank(fresh);
        escrow.pause();
        assertTrue(escrow.paused());
    }

    /// @dev An active pause started by the outgoing guardian is converted to an
    ///      owner pause on rotation, so it cannot lapse on that key's TTL.
    function test_GuardianRotation_ActivePauseBecomesOwnerControlled() public {
        address leaked = address(0x6A);
        escrow.setGuardian(leaked);

        vm.prank(leaked);
        escrow.pause();
        escrow.setGuardian(address(0x6B));
        assertEq(escrow.guardianPauseExpiry(), 0);

        vm.warp(block.timestamp + escrow.GUARDIAN_PAUSE_TTL() + 1);
        vm.expectRevert(PerihelionEscrow.PauseNotGuardianInitiated.selector);
        escrow.decayGuardianPause();
        assertTrue(escrow.paused());

        // The owner resumes when the incident is over.
        escrow.setPaused(false);
        assertFalse(escrow.paused());
    }

    function test_RevertWhen_GuardianSetToOwner() public {
        vm.expectRevert(PerihelionEscrow.GuardianIsOwner.selector);
        escrow.setGuardian(owner);
        assertEq(escrow.guardian(), address(0));
    }

    // --- Executor options (#1046) ----------------------------------------------

    function test_EnforcedOptions_DefaultIsLzReceiveGas() public view {
        bytes memory expected = abi.encodePacked(
            bytes2(0x0003), bytes1(0x01), bytes2(0x0011), bytes1(0x01), uint128(300_000)
        );
        assertEq(escrow.enforcedOptions(), expected);
        assertEq(expected.length, 22);
    }

    function test_SetEnforcedOptions_UsedByLock() public {
        bytes memory opts = abi.encodePacked(
            bytes2(0x0003), bytes1(0x01), bytes2(0x0011), bytes1(0x01), uint128(500_000)
        );

        vm.expectEmit(false, false, false, true);
        emit EnforcedOptionsSet(opts);
        escrow.setEnforcedOptions(opts);
        assertEq(escrow.enforcedOptions(), opts);

        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        endpoint.setMockFee(0.01 ether);
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);

        // The FillInstruction is sent with the stored options, not a compile-time constant.
        assertEq(endpoint.lastOptions(), opts);
    }

    function test_RevertWhen_SetEnforcedOptionsNotOwner() public {
        bytes memory opts =
            abi.encodePacked(bytes2(0x0003), bytes1(0x01), bytes2(0x0011), bytes1(0x01), uint128(1));
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        escrow.setEnforcedOptions(opts);
    }

    /// @dev Each malformed Type-3 option set must be rejected with InvalidOptions.
    function test_RevertWhen_SetEnforcedOptionsMalformed() public {
        bytes memory gasOpt =
            abi.encodePacked(bytes1(0x01), bytes2(0x0011), bytes1(0x01), uint128(1));

        // Wrong option type (Type-1 instead of Type-3).
        vm.expectRevert(PerihelionEscrow.InvalidOptions.selector);
        escrow.setEnforcedOptions(abi.encodePacked(bytes2(0x0002), gasOpt));

        // Too short to carry a type.
        vm.expectRevert(PerihelionEscrow.InvalidOptions.selector);
        escrow.setEnforcedOptions(hex"00");

        // Empty.
        vm.expectRevert(PerihelionEscrow.InvalidOptions.selector);
        escrow.setEnforcedOptions("");

        // Truncated entry: header promises 17 bytes, only 5 follow.
        vm.expectRevert(PerihelionEscrow.InvalidOptions.selector);
        escrow.setEnforcedOptions(abi.encodePacked(bytes2(0x0003), hex"0100110100000000"));

        // Zero-length entry: no room for an option type.
        vm.expectRevert(PerihelionEscrow.InvalidOptions.selector);
        escrow.setEnforcedOptions(abi.encodePacked(bytes2(0x0003), bytes1(0x01), bytes2(0x0000)));

        // Trailing bytes after a complete entry.
        vm.expectRevert(PerihelionEscrow.InvalidOptions.selector);
        escrow.setEnforcedOptions(abi.encodePacked(bytes2(0x0003), gasOpt, bytes1(0x00)));

        // Over the length bound.
        bytes memory tooLong = new bytes(257);
        tooLong[0] = 0x00;
        tooLong[1] = 0x03;
        vm.expectRevert(PerihelionEscrow.InvalidOptions.selector);
        escrow.setEnforcedOptions(tooLong);

        // A rejected write leaves the stored options untouched.
        assertEq(escrow.enforcedOptions().length, 22);
    }

    function test_OwnerUnpause_ResetsGuardianCooldown() public {
        address g = address(0x6A);
        escrow.setGuardian(g);

        vm.prank(g);
        escrow.pause();

        // Owner manually unpauses — clears expiry and cooldown.
        escrow.setPaused(false);
        assertEq(escrow.guardianPauseExpiry(), 0);
        assertEq(escrow.guardianPauseCooldownUntil(), 0);

        // Guardian can pause immediately after owner clearance.
        vm.prank(g);
        escrow.pause();
        assertTrue(escrow.paused());
    }

    function test_DecayGuardianPause_AllowsLockAfterExpiry() public {
        address g = address(0x6A);
        escrow.setGuardian(g);

        vm.prank(g);
        escrow.pause();
        vm.warp(block.timestamp + escrow.GUARDIAN_PAUSE_TTL());
        escrow.decayGuardianPause();

        // Protocol is live again; lock should succeed.
        _lock();
        assertEq(token.balanceOf(address(escrow)), 100_000);
    }

    // --- EIP-5267 eip712Domain (T12) -----------------------------------------

    function test_Eip712Domain_MatchesDomainSeparator() public view {
        (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        ) = escrow.eip712Domain();

        assertEq(fields, bytes1(0x0f)); // name + version + chainId + verifyingContract
        assertEq(keccak256(bytes(name)), keccak256(bytes("Perihelion")));
        assertEq(keccak256(bytes(version)), keccak256(bytes("1")));
        assertEq(chainId, block.chainid);
        assertEq(verifyingContract, address(escrow));
        assertEq(salt, bytes32(0));
        assertEq(extensions.length, 0);

        // Reconstruct the domain separator from the returned fields and verify
        // it is byte-identical to DOMAIN_SEPARATOR. If eip712Domain() drifts
        // from hashIntent's actual domain, this assertion will catch it.
        bytes32 reconstructed = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifyingContract
            )
        );
        assertEq(reconstructed, escrow.DOMAIN_SEPARATOR());
    }

    // --- Reentrancy guard 1/2 sentinel (T13) ---------------------------------

    function test_ReentrancyGuard_SlotInitializedToOne() public {
        // Functional check: a nonReentrant call succeeds, proving the guard
        // slot holds 1 (NOT_ENTERED). If the constructor omitted _reentrancy=1
        // the slot would be 0, the modifier check (!=1) would revert instantly.
        _lock(); // reverts with Reentrancy() if _reentrancy slot != 1
    }

    function test_ReentrancyGuard_StillPreventsReentrancy() public {
        // Functional regression: reentrancy must still revert.
        // Covered by existing test_RevertWhen_ReentrantLock; this is a
        // belt-and-suspenders confirmation that the 1/2 change didn't break it.
        bytes32 h = _lock();
        (,, address asset, uint256 amount,,,,) = escrow.locks(h);
        assertEq(asset, address(token));
        assertGt(amount, 0);
    }

    function test_ReentrancyGuard_GasBaseline() public {
        // Records a gas ceiling for lock() to surface regressions.
        // The 1→2→1 sentinel saves ~17 100 gas per call vs. the old 0→1→0
        // pattern (SSTORE_RESET 2 900 vs. SSTORE_SET 20 000 for a cold slot).
        // Run `forge snapshot` to capture the exact per-call improvement.
        PerihelionEscrow.Intent memory intent = _intent();
        bytes memory sig = _sign(intent);
        vm.prank(solver);
        uint256 g = gasleft();
        escrow.lock{ value: 0.01 ether }(intent, sig);
        uint256 gasUsed = g - gasleft();
        assertLt(gasUsed, 750_000); // sanity ceiling; exact per-call saving in .gas-snapshot
    }

    // --- Issue #273: totalLocked / skim surplus bound ------------------------

    /// totalLocked is incremented by lock() and tracks exactly what was received.
    function test_TotalLocked_IncrementedOnLock() public {
        assertEq(escrow.totalLocked(address(token)), 0);
        bytes32 h = _lock();
        (,,, uint256 amount,,,,) = escrow.locks(h);
        assertEq(escrow.totalLocked(address(token)), amount);
    }

    /// totalLocked is decremented when a fill is confirmed (release path).
    function test_TotalLocked_DecrementedOnRelease() public {
        bytes32 h = _lock();
        (,,, uint256 amount,,,,) = escrow.locks(h);

        _confirm(h, solver, 1);

        assertEq(escrow.totalLocked(address(token)), 0);
        assertEq(token.balanceOf(solver), amount);
    }

    /// totalLocked is decremented when a cancel arrives from Stellar.
    function test_TotalLocked_DecrementedOnCancelInbound() public {
        bytes32 h = _lock();

        _cancel(h, 1);

        assertEq(escrow.totalLocked(address(token)), 0);
    }

    /// totalLocked is decremented when cancelExpired fires.
    function test_TotalLocked_DecrementedOnCancelExpired() public {
        bytes32 h = _lock();
        (,,,,, uint64 dl,,) = escrow.locks(h);

        vm.warp(dl + escrow.confirmationGrace() + 1);
        escrow.cancelExpired(h);

        assertEq(escrow.totalLocked(address(token)), 0);
    }

    /// skim() on a zero-surplus token reverts with ExceedsSurplus.
    function test_Skim_RevertsWhenNoSurplus() public {
        _lock(); // 100 000 tokens locked — no surplus

        vm.expectRevert(PerihelionEscrow.ExceedsSurplus.selector);
        escrow.skim(address(token), address(this), 1);
    }

    /// skim() can transfer exactly the surplus (direct-sent tokens above locked amount).
    function test_Skim_AllowsSurplusOnly() public {
        bytes32 h = _lock();
        (,,, uint256 locked,,,,) = escrow.locks(h);

        // Simulate surplus: send extra tokens directly to the escrow.
        uint256 surplus = 500;
        token.mint(address(escrow), surplus);

        // Trying to skim more than surplus reverts.
        vm.expectRevert(PerihelionEscrow.ExceedsSurplus.selector);
        escrow.skim(address(token), address(this), surplus + 1);

        // Skimming exactly the surplus succeeds.
        address recipient = address(0xBEEF);
        vm.expectEmit(true, true, false, true);
        emit Skimmed(address(token), recipient, surplus);
        escrow.skim(address(token), recipient, surplus);

        assertEq(token.balanceOf(recipient), surplus);
        // Locked amount still intact.
        assertEq(escrow.totalLocked(address(token)), locked);
    }

    /// skim() reverts when called by non-owner.
    function test_Skim_RevertsWhenNotOwner() public {
        token.mint(address(escrow), 1000);
        vm.prank(address(0xDEAD));
        vm.expectRevert(PerihelionEscrow.NotOwner.selector);
        escrow.skim(address(token), address(0xDEAD), 1);
    }

    // --- Issue #1120: blocklisted recipients fall back to pull payment --------

    /// @dev Locks `_intent()` against a blocklisting token and returns the hash.
    function _lockBlocklist(BlocklistERC20 blk) internal returns (bytes32 h) {
        _allowAsset(address(blk));
        blk.mint(user, 1_000_000);
        vm.prank(user);
        blk.approve(address(escrow), type(uint256).max);

        PerihelionEscrow.Intent memory intent = _intent();
        intent.sourceAsset = address(blk);
        bytes memory sig = _sign(intent);
        h = escrow.hashIntent(intent);
        vm.prank(solver);
        escrow.lock{ value: 0.01 ether }(intent, sig);
    }

    /// A blocklisted solver must not brick FillConfirmed: the release finalises,
    /// the amount is credited to the solver, and totalLocked drops to zero.
    function test_BlocklistedSolver_ReleaseDefersAndIsClaimable() public {
        BlocklistERC20 blk = new BlocklistERC20();
        bytes32 h = _lockBlocklist(blk);
        assertEq(escrow.totalLocked(address(blk)), 100_000);

        blk.setBlocked(solver, true);

        vm.expectEmit(true, true, true, true);
        emit TransferDeferred(h, address(blk), solver, 100_000);
        _confirm(h, solver, 1);

        // Lock is finalised and the invariant holds across the deferral.
        (,,,,,, bool released,) = escrow.locks(h);
        assertTrue(released);
        assertEq(escrow.totalLocked(address(blk)), 0);
        assertEq(escrow.claimable(address(blk), solver), 100_000);
        assertEq(blk.balanceOf(solver), 0);

        // Still blocked: the claim reverts and nothing is lost.
        vm.prank(solver);
        vm.expectRevert();
        escrow.claim(address(blk), solver);

        // Once unblocked, the solver pulls the funds — to a different address.
        blk.setBlocked(solver, false);
        address fresh = address(0xF00D);
        vm.expectEmit(true, true, false, true);
        emit Claimed(address(blk), fresh, 100_000);
        vm.prank(solver);
        escrow.claim(address(blk), fresh);

        assertEq(blk.balanceOf(fresh), 100_000);
        assertEq(escrow.claimable(address(blk), solver), 0);
        assertEq(escrow.totalLocked(address(blk)), 0);
    }

    /// A blocklisted user must not brick CancelIntent: the refund finalises and
    /// the amount becomes claimable.
    function test_BlocklistedUser_CancelIntentDefersAndIsClaimable() public {
        BlocklistERC20 blk = new BlocklistERC20();
        bytes32 h = _lockBlocklist(blk);

        blk.setBlocked(user, true);

        vm.expectEmit(true, true, true, true);
        emit TransferDeferred(h, address(blk), user, 100_000);
        _cancel(h, 1);

        (,,,,,,, bool refunded) = escrow.locks(h);
        assertTrue(refunded);
        assertEq(escrow.totalLocked(address(blk)), 0);
        assertEq(escrow.claimable(address(blk), user), 100_000);

        blk.setBlocked(user, false);
        address fresh = address(0xF00D);
        vm.prank(user);
        escrow.claim(address(blk), fresh);
        assertEq(blk.balanceOf(fresh), 100_000);
        assertEq(escrow.claimable(address(blk), user), 0);
    }

    /// A blocklisted user must not brick cancelExpired: the refund finalises and
    /// the amount becomes claimable.
    function test_BlocklistedUser_CancelExpiredDefersAndIsClaimable() public {
        BlocklistERC20 blk = new BlocklistERC20();
        bytes32 h = _lockBlocklist(blk);
        PerihelionEscrow.Intent memory intent = _intent();

        blk.setBlocked(user, true);

        vm.warp(intent.deadline + escrow.confirmationGrace());
        vm.expectEmit(true, true, true, true);
        emit TransferDeferred(h, address(blk), user, 100_000);
        escrow.cancelExpired(h);

        (,,,,,,, bool refunded) = escrow.locks(h);
        assertTrue(refunded);
        assertEq(escrow.totalLocked(address(blk)), 0);
        assertEq(escrow.claimable(address(blk), user), 100_000);

        blk.setBlocked(user, false);
        address fresh = address(0xF00D);
        vm.prank(user);
        escrow.claim(address(blk), fresh);
        assertEq(blk.balanceOf(fresh), 100_000);
        assertEq(escrow.claimable(address(blk), user), 0);
    }

    /// claim() with nothing credited reverts.
    function test_RevertWhen_ClaimNothingOwed() public {
        vm.prank(solver);
        vm.expectRevert(PerihelionEscrow.NothingToClaim.selector);
        escrow.claim(address(token), solver);
    }
}
