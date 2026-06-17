// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import { IERC20 } from "./IERC20.sol";
import {
    Origin,
    MessagingParams,
    ILayerZeroEndpoint,
    ILayerZeroReceiver
} from "./interfaces/ILayerZero.sol";

/// @title Perihelion Escrow
/// @notice Source-chain leg of the Perihelion bridge, and a LayerZero OApp.
///
/// On `lock`, a solver locks the user's signed funds against `intent_hash` and a
/// FillInstruction is dispatched to the Stellar settlement contract. On a verified
/// `FillConfirmed`, the locked funds are released to the solver; on a `CancelIntent`
/// (or the local-timeout fallback `cancelExpired`), they are refunded to the user.
///
/// @dev The EIP-712 domain/type is byte-identical to `@perihelion/sdk` and the
///      Soroban side (Invariant I5). Inbound FillConfirmed/CancelIntent use the
///      fixed binary layout the Soroban contract emits (architecture spec §3.3).
contract PerihelionEscrow is ILayerZeroReceiver {
    // --- Types ---------------------------------------------------------------

    struct Intent {
        address user;
        string destination;
        uint256 sourceChainId;
        address sourceAsset;
        uint256 sourceAmount;
        string destAsset;
        uint256 minDestAmount;
        uint256 deadline;
        uint256 nonce;
        address preferredSolver;
    }

    struct Lock {
        address solver;
        address user;
        address asset;
        uint256 amount; // measured-delta amount actually held
        uint256 deadline;
        bool released;
        bool refunded;
    }

    // --- Constants -----------------------------------------------------------

    bytes32 private constant EIP712_DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version)");

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "Intent(address user,string destination,uint256 sourceChainId,address sourceAsset,uint256 sourceAmount,string destAsset,uint256 minDestAmount,uint256 deadline,uint256 nonce,address preferredSolver)"
    );

    bytes1 private constant PROTOCOL_VERSION = 0x01;
    bytes1 private constant MSG_FILL_INSTRUCTION = 0x01;
    bytes1 private constant MSG_FILL_CONFIRMED = 0x02;
    bytes1 private constant MSG_CANCEL_INTENT = 0x03;

    // --- Immutable / config --------------------------------------------------

    /// @notice EIP-712 domain separator (name="Perihelion", version="1").
    bytes32 public immutable DOMAIN_SEPARATOR;
    /// @notice Trusted LayerZero endpoint.
    ILayerZeroEndpoint public immutable endpoint;
    /// @notice LayerZero endpoint id of the Stellar settlement contract.
    uint32 public immutable stellarEid;

    /// @notice Protocol admin (peer/config management).
    address public owner;
    /// @notice Trusted Stellar settlement OApp (32-byte LayerZero address).
    bytes32 public stellarPeer;
    /// @notice Extra delay beyond `deadline` before the local refund fallback opens,
    ///         giving an in-flight FillConfirmed time to land first (race guard).
    uint256 public confirmationGrace = 2 hours;

    // --- State ---------------------------------------------------------------

    /// @notice intentHash => escrow position.
    mapping(bytes32 => Lock) public locks;
    /// @notice Lazy-nonce high-water mark per source endpoint id.
    mapping(uint32 => uint64) public inboundNonce;

    uint256 private _reentrancy;

    // --- Events --------------------------------------------------------------

    event Locked(
        bytes32 indexed intentHash,
        address indexed solver,
        address indexed user,
        address asset,
        uint256 amount
    );
    event Released(bytes32 indexed intentHash, address indexed solver, uint256 amount);
    event Refunded(bytes32 indexed intentHash, address indexed user, uint256 amount);
    event PeerSet(bytes32 peer);

    // --- Errors --------------------------------------------------------------

    error AlreadyLocked();
    error NotLocked();
    error InvalidSignature();
    error IntentExpired();
    error NotEndpoint();
    error UntrustedPeer();
    error ReservedForSolver();
    error AlreadyFinalized();
    error DeadlineNotPassed();
    error TransferFailed();
    error NothingReceived();
    error MalformedPayload();
    error UnknownMessageType();
    error StaleNonce();
    error NotOwner();
    error Reentrancy();

    // --- Modifiers -----------------------------------------------------------

    modifier nonReentrant() {
        if (_reentrancy == 1) revert Reentrancy();
        _reentrancy = 1;
        _;
        _reentrancy = 0;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    // --- Constructor ---------------------------------------------------------

    constructor(address _endpoint, uint32 _stellarEid) {
        endpoint = ILayerZeroEndpoint(_endpoint);
        stellarEid = _stellarEid;
        owner = msg.sender;
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Perihelion")),
                keccak256(bytes("1"))
            )
        );
    }

    // --- Admin ---------------------------------------------------------------

    /// @notice Set the trusted Stellar settlement peer.
    function setPeer(bytes32 peer) external onlyOwner {
        stellarPeer = peer;
        emit PeerSet(peer);
    }

    /// @notice Tune the local-refund grace period.
    function setConfirmationGrace(uint256 secondsGrace) external onlyOwner {
        confirmationGrace = secondsGrace;
    }

    /// @notice Transfer ownership.
    function transferOwnership(address newOwner) external onlyOwner {
        owner = newOwner;
    }

    // --- Lock ----------------------------------------------------------------

    /// @notice Solver claims an intent: verify the user's signature, pull the
    ///         funds (measured-delta), and dispatch FillInstruction to Stellar.
    /// @dev `msg.value` funds the LayerZero send. The user must have approved
    ///      this contract for `sourceAmount` of `sourceAsset`.
    function lock(Intent calldata intent, bytes calldata signature) external payable nonReentrant {
        if (block.timestamp >= intent.deadline) revert IntentExpired();
        if (intent.preferredSolver != address(0) && intent.preferredSolver != msg.sender) {
            revert ReservedForSolver();
        }

        bytes32 intentHash = hashIntent(intent);
        if (locks[intentHash].user != address(0)) revert AlreadyLocked();
        if (!_verify(intentHash, intent.user, signature)) revert InvalidSignature();

        // Measured-delta accounting: store exactly what the escrow received, so
        // fee-on-transfer / rebasing tokens can never release more than is held.
        uint256 balBefore = IERC20(intent.sourceAsset).balanceOf(address(this));
        _safeTransferFrom(intent.sourceAsset, intent.user, address(this), intent.sourceAmount);
        uint256 received = IERC20(intent.sourceAsset).balanceOf(address(this)) - balBefore;
        if (received == 0) revert NothingReceived();

        locks[intentHash] = Lock({
            solver: msg.sender,
            user: intent.user,
            asset: intent.sourceAsset,
            amount: received,
            deadline: intent.deadline,
            released: false,
            refunded: false
        });

        emit Locked(intentHash, msg.sender, intent.user, intent.sourceAsset, received);

        bytes memory message = _encodeFillInstruction(intentHash, intent, received);
        MessagingParams memory params = MessagingParams({
            dstEid: stellarEid,
            receiver: stellarPeer,
            message: message,
            nativeFee: msg.value
        });
        endpoint.send{ value: msg.value }(params, msg.sender);
    }

    // --- LayerZero inbound ---------------------------------------------------

    /// @inheritdoc ILayerZeroReceiver
    function lzReceive(
        Origin calldata origin,
        bytes32, /* guid */
        bytes calldata message,
        address, /* executor */
        bytes calldata /* extraData */
    ) external payable nonReentrant {
        if (msg.sender != address(endpoint)) revert NotEndpoint();
        if (origin.sender != stellarPeer) revert UntrustedPeer();
        if (origin.nonce <= inboundNonce[origin.srcEid]) revert StaleNonce();
        inboundNonce[origin.srcEid] = origin.nonce;

        if (message.length < 2 || message[0] != PROTOCOL_VERSION) revert MalformedPayload();
        bytes1 msgType = message[1];
        if (msgType == MSG_FILL_CONFIRMED) {
            _onFillConfirmed(message);
        } else if (msgType == MSG_CANCEL_INTENT) {
            _onCancelIntent(message);
        } else {
            revert UnknownMessageType();
        }
    }

    function _onFillConfirmed(bytes calldata message) internal {
        (bytes32 intentHash, address solverEvm) = _decodeFillConfirmed(message);
        Lock storage l = locks[intentHash];
        if (l.user == address(0)) revert NotLocked();
        if (l.released || l.refunded) revert AlreadyFinalized();

        l.released = true; // effect before interaction (race guard)
        _safeTransfer(l.asset, solverEvm, l.amount);
        emit Released(intentHash, solverEvm, l.amount);
    }

    function _onCancelIntent(bytes calldata message) internal {
        bytes32 intentHash = _decodeCancelIntent(message);
        Lock storage l = locks[intentHash];
        if (l.user == address(0)) revert NotLocked();
        if (l.released || l.refunded) revert AlreadyFinalized();

        l.refunded = true;
        _safeTransfer(l.asset, l.user, l.amount);
        emit Refunded(intentHash, l.user, l.amount);
    }

    // --- Refund fallback -----------------------------------------------------

    /// @notice Permissionless local refund if no settlement landed within
    ///         `deadline + confirmationGrace`. Shares the terminal-flag guard with
    ///         the release path so exactly one terminal transition wins (I1/I2).
    function cancelExpired(bytes32 intentHash) external nonReentrant {
        Lock storage l = locks[intentHash];
        if (l.user == address(0)) revert NotLocked();
        if (l.released || l.refunded) revert AlreadyFinalized();
        if (block.timestamp < l.deadline + confirmationGrace) revert DeadlineNotPassed();

        l.refunded = true;
        _safeTransfer(l.asset, l.user, l.amount);
        emit Refunded(intentHash, l.user, l.amount);
    }

    // --- Views ---------------------------------------------------------------

    /// @notice Compute the canonical EIP-712 intent hash (I5).
    function hashIntent(Intent calldata intent) public view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                INTENT_TYPEHASH,
                intent.user,
                keccak256(bytes(intent.destination)),
                intent.sourceChainId,
                intent.sourceAsset,
                intent.sourceAmount,
                keccak256(bytes(intent.destAsset)),
                intent.minDestAmount,
                intent.deadline,
                intent.nonce,
                intent.preferredSolver
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    // --- Internal: codec -----------------------------------------------------

    /// @dev FillInstruction body is ABI-encoded pending the final Soroban LayerZero
    ///      ABI (the Stellar side decodes it at the adapter boundary). The header
    ///      mirrors the shared 2-byte `version|type` framing.
    function _encodeFillInstruction(bytes32 intentHash, Intent calldata intent, uint256 received)
        internal
        view
        returns (bytes memory)
    {
        bytes memory body = abi.encode(
            intentHash,
            stellarEid,
            intent.destination,
            intent.destAsset,
            received,
            intent.minDestAmount,
            intent.deadline,
            intent.preferredSolver
        );
        return abi.encodePacked(PROTOCOL_VERSION, MSG_FILL_INSTRUCTION, body);
    }

    /// @dev Decode a 90-byte FillConfirmed:
    ///      version(1)|type(1)|intent_hash(32)|solver_evm(32)|amount(16)|ledger(8).
    function _decodeFillConfirmed(bytes calldata m)
        internal
        pure
        returns (bytes32 intentHash, address solverEvm)
    {
        if (m.length != 90) revert MalformedPayload();
        bytes32 hashWord;
        bytes32 solverWord;
        assembly {
            hashWord := calldataload(add(m.offset, 2))
            solverWord := calldataload(add(m.offset, 34))
        }
        intentHash = hashWord;
        solverEvm = address(uint160(uint256(solverWord)));
    }

    /// @dev Decode a 35-byte CancelIntent:
    ///      version(1)|type(1)|intent_hash(32)|reason(1).
    function _decodeCancelIntent(bytes calldata m) internal pure returns (bytes32 intentHash) {
        if (m.length != 35) revert MalformedPayload();
        bytes32 hashWord;
        assembly {
            hashWord := calldataload(add(m.offset, 2))
        }
        intentHash = hashWord;
    }

    // --- Internal: signature & token safety ----------------------------------

    function _verify(bytes32 digest, address signer, bytes calldata signature)
        private
        pure
        returns (bool)
    {
        if (signature.length != 65) return false;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (v < 27) v += 27;
        address recovered = ecrecover(digest, v, r, s);
        return recovered != address(0) && recovered == signer;
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
