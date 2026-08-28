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
///
///      ## Token compatibility
///      The measured-delta accounting at lock time handles fee-on-transfer tokens
///      correctly by recording the exact amount received. However, this contract
///      is NOT compatible with rebasing tokens (e.g., stETH) or tokens whose
///      balance changes after deposit (e.g., deflationary supply adjustments).
///      For such tokens, the balance attributable to a lock can drift between
///      lock and release, potentially causing a release/refund to fail
///      (insufficient balance) or succeed by drawing on another lock's fungible
///      balance. The `skim` function recovers surplus that cannot be attributed
///      to any active lock (e.g., from a rebase-up). Rebase-down scenarios can
///      result in stuck funds — operators should gate listed assets accordingly.
///
///      ## Event Shape Specification (issue #102)
///      Events are the off-chain integration surface for indexers, relayers, and
///      monitoring tooling. Each event shape below is a VERSIONED INTERFACE.
///      Changes to event topics or payloads MUST be reflected in the Soroban
///      contract (see `contracts/soroban/settlement/src/lib.rs`).
///
///      | Event                  | Topics                                              | Data                          |
///      |------------------------|-----------------------------------------------------|-------------------------------|
///      | Locked                 | intentHash, solver, user                             | asset, amount                 |
///      | Released               | intentHash, solver                                  | amount, fillAmount, fillLedger |
///      | Refunded               | intentHash, user                                    | amount, reason                |
///      | PeerSet                | -                                                   | peer                          |
///      | ConfirmationGraceSet   | -                                                   | secondsGrace                  |
///      | GuardianSet            | guardian                                            | -                             |
///      | PausedSet              | -                                                   | paused                        |
///      | OwnershipTransferStart | previousOwner, newOwner                             | -                             |
///      | OwnershipTransferred   | previousOwner, newOwner                             | -                             |
///      | OwnershipTransferCancel| previousOwner                                       | -                             |
///      | Skimmed                | token, to                                           | amount                        |
///      | MaxIntentAmountSet     | -                                                   | maxAmount                     |
///      | RollingWindowCapSet    | -                                                   | duration, cap                 |
///      | RollingWindowCapTriggered | windowStart                                      | accumulated                   |
///      | RollingWindowCapReset  | -                                                   | -                             |
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
        /// @dev 256-bit random value that distinguishes otherwise-identical intents.
        ///      This is the *collision-prevention* nonce, not the replay-protection
        ///      nonce. Two intents with identical fields but different nonces hash to
        ///      different intent_hash values, so a user can bridge the same amount twice
        ///      without the second intent colliding with the first.
        ///      Transport-layer replay is prevented separately by `inboundNonce`.
        ///      See docs/TECHNICAL-ARCHITECTURE.md §11.
        uint256 nonce;
        address preferredSolver;
    }

    struct Lock {
        address solver;
        address user;
        address asset;
        /// @dev Measured-delta amount received at lock time (fee-on-transfer safe).
        ///      REBASING TOKENS ARE INCOMPATIBLE: the balance attributable to this
        ///      lock can drift post-lock due to supply adjustments. See contract
        ///      level NatSpec for details.
        uint256 amount;
        uint128 minDestAmount;
        uint64 deadline;
        bool released;
        bool refunded;
    }

    // --- Constants -----------------------------------------------------------

    bytes32 private constant EIP712_DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    /// @dev Half the secp256k1 curve order. Signatures with s above this are malleable
    ///      (for any (r,s,v) a second (r, n-s, v') recovers the same signer). Rejecting
    ///      high-s follows EIP-2 and matches OpenZeppelin ECDSA. On-chain safety is not
    ///      affected (the intentHash does not commit to the signature), but enforcing
    ///      low-s prevents off-chain deduplicators from being confused by two distinct
    ///      signatures for the same intent.
    uint256 private constant SECP256K1_HALF_ORDER =
        0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    bytes32 private constant INTENT_TYPEHASH = keccak256(
        "Intent(address user,string destination,uint256 sourceChainId,address sourceAsset,uint256 sourceAmount,string destAsset,uint256 minDestAmount,uint256 deadline,uint256 nonce,address preferredSolver)"
    );

    // --- Cancel reason codes (shared taxonomy with the Soroban side) --------

    /// @dev Known cancel reason codes, mirroring the Soroban side.
    uint8 private constant CANCEL_REASON_EXPIRED = 0x00;
    uint8 private constant CANCEL_REASON_ADMIN = 0x01;
    uint8 private constant CANCEL_REASON_INVALID = 0x02;
    /// @dev Local refund fallback: timed out waiting for cross-chain confirmation.
    ///      This value (0xFF) is EVM-only; it does not appear in Soroban messages.
    uint8 private constant CANCEL_REASON_LOCAL_TIMEOUT = 0xFF;

    bytes1 private constant PROTOCOL_VERSION = 0x01;
    bytes1 private constant MSG_FILL_INSTRUCTION = 0x01;
    bytes1 private constant MSG_FILL_CONFIRMED = 0x02;
    bytes1 private constant MSG_CANCEL_INTENT = 0x03;

    /// @notice Upper bound on `confirmationGrace`, so a misconfigured admin can
    ///         never strand a user's local refund indefinitely.
    uint256 public constant MAX_CONFIRMATION_GRACE = 7 days;
    /// @notice Lower bound on `confirmationGrace`. Must exceed worst-case cross-chain
    ///         settlement latency (LayerZero relay + Stellar finality) so that
    ///         `cancelExpired` cannot fire while a valid FillConfirmed is still in
    ///         flight — which would refund the user after the solver has already
    ///         delivered on Stellar, leaving the solver unrepaid.
    uint256 public constant MIN_CONFIRMATION_GRACE = 30 minutes;

    /// @notice Duration a guardian-initiated pause auto-expires without owner
    ///         ratification, and the matching cooldown before the guardian may
    ///         pause again after a TTL-dismissed pause. Together these bound the
    ///         worst-case DoS duty cycle to ≤50 % if the guardian key leaks.
    uint256 public constant GUARDIAN_PAUSE_TTL = 72 hours;

    /// @notice Maximum byte length of `Intent.destination`. A Stellar strkey
    ///         (G.../C...) is exactly 56 characters; longer values are invalid.
    ///         Enforced pre-dispatch so an oversized string cannot inflate the
    ///         LayerZero fee or cause a decode failure on the Soroban side.
    uint256 public constant MAX_DESTINATION_LEN = 56;
    /// @notice Maximum byte length of `Intent.destAsset`. The longest valid form
    ///         is `<CODE>:<ISSUER>` (12 + 1 + 56 = 69 bytes); `"native"` is 6.
    uint256 public constant MAX_DEST_ASSET_LEN = 69;

    // --- Immutable / config --------------------------------------------------

    /// @notice EIP-712 domain separator — binds signatures to this contract and chain.
    ///         Domain: name="Perihelion", version="1", chainId=<deployment chain>, verifyingContract=<this>.
    bytes32 public immutable DOMAIN_SEPARATOR;
    /// @notice Trusted LayerZero endpoint.
    ILayerZeroEndpoint public immutable endpoint;
    /// @notice LayerZero endpoint id of the Stellar settlement contract.
    uint32 public immutable stellarEid;

    /// @notice Protocol admin (peer/config management).
    address public owner;
    /// @notice Pending owner in the two-step ownership handover (zero if none).
    address public pendingOwner;
    /// @notice Emergency guardian. May pause instantly during an incident, but
    ///         cannot unpause or change any config — so it can be a hot key while
    ///         `owner` is a timelock. Resuming always requires `owner`.
    address public guardian;
    /// @notice Trusted Stellar settlement OApp (32-byte LayerZero address).
    bytes32 public stellarPeer;
    /// @notice Extra delay beyond `deadline` before the local refund fallback opens,
    ///         giving an in-flight FillConfirmed time to land first (race guard).
    uint256 public confirmationGrace = 2 hours;
    /// @notice Emergency halt. Blocks new `lock`s and local `cancelExpired` refunds;
    ///         in-flight settlement still completes via `lzReceive` so funds are
    ///         never stranded mid-flight. Mirrors the Soroban side's pause.
    bool public paused;
    /// @notice When a guardian-initiated pause auto-expires (0 if no guardian
    ///         pause is active, or the current pause is owner-controlled).
    uint256 public guardianPauseExpiry;
    /// @notice Earliest timestamp at which the guardian may initiate a new pause,
    ///         set by {decayGuardianPause} to rate-limit post-TTL re-pausing.
    uint256 public guardianPauseCooldownUntil;

    // --- Asset allowlist (issue #335) -------------------------------------------

    /// @notice Mapping of allowed source assets. Only assets in this allowlist can be locked.
    mapping(address => bool) public assetAllowed;
    /// @notice Mapping of per-asset maximum lock amounts. Zero means use global cap.
    mapping(address => uint256) public maxIntentAmountPerAsset;

    // --- Value caps (issue #145) -----------------------------------------------

    /// @notice Maximum amount a single intent can lock. Zero means unlimited.
    ///         Enforced at lock time. Timelock-governed.
    uint256 public maxIntentAmount;
    /// @notice Time window (in seconds) for rolling throughput cap. Zero means disabled.
    uint256 public rollingWindowDuration;
    /// @notice Maximum total value that can be locked within rollingWindowDuration.
    ///         Zero means unlimited. Timelock-governed.
    uint256 public rollingWindowCap;
    /// @notice Whether the rolling-window cap has been triggered (exceeded).
    ///         When true, new locks are paused until the admin resets this flag.
    bool public rollingWindowTriggered;
    /// @notice Earliest timestamp at which rollingWindowTriggered may be reset.
    ///         Prevents spam-resetting the cap within the same window.
    uint256 public rollingWindowResetEarliestAt;

    // --- State ---------------------------------------------------------------

    /// @notice intentHash => escrow position.
    mapping(bytes32 => Lock) public locks;
    /// @notice token => aggregate of all un-finalised Lock.amount values for that token.
    ///         Incremented in lock(), decremented in _onFillConfirmed, _onCancelIntent,
    ///         and cancelExpired. Allows skim() to compute the genuine on-chain surplus
    ///         and prevents the owner from draining active user deposits.
    mapping(address => uint256) public totalLocked;
    /// @notice Rolling-window bucket tracking: window start timestamp => cumulative locked amount.
    ///         Each lock bumps the current window bucket. Windows slide; old buckets are orphaned.
    mapping(uint256 => uint256) private _rollingWindowBuckets;
    /// @notice Latest window start timestamp (memoized for efficiency).
    uint256 private _latestWindowStart;

    /// @notice Lazy-nonce high-water mark per source endpoint id.
    ///
    /// This is the **LayerZero transport nonce** — it prevents the same
    /// LayerZero message from being delivered twice (message-replay protection).
    /// It is NOT the `Intent.nonce` field, which is a 256-bit random value
    /// chosen by the SDK to prevent two otherwise-identical intents from
    /// mapping to the same `intent_hash` (collision prevention).
    ///
    /// Any `origin.nonce <= inboundNonce[origin.srcEid]` is rejected as stale.
    /// The complementary application-layer guard against double-settlement is
    /// `Lock.released` and `Lock.refunded` in each `locks` entry.
    ///
    /// See docs/TECHNICAL-ARCHITECTURE.md §11 for the full anti-replay story.
    mapping(uint32 => uint64) public inboundNonce;
    /// @notice Bitmap-based nonce tracking for unordered delivery (LayerZero
    ///         lazy-nonce model). Each bit represents whether a specific nonce
    ///         has been consumed: word index = nonce / 256, bit index = nonce % 256.
    mapping(uint32 => mapping(uint256 => uint256)) private _inboundNonceBitmap;

    // --- Reentrancy invariant (I-RE) -----------------------------------------
    //
    // Every externally-callable function that moves funds MUST carry the
    // `nonReentrant` modifier. The full list is:
    //
    //   • lock            — pulls the user's token; dispatches FillInstruction.
    //   • lzReceive       — releases or refunds via _onFillConfirmed / _onCancelIntent.
    //   • cancelExpired   — refunds the user after the local-timeout window.
    //
    // Safety of the design rests on this mutex being contract-wide: while any
    // one of these functions is executing, a re-entrant call to any other
    // fund-moving function (e.g. a malicious token callback on transfer) will
    // hit _reentrancy == 1 and revert with Reentrancy().
    //
    // This property is deliberately tested by MaliciousTokenReentrancyTest in
    // the test suite (issue #32). If a new fund-moving function is added it MUST
    // be added to this list and covered by a reentrancy regression test.
    uint256 private _reentrancy;

    // --- Events --------------------------------------------------------------

    event Locked(
        bytes32 indexed intentHash,
        address indexed solver,
        address indexed user,
        address asset,
        uint256 amount
    );
    /// @param fillAmount Stellar-side delivery amount (informational; the escrow releases
    ///                   `l.amount`, not this value — see `_decodeFillConfirmed`).
    /// @param fillLedger Stellar ledger sequence at which the fill was recorded
    ///                   (informational; useful for off-chain dispute resolution and explorer display).
    /// @param minDestAmount Promised minimum delivery amount for verification.
    event Released(
        bytes32 indexed intentHash,
        address indexed solver,
        uint256 amount,
        uint128 fillAmount,
        uint64 fillLedger,
        uint128 minDestAmount
    );
    event Refunded(bytes32 indexed intentHash, address indexed user, uint256 amount, uint8 reason);
    event PeerSet(bytes32 peer);
    event ConfirmationGraceSet(uint256 secondsGrace);
    event GuardianSet(address indexed guardian);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OwnershipTransferCancelled(address indexed previousOwner);
    event Skimmed(address indexed token, address indexed to, uint256 amount);
    event NativeSkimmed(address indexed to, uint256 amount);
    event MaxIntentAmountSet(uint256 maxAmount);
    event RollingWindowCapSet(uint256 duration, uint256 cap);
    event RollingWindowCapTriggered(uint256 windowStart, uint256 accumulated);
    event RollingWindowCapReset();
    event AssetAllowed(address indexed asset, bool allowed);
    event MaxIntentAmountPerAssetSet(address indexed asset, uint256 maxAmount);

    // --- Errors --------------------------------------------------------------

    error AlreadyLocked();
    error NotLocked();
    error InvalidSignature();
    error IntentExpired();
    error WrongChain();
    error NotEndpoint();
    error UntrustedPeer();
    error ReservedForSolver();
    error AlreadyFinalized();
    error DeadlineNotPassed();
    error TransferFailed();
    error NothingReceived();
    error MalformedPayload();
    /// @dev Emitted when the payload version byte is not in the set of accepted versions.
    ///      See architecture spec §3.3.1 for the versioning and upgrade-coordination policy.
    error UnknownVersion();
    error UnknownMessageType();
    error StaleNonce();
    error NotOwner();
    error NotPendingOwner();
    error NotAuthorized();
    error Reentrancy();
    error EnforcedPause();
    error GraceTooLong();
    error GraceTooShort();
    error FeeTooLow();
    error ZeroAddress();
    error SourceChainMismatch();
    error StringFieldEmpty();
    error StringFieldTooLong();
    error GuardianCooldown();
    error PauseNotGuardianInitiated();
    error PauseNotExpired();
    error ExceedsMaxIntentAmount();
    error RollingWindowCapExceeded();
    error RollingWindowCapAlreadyTriggered();
    error RollingWindowNotYetResettable();
    error NativeTransferFailed();
    /// @dev skim() would draw into funds locked by active intents.
    error ExceedsSurplus();
    error AssetNotAllowed();
    error UnderDelivered();

    // --- Modifiers -----------------------------------------------------------

    modifier nonReentrant() {
        if (_reentrancy != 1) revert Reentrancy();
        _reentrancy = 2;
        _;
        _reentrancy = 1;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier whenNotPaused() {
        if (paused) revert EnforcedPause();
        _;
    }

    // --- Constructor ---------------------------------------------------------

    /// @notice Deploy the escrow, binding it to a LayerZero endpoint and Stellar
    ///         destination. Sets the deployer as the initial owner.
    /// @param _endpoint Trusted LayerZero endpoint address.
    /// @param _stellarEid LayerZero endpoint id for the Stellar settlement contract.
    constructor(address _endpoint, uint32 _stellarEid) {
        if (_endpoint == address(0)) revert ZeroAddress();
        endpoint = ILayerZeroEndpoint(_endpoint);
        stellarEid = _stellarEid;
        owner = msg.sender;
        _reentrancy = 1; // 1/2/1 sentinel: slot stays non-zero, each lock/unlock is a warm SSTORE
        emit OwnershipTransferred(address(0), msg.sender);
        DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                EIP712_DOMAIN_TYPEHASH,
                keccak256(bytes("Perihelion")),
                keccak256(bytes("1")),
                block.chainid,
                address(this)
            )
        );
    }

    // --- Admin ---------------------------------------------------------------

    /// @notice Set the trusted Stellar settlement peer.
    /// @param peer 32-byte LayerZero address of the trusted Stellar settlement OApp.
    function setPeer(bytes32 peer) external onlyOwner {
        stellarPeer = peer;
        emit PeerSet(peer);
    }

    /// @notice Tune the local-refund grace period. Bounded by MIN_CONFIRMATION_GRACE
    ///         (so a cancel cannot race an in-flight FillConfirmed) and
    ///         MAX_CONFIRMATION_GRACE (so a misconfiguration cannot strand refunds).
    /// @param secondsGrace New grace period in seconds; must be in [MIN_CONFIRMATION_GRACE, MAX_CONFIRMATION_GRACE].
    function setConfirmationGrace(uint256 secondsGrace) external onlyOwner {
        if (secondsGrace > MAX_CONFIRMATION_GRACE) revert GraceTooLong();
        if (secondsGrace < MIN_CONFIRMATION_GRACE) revert GraceTooShort();
        confirmationGrace = secondsGrace;
        emit ConfirmationGraceSet(secondsGrace);
    }

    /// @notice Set (or clear) the emergency guardian. Owner-only.
    /// @param newGuardian Address of the new guardian (use address(0) to clear).
    function setGuardian(address newGuardian) external onlyOwner {
        guardian = newGuardian;
        emit GuardianSet(newGuardian);
    }

    /// @notice Emergency halt / resume. Blocks new locks and local refunds; does
    ///         not block inbound settlement so in-flight funds still resolve.
    ///         Owner calling this clears any guardian-initiated expiry — if called
    ///         with `true` the pause becomes indefinite; if `false` it also resets
    ///         the guardian cooldown so the guardian remains operational.
    /// @param _paused True to halt new locks and local refunds; false to resume.
    function setPaused(bool _paused) external onlyOwner {
        paused = _paused;
        guardianPauseExpiry = 0; // owner takes full control; no auto-expiry
        if (!_paused) guardianPauseCooldownUntil = 0; // reset cooldown on explicit unpause
        emit PausedSet(_paused);
    }

    /// @notice Instant emergency pause, callable by the owner or the guardian.
    ///         A guardian-initiated pause auto-expires after GUARDIAN_PAUSE_TTL
    ///         unless the owner ratifies it via {setPaused}; an owner-initiated
    ///         pause has no expiry. After a TTL-dismissed guardian pause, the
    ///         guardian is locked out for another GUARDIAN_PAUSE_TTL (cooldown),
    ///         bounding the worst-case DoS duty cycle to ≤50 %.
    function pause() external {
        if (msg.sender != owner && msg.sender != guardian) revert NotAuthorized();
        if (msg.sender == guardian) {
            if (block.timestamp < guardianPauseCooldownUntil) revert GuardianCooldown();
            guardianPauseExpiry = block.timestamp + GUARDIAN_PAUSE_TTL;
        } else {
            guardianPauseExpiry = 0; // owner pause: indefinite, no auto-expiry
        }
        paused = true;
        emit PausedSet(true);
    }

    /// @notice Permissionless: dismisses a guardian-initiated pause once
    ///         GUARDIAN_PAUSE_TTL has elapsed without owner ratification.
    ///         Sets a matching cooldown so the guardian cannot immediately
    ///         re-pause — forcing a TTL-length window for key rotation.
    function decayGuardianPause() external {
        if (guardianPauseExpiry == 0) revert PauseNotGuardianInitiated();
        if (block.timestamp < guardianPauseExpiry) revert PauseNotExpired();
        guardianPauseCooldownUntil = block.timestamp + GUARDIAN_PAUSE_TTL;
        guardianPauseExpiry = 0;
        paused = false;
        emit PausedSet(false);
    }

    // --- Asset allowlist (issue #335) -------------------------------------------

    /// @notice Set or revoke an asset's allowlist status. Owner-only.
    /// @param asset Address of the ERC-20 token to allow or disallow.
    /// @param allowed True to add to allowlist, false to remove.
    function setAssetAllowed(address asset, bool allowed) external onlyOwner {
        assetAllowed[asset] = allowed;
        emit AssetAllowed(asset, allowed);
    }

    /// @notice Set per-asset maximum lock amount. Owner-only. Overrides global cap.
    /// @param asset Address of the ERC-20 token.
    /// @param maxAmount Maximum lock amount for this asset, or 0 to use global cap.
    function setMaxIntentAmountPerAsset(address asset, uint256 maxAmount) external onlyOwner {
        maxIntentAmountPerAsset[asset] = maxAmount;
        emit MaxIntentAmountPerAssetSet(asset, maxAmount);
    }

    // --- Value caps (issue #145) -----------------------------------------------

    /// @notice Set the maximum amount a single intent can lock. Owner-only.
    ///         Zero means unlimited. Starts conservative; raised as confidence grows.
    /// @param maxAmount Maximum lock amount (in token's native units), or 0 for unlimited.
    function setMaxIntentAmount(uint256 maxAmount) external onlyOwner {
        maxIntentAmount = maxAmount;
        emit MaxIntentAmountSet(maxAmount);
    }

    /// @notice Set the rolling-window aggregate throughput cap. Owner-only.
    ///         When exceeded, new locks are paused until the admin manually resets.
    ///         Existing in-flight settlement still completes (caps gate only new locks).
    /// @param _windowDuration Duration of each rolling window in seconds (e.g., 1 day).
    ///                        Zero disables the rolling-window cap.
    /// @param _cap Maximum aggregate locked amount within each window (in token's native units).
    ///             Zero means unlimited. Ignored if windowDuration is zero.
    function setRollingWindowCap(uint256 _windowDuration, uint256 _cap) external onlyOwner {
        rollingWindowDuration = _windowDuration;
        rollingWindowCap = _cap;
        emit RollingWindowCapSet(_windowDuration, _cap);
    }

    /// @notice Admin-only: reset the rolling-window cap trigger if it has been
    ///         exceeded. Can only be called after rollingWindowResetEarliestAt passes
    ///         to prevent spam. Increases the window start to the current time so a
    ///         fresh window tracking begins.
    function resetRollingWindowCap() external onlyOwner {
        if (block.timestamp < rollingWindowResetEarliestAt) {
            revert RollingWindowNotYetResettable();
        }
        rollingWindowTriggered = false;
        if (rollingWindowDuration > 0) {
            uint256 windowStart = (block.timestamp / rollingWindowDuration) * rollingWindowDuration;
            delete _rollingWindowBuckets[windowStart];
        }
        _latestWindowStart = 0; // reset memoized window, forces recalc on next lock
        emit RollingWindowCapReset();
    }

    /// @notice Begin a two-step ownership handover. `newOwner` must call
    ///         {acceptOwnership} to take effect. To cancel a pending handover
    ///         with a clear event, use {cancelOwnershipTransfer} instead of
    ///         passing `address(0)`.
    /// @param newOwner Address to propose as the new owner.
    function transferOwnership(address newOwner) external onlyOwner {
        pendingOwner = newOwner;
        emit OwnershipTransferStarted(owner, newOwner);
    }

    /// @notice Cancel a pending ownership handover. Emits a distinct cancellation
    ///         event so off-chain monitors can clearly distinguish a cancellation
    ///         from a transfer-to-zero. Reverts if no handover is pending.
    function cancelOwnershipTransfer() external onlyOwner {
        if (pendingOwner == address(0)) revert NotOwner();
        pendingOwner = address(0);
        emit OwnershipTransferCancelled(owner);
    }

    /// @notice Complete a pending ownership handover. Callable only by the
    ///         address nominated in {transferOwnership}.
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        address previous = owner;
        owner = pendingOwner;
        pendingOwner = address(0);
        emit OwnershipTransferred(previous, owner);
    }

    /// @notice Recover surplus tokens accidentally held by the contract (e.g., from
    ///         rebasing tokens that increased in value, or direct transfers). This
    ///         contract is NOT compatible with rebasing/deflationary tokens; this
    ///         function is provided only to recover surplus that cannot be attributed
    ///         to any active lock. Owner-only.
    /// @dev    Bounded by the genuine on-chain surplus: balanceOf(this) - totalLocked[token].
    ///         This prevents the owner (even via a timelock) from draining funds that
    ///         belong to active intents. The totalLocked invariant is maintained by
    ///         lock(), _onFillConfirmed(), _onCancelIntent(), and cancelExpired().
    /// @param token ERC-20 token to recover.
    /// @param to Recipient address.
    /// @param amount Amount to transfer; must not exceed the surplus.
    function skim(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        uint256 bal = IERC20(token).balanceOf(address(this));
        uint256 locked = totalLocked[token];
        uint256 surplus = bal > locked ? bal - locked : 0;
        if (amount > surplus) revert ExceedsSurplus();
        _safeTransfer(token, to, amount);
        emit Skimmed(token, to, amount);
    }

    /// @notice Recover surplus native ETH held by the contract (e.g. from direct
    ///         transfers or overpaid lock calls that were not refunded locally).
    /// @param to Recipient address.
    /// @param amount Amount of native ETH to transfer.
    function skimNative(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (amount > address(this).balance) revert ExceedsSurplus();
        (bool ok,) = to.call{ value: amount }("");
        if (!ok) revert NativeTransferFailed();
        emit NativeSkimmed(to, amount);
    }

    // --- Lock ----------------------------------------------------------------

    /// @notice Solver claims an intent: verify the user's signature, pull the
    ///         funds (measured-delta), and dispatch FillInstruction to Stellar.
    /// @dev `msg.value` funds the LayerZero send. Call {quoteFee} to size it.
    ///      The LayerZero endpoint is expected to refund any excess nativeFee to
    ///      `msg.sender` (the refundAddress passed to endpoint.send); this is the
    ///      standard V2 convention. Callers should still use {quoteFee} to minimise
    ///      over-payment rather than relying on endpoint refunds.
    ///      The user must have approved this contract for `sourceAmount` of `sourceAsset`.
    /// @param intent The user's signed intent specifying bridge parameters.
    /// @param signature EIP-712 signature over the intent by intent.user.
    function lock(Intent calldata intent, bytes calldata signature)
        external
        payable
        nonReentrant
        whenNotPaused
    {
        if (block.timestamp >= intent.deadline) revert IntentExpired();
        // #39: bind intent to the chain the user signed for.
        if (intent.sourceChainId != block.chainid) revert WrongChain();
        if (intent.preferredSolver != address(0) && intent.preferredSolver != msg.sender) {
            revert ReservedForSolver();
        }
        // Reject oversized strings before paying the cross-chain fee. A Stellar
        // strkey is exactly 56 chars; an asset id is at most CODE:ISSUER = 69.
        // Empty strings are also invalid — they would produce an undecodable payload.
        uint256 dstLen = bytes(intent.destination).length;
        if (dstLen == 0) revert StringFieldEmpty();
        if (dstLen > MAX_DESTINATION_LEN) revert StringFieldTooLong();
        uint256 assetLen = bytes(intent.destAsset).length;
        if (assetLen == 0) revert StringFieldEmpty();
        if (assetLen > MAX_DEST_ASSET_LEN) revert StringFieldTooLong();

        if (!assetAllowed[intent.sourceAsset]) revert AssetNotAllowed();

        bytes32 intentHash = hashIntent(intent);
        if (locks[intentHash].user != address(0)) revert AlreadyLocked();
        if (!_verify(intentHash, intent.user, signature)) revert InvalidSignature();

        // Check value caps before committing to the lock.
        _enforceValueCaps(intent.sourceAmount, intent.sourceAsset);

        // Measured-delta accounting: store exactly what the escrow received, so
        // fee-on-transfer / rebasing tokens can never release more than is held.
        uint256 balBefore = IERC20(intent.sourceAsset).balanceOf(address(this));
        _safeTransferFrom(intent.sourceAsset, intent.user, address(this), intent.sourceAmount);
        uint256 received = IERC20(intent.sourceAsset).balanceOf(address(this)) - balBefore;
        // Measured-delta off a balance diff after the pull is intentional; the
        // exact-zero check rejects transfers that delivered nothing (e.g. a
        // fully-taxed token). Safe under `nonReentrant`.
        // slither-disable-next-line incorrect-equality,reentrancy-balance
        if (received == 0) revert NothingReceived();

        // The lock is written after the pull because measured-delta needs the
        // post-transfer balance; safe because `lock` and every fund-moving path
        // are `nonReentrant`, so the token callback cannot re-enter them.
        // slither-disable-next-line reentrancy-no-eth
        locks[intentHash] = Lock({
            solver: msg.sender,
            user: intent.user,
            asset: intent.sourceAsset,
            amount: received,
            minDestAmount: uint128(intent.minDestAmount),
            deadline: uint64(intent.deadline),
            released: false,
            refunded: false
        });

        // Increment the aggregate liability counter so skim() can compute surplus.
        totalLocked[intent.sourceAsset] += received;

        emit Locked(intentHash, msg.sender, intent.user, intent.sourceAsset, received);

        bytes memory message = _encodeFillInstruction(intentHash, intent);
        MessagingParams memory params = _buildMessagingParams(message, msg.value);
        // Revert early on obvious underpayment rather than letting the endpoint
        // bubble an opaque error. Only the quoted fee is actually sent to the
        // endpoint; any excess is refunded locally to the caller.
        uint256 quoted = endpoint.quote(params, msg.sender).nativeFee;
        if (msg.value < quoted) revert FeeTooLow();
        uint256 refundAmount = msg.value - quoted;
        endpoint.send{ value: quoted }(params, msg.sender);
        if (refundAmount > 0) {
            (bool ok,) = msg.sender.call{ value: refundAmount }("");
            if (!ok) revert NativeTransferFailed();
        }
    }

    // --- Value cap enforcement -----------------------------------------------

    /// @dev Check per-intent and rolling-window value caps. Reverts if exceeded.
    ///      Must be called before the lock is recorded.
    function _enforceValueCaps(uint256 sourceAmount, address asset) private {
        // Check 1: Per-intent maximum (per-asset takes precedence, then global)
        uint256 maxAmount = maxIntentAmountPerAsset[asset] > 0
            ? maxIntentAmountPerAsset[asset]
            : maxIntentAmount;
        if (maxAmount > 0 && sourceAmount > maxAmount) {
            revert ExceedsMaxIntentAmount();
        }

        // Check 2: Rolling-window cap (disabled if duration is zero)
        if (rollingWindowDuration > 0 && rollingWindowCap > 0) {
            // Reject if cap has already been triggered.
            if (rollingWindowTriggered) {
                revert RollingWindowCapAlreadyTriggered();
            }

            // Calculate current window start. Each window spans [windowStart, windowStart + duration).
            uint256 windowStart = (block.timestamp / rollingWindowDuration) * rollingWindowDuration;

            // Advance memoized window if time has moved to a new bucket.
            if (windowStart > _latestWindowStart) {
                _latestWindowStart = windowStart;
                // In a new window; prior bucket is abandoned (orphaned). Restart accumulator.
                delete _rollingWindowBuckets[windowStart - rollingWindowDuration];
            }

            // Accumulate this lock's amount into the current window.
            uint256 accumulated = _rollingWindowBuckets[windowStart] + sourceAmount;
            if (accumulated > rollingWindowCap) {
                // Cap exceeded: trigger halt and record the window + amount for diagnostics.
                rollingWindowTriggered = true;
                rollingWindowResetEarliestAt = block.timestamp + rollingWindowDuration;
                emit RollingWindowCapTriggered(windowStart, accumulated);
                revert RollingWindowCapExceeded();
            }

            // Update the bucket.
            _rollingWindowBuckets[windowStart] = accumulated;
        }
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
        // Bitmap-based nonce tracking supports unordered delivery (LayerZero
        // lazy-nonce model). A nonce is accepted exactly once regardless of
        // delivery order. The high-water mark is updated opportunistically.
        if (origin.nonce == 0 || _isNonceConsumed(origin.srcEid, origin.nonce)) {
            revert StaleNonce();
        }
        _consumeNonce(origin.srcEid, origin.nonce);

        if (message.length < 2) revert MalformedPayload();
        // Accept exactly PROTOCOL_VERSION (currently 0x01). During a version-bump
        // transition window this check widens to accept the previous version as well
        // (see architecture spec §3.3.1 for the rolling-cutover upgrade sequence).
        if (message[0] != PROTOCOL_VERSION) revert UnknownVersion();
        bytes1 msgType = message[1];
        if (msgType == MSG_FILL_CONFIRMED) {
            _onFillConfirmed(message);
        } else if (msgType == MSG_CANCEL_INTENT) {
            _onCancelIntent(message);
        } else {
            revert UnknownMessageType();
        }
        if (msg.value > 0) {
            (bool ok,) = msg.sender.call{ value: msg.value }("");
            if (!ok) revert NativeTransferFailed();
        }
    }

    /// @dev Release destination is `solverEvm` from the Stellar FillConfirmed message,
    ///      NOT `l.solver` (the address that called `lock` on the source chain). This is
    ///      intentional: solvers may operate a hot locking key on EVM and a separate cold
    ///      payout address, supplying the payout address as `solver_evm` in `fill_intent`
    ///      on Stellar. The two addresses can legitimately differ. Solver tooling MUST
    ///      surface both addresses explicitly so operators understand which key receives
    ///      the payout. The on-chain check that prevents theft is the LayerZero peer
    ///      authentication in `lzReceive` — only the trusted Stellar peer can supply
    ///      `solverEvm`, so an attacker cannot redirect funds to an arbitrary address.
    function _onFillConfirmed(bytes calldata message) internal {
        (bytes32 intentHash, address solverEvm, uint128 fillAmount, uint64 fillLedger) =
            _decodeFillConfirmed(message);
        Lock storage l = locks[intentHash];
        if (l.user == address(0)) revert NotLocked();
        if (l.released || l.refunded) revert AlreadyFinalized();
        if (fillAmount < l.minDestAmount) revert UnderDelivered();

        l.released = true; // effect before interaction (race guard)
        totalLocked[l.asset] -= l.amount;
        _safeTransfer(l.asset, solverEvm, l.amount);
        emit Released(intentHash, solverEvm, l.amount, fillAmount, fillLedger, l.minDestAmount);
    }

    function _onCancelIntent(bytes calldata message) internal {
        (bytes32 intentHash, uint8 reason) = _decodeCancelIntent(message);
        Lock storage l = locks[intentHash];
        if (l.user == address(0)) revert NotLocked();
        if (l.released || l.refunded) revert AlreadyFinalized();

        l.refunded = true;
        totalLocked[l.asset] -= l.amount;
        _safeTransfer(l.asset, l.user, l.amount);
        emit Refunded(intentHash, l.user, l.amount, reason);
    }

    // --- Refund fallback -----------------------------------------------------

    /// @notice Permissionless local refund fallback (issue #175). Callable by anyone
    ///         once `deadline + confirmationGrace` has elapsed. Refunds the locked funds
    ///         to the user, providing the ultimate liveness guarantee for the protocol.
    ///
    /// This is the **guaranteed refund path**: if a FillConfirmed message fails to
    /// arrive from Stellar within the grace period, anyone can call this function
    /// to recover the user's funds to prevent permanent loss.
    ///
    /// # Keeper model (issue #175)
    /// This function is permissionless: any address can call it and refund any user.
    /// The caller pays gas but receives no direct incentive. In practice, this means:
    ///
    /// **Primary caller (self-serve)**: The user (or an SDK/UI helper on their behalf)
    /// detects an expired, unrefunded intent via the SDK's `waitForSettlement` status
    /// query and calls `cancelExpired`. This is the expected and robust path:
    /// users have access to the SDK, full information about their intents, and
    /// motivation to recover their own funds.
    ///
    /// **Fallback (keeper/third-party)**: If the user is offline or unaware the
    /// settlement failed, a keeper or relayer can recover their funds as a service
    /// (possibly off-chain monitored). The protocol offers no incentive for this,
    /// so it is best-effort only — do not rely on third-party keepers for liveness.
    ///
    /// # Liveness guarantee
    /// The refund IS guaranteed to be available (barring contract pause) once the
    /// grace period elapses. The guarantee is ENFORCED by the user's SDK helper
    /// or a front-end integration that watches for expired intents. Liveness is
    /// a **user responsibility**, not a protocol feature. If neither the user nor
    /// any keeper calls `cancelExpired`, the funds remain locked until the grace
    /// period expires naturally (but they will still be recoverable at that time).
    ///
    /// Shares the terminal-flag guard with the release path so exactly one terminal
    /// transition wins (I1/I2). Shares reentrancy guard with other fund-moving paths.
    ///
    /// @param intentHash The keccak256 intent commitment identifying the lock.
    function cancelExpired(bytes32 intentHash) external nonReentrant {
        Lock storage l = locks[intentHash];
        if (l.user == address(0)) revert NotLocked();
        if (l.released || l.refunded) revert AlreadyFinalized();
        if (block.timestamp < l.deadline + confirmationGrace) revert DeadlineNotPassed();

        l.refunded = true;
        totalLocked[l.asset] -= l.amount;
        _safeTransfer(l.asset, l.user, l.amount);
        emit Refunded(intentHash, l.user, l.amount, CANCEL_REASON_EXPIRED);
    }

    // --- Views ---------------------------------------------------------------

    /// @notice Quote the LayerZero native fee for a FillInstruction to Stellar.
    ///         Solvers should call this off-chain and pass the result (with a small
    ///         buffer) as `msg.value` to {lock}. Any excess is refunded by the
    ///         endpoint to the caller per the LayerZero V2 convention.
    /// @param intent Intent whose FillInstruction message size determines the fee.
    /// @return nativeFee Estimated native token fee in wei.
    function quoteFee(Intent calldata intent) external view returns (uint256 nativeFee) {
        // Use a placeholder hash — the fee depends only on message size, not content.
        bytes memory message = _encodeFillInstruction(bytes32(0), intent);
        MessagingParams memory params = _buildMessagingParams(message, 0);
        return endpoint.quote(params, msg.sender).nativeFee;
    }

    /// @notice Compute the canonical EIP-712 intent hash (I5).
    /// @param intent The intent to hash.
    /// @return The EIP-712 struct hash.
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

    /// @notice EIP-5267 domain introspection. The `fields` bitmap 0x0f signals
    ///         that name, version, chainId, and verifyingContract are all present.
    ///         Wallets and off-chain tooling can call this to construct the domain
    ///         separator without hard-coding values, and to detect contract/chain
    ///         mismatches before signing.
    function eip712Domain()
        external
        view
        returns (
            bytes1 fields,
            string memory name,
            string memory version,
            uint256 chainId,
            address verifyingContract,
            bytes32 salt,
            uint256[] memory extensions
        )
    {
        return (
            bytes1(0x0f), // bits 0-3: name + version + chainId + verifyingContract
            "Perihelion",
            "1",
            block.chainid,
            address(this),
            bytes32(0),
            new uint256[](0)
        );
    }

    // --- Internal: codec -----------------------------------------------------

    /// @dev Build MessagingParams for a FillInstruction message. Used by both lock
    ///      (with actual nativeFee) and quoteFee (with nativeFee=0) to ensure consistent params.
    function _buildMessagingParams(bytes memory message, uint256 nativeFee)
        internal
        view
        returns (MessagingParams memory)
    {
        return MessagingParams({
            dstEid: stellarEid,
            receiver: stellarPeer,
            message: message,
            nativeFee: nativeFee
        });
    }

    /// @dev Encode a FillInstruction payload (227 bytes) using the fixed big-endian
    ///      layout from architecture spec §3.3, matching the Soroban decoder byte-for-byte:
    ///
    ///      version(1) | type(1) | intent_hash(32) | src_eid(4) | recipient(56)
    ///        | dest_asset(69) | min_dest_amount(16) | deadline(8) | preferred_solver(32)
    ///        | reservation_window(8)
    ///
    ///      `intent.destination` is a Stellar strkey (exactly 56 chars) encoded as a
    ///      fixed 56-byte field (zero-padded on the right if shorter — should never happen
    ///      given the pre-dispatch length check).
    ///      `intent.destAsset` is up to 69 bytes (`CODE:ISSUER` or `"native"`) encoded as
    ///      a fixed 69-byte field (zero-padded on the right). Using the full 69 bytes
    ///      prevents truncation of CODE:ISSUER assets whose ISSUER runs past byte 32.
    ///      `intent.preferredSolver` is an EVM address left-padded to 32 bytes; all-zeros
    ///      signals "open" (no preferred solver) on the Soroban side.
    function _encodeFillInstruction(
        bytes32 intentHash,
        Intent calldata intent
    )
        internal
        view
        returns (bytes memory)
    {
        // Encode destination as a fixed 56-byte field (right-zero-padded).
        bytes memory destBytes = bytes(intent.destination);
        bytes memory recipientField = new bytes(56);
        uint256 dstCopy = destBytes.length < 56 ? destBytes.length : 56;
        for (uint256 i = 0; i < dstCopy; i++) {
            recipientField[i] = destBytes[i];
        }

        // Encode destAsset as a fixed 69-byte field (right-zero-padded).
        // Using abi.encodePacked instead of a bare mload avoids truncating
        // CODE:ISSUER assets whose ISSUER bytes extend past position 32.
        bytes memory destAssetBytes = bytes(intent.destAsset);
        bytes memory destAssetField = new bytes(69);
        uint256 assetCopy = destAssetBytes.length < 69 ? destAssetBytes.length : 69;
        for (uint256 i = 0; i < assetCopy; i++) {
            destAssetField[i] = destAssetBytes[i];
        }

        // Encode preferredSolver: EVM address left-padded to 32 bytes (zeros = open).
        bytes32 solverWord = bytes32(uint256(uint160(intent.preferredSolver)));

        return abi.encodePacked(
            PROTOCOL_VERSION,     // 1  byte  offset 0
            MSG_FILL_INSTRUCTION, // 1  byte  offset 1
            intentHash,           // 32 bytes offset 2
            uint32(stellarEid),   // 4  bytes offset 34
            recipientField,       // 56 bytes offset 38
            destAssetField,       // 69 bytes offset 94
            uint128(intent.minDestAmount), // 16 bytes offset 163
            uint64(intent.deadline),       // 8  bytes offset 179
            solverWord,           // 32 bytes offset 187
            uint64(0)              // 8 bytes offset 219; no reservation in legacy EVM intents
            // reservation_window is explicit and zero until the signed EVM intent schema adds it.
            //                                 total       227
        );
    }

    /// @dev Decode a 90-byte FillConfirmed:
    ///      version(1) | type(1) | intent_hash(32) | solver_evm(32) | fill_amount(16) | fill_ledger(8)
    ///
    ///      Field authority:
    ///      - `intentHash`  — CONSUMED: identifies the lock to release.
    ///      - `solverEvm`   — CONSUMED: payout destination (may differ from the locking solver key).
    ///      - `fillAmount`  — INFORMATIONAL: Stellar-side delivery amount. The escrow releases
    ///                        `l.amount` (the measured-delta locked amount), not this value.
    ///                        Trusting a Stellar-declared amount would be redundant and would open
    ///                        a griefing vector. Decoded and emitted in `Released` so off-chain
    ///                        tooling can reconcile the Stellar fill with the EVM payout without
    ///                        a separate RPC call.
    ///      - `fillLedger`  — INFORMATIONAL: Stellar ledger sequence at which the fill was
    ///                        recorded. Decoded and emitted in `Released` for dispute resolution
    ///                        and explorer display. Not used to gate or size the release.
    function _decodeFillConfirmed(bytes calldata m)
        internal
        pure
        returns (bytes32 intentHash, address solverEvm, uint128 fillAmount, uint64 fillLedger)
    {
        if (m.length != 90) {
            revert MalformedPayload();
        }
        bytes32 hashWord;
        bytes32 solverWord;
        bytes32 amountWord;
        bytes32 ledgerWord;
        assembly {
            hashWord := calldataload(add(m.offset, 2))
            solverWord := calldataload(add(m.offset, 34))
            // offset 66: 16-byte amount occupies the high 16 bytes of the 32-byte load.
            amountWord := calldataload(add(m.offset, 66))
            // offset 82: 8-byte ledger occupies the high 8 bytes of the 32-byte load.
            ledgerWord := calldataload(add(m.offset, 82))
        }
        intentHash = hashWord;
        // Reject non-zero high 12 bytes: a valid EVM address occupies the low 20 bytes
        // (160 bits) of the 32-byte word. Any non-zero bit above that would silently
        // truncate to a different address, potentially redirecting funds.
        if (uint256(solverWord) >> 160 != 0) revert MalformedPayload();
        solverEvm = address(uint160(uint256(solverWord)));
        // High 16 bytes of the 32-byte word loaded at offset 66.
        fillAmount = uint128(uint256(amountWord >> 128));
        // High 8 bytes of the 32-byte word loaded at offset 82.
        fillLedger = uint64(uint256(ledgerWord >> 192));
    }

    /// @dev Decode a 35-byte CancelIntent:
    ///      version(1)|type(1)|intent_hash(32)|reason(1).
    ///      Rejects unknown reason codes to keep the wire contract strict.
    function _decodeCancelIntent(bytes calldata m)
        internal
        pure
        returns (bytes32 intentHash, uint8 reason)
    {
        if (m.length != 35) revert MalformedPayload();
        bytes32 hashWord;
        assembly {
            hashWord := calldataload(add(m.offset, 2))
        }
        intentHash = hashWord;
        reason = uint8(m[34]);
        if (
            reason != CANCEL_REASON_EXPIRED && reason != CANCEL_REASON_ADMIN
                && reason != CANCEL_REASON_INVALID
        ) revert MalformedPayload();
    }

    // --- Internal: nonce bitmap ----------------------------------------------

    /// @dev Check whether a nonce has already been consumed for the given source
    ///      endpoint. Uses a bitmap to allow unordered delivery.
    function _isNonceConsumed(uint32 srcEid, uint64 nonce) private view returns (bool) {
        uint256 wordIndex = uint256(nonce / 256);
        uint256 bitIndex = uint256(nonce % 256);
        return (_inboundNonceBitmap[srcEid][wordIndex] >> bitIndex) & 1 == 1;
    }

    /// @dev Mark a nonce as consumed. Updates both the bitmap and the high-water
    ///      mark (opportunistically, only when nonce advances it).
    function _consumeNonce(uint32 srcEid, uint64 nonce) private {
        uint256 wordIndex = uint256(nonce / 256);
        uint256 bitIndex = uint256(nonce % 256);
        _inboundNonceBitmap[srcEid][wordIndex] |= (1 << bitIndex);
        if (nonce > inboundNonce[srcEid]) {
            inboundNonce[srcEid] = nonce;
        }
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
        // Normalise compact (0/1) → EVM (27/28); reject anything else.
        if (v < 27) v += 27;
        if (v != 27 && v != 28) return false;
        // Reject high-s (malleable) signatures. See SECP256K1_HALF_ORDER comment.
        if (uint256(s) > SECP256K1_HALF_ORDER) return false;
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
