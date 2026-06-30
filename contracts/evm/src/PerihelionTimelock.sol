// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PerihelionTimelock
/// @notice Minimal M-of-N multisig with a mandatory execution delay, intended to
///         hold the Perihelion escrow's `owner` role.
///
/// Owners co-sign (confirm) an operation identified by the hash of its call. Once
/// `threshold` confirmations are reached the operation becomes *ready* only after
/// `delay` more seconds, giving users a public window to react to a queued admin
/// action (peer rotation, ownership transfer, grace change, unpause). The calldata
/// itself is supplied at execution time and checked against the stored hash, so
/// the contract holds only a commitment, not the payload.
///
/// @dev Configuration (owner set, threshold, delay) is self-administered: those
///      setters are callable only by the timelock itself, so changing the
///      multisig requires going through the same propose → confirm → delay →
///      execute flow. Emergency *pause* of the escrow is intentionally NOT routed
///      here — that is the escrow guardian's instant path; the timelock governs
///      everything that should not be instantaneous.
contract PerihelionTimelock {
    // --- Types ---------------------------------------------------------------

    struct Operation {
        uint64 confirmations;
        uint64 readyAt; // 0 until threshold is reached
        bool executed;
        bool exists;
    }

    // --- Storage -------------------------------------------------------------

    /// @notice Window after `readyAt` during which a confirmed operation may
    ///         still be executed. Past it, `execute` reverts as expired and
    ///         the operation must be re-proposed, so a stale-but-confirmed op
    ///         cannot be executed arbitrarily far in the future.
    uint256 public constant GRACE_PERIOD = 14 days;

    address[] private _owners;
    mapping(address => bool) public isOwner;
    uint256 public threshold;
    uint256 public delay;

    mapping(bytes32 => Operation) public operations;
    mapping(bytes32 => mapping(address => bool)) public confirmedBy;

    uint256 private _reentrancy;

    // --- Events --------------------------------------------------------------

    event Proposed(bytes32 indexed id, address indexed proposer, address target, uint256 value);
    event Confirmed(bytes32 indexed id, address indexed owner, uint256 confirmations);
    event ConfirmationRevoked(bytes32 indexed id, address indexed owner, uint256 confirmations);
    event Ready(bytes32 indexed id, uint256 readyAt);
    event Executed(bytes32 indexed id);
    event Cancelled(bytes32 indexed id);
    event OwnerAdded(address indexed owner);
    event OwnerRemoved(address indexed owner);
    event ThresholdSet(uint256 threshold);
    event DelaySet(uint256 delay);

    // --- Errors --------------------------------------------------------------

    error NotOwner();
    error NotSelf();
    error InvalidConfig();
    error AlreadyOwner();
    error UnknownOperation();
    error AlreadyExists();
    error AlreadyConfirmed();
    error NotConfirmed();
    error AlreadyExecuted();
    error NotReady();
    error NotEnoughConfirmations();
    error CallFailed();
    error Reentrancy();
    error Expired();

    // --- Modifiers -----------------------------------------------------------

    modifier onlyOwner() {
        if (!isOwner[msg.sender]) revert NotOwner();
        _;
    }

    /// @dev Restricts to calls the timelock makes on itself (i.e. via a fully
    ///      confirmed, delayed, executed operation).
    modifier onlySelf() {
        if (msg.sender != address(this)) revert NotSelf();
        _;
    }

    modifier nonReentrant() {
        if (_reentrancy == 1) revert Reentrancy();
        _reentrancy = 1;
        _;
        _reentrancy = 0;
    }

    // --- Constructor ---------------------------------------------------------

    /// @notice Deploy the timelock and configure the initial owner set, threshold,
    ///         and execution delay.
    /// @param owners_ Initial set of multisig owners.
    /// @param threshold_ Minimum confirmations required to execute an operation.
    /// @param delay_ Mandatory delay in seconds between reaching threshold and execution.
    constructor(address[] memory owners_, uint256 threshold_, uint256 delay_) {
        if (owners_.length == 0 || threshold_ == 0 || threshold_ > owners_.length) {
            revert InvalidConfig();
        }
        if (delay_ < MIN_DELAY || delay_ > MAX_DELAY) revert InvalidConfig();
        for (uint256 i = 0; i < owners_.length; i++) {
            address o = owners_[i];
            if (o == address(0) || isOwner[o]) revert InvalidConfig();
            isOwner[o] = true;
            _owners.push(o);
            emit OwnerAdded(o);
        }
        threshold = threshold_;
        delay = delay_;
        emit ThresholdSet(threshold_);
        emit DelaySet(delay_);
    }

    // --- Views ---------------------------------------------------------------

    /// @notice Returns the current set of owner addresses.
    /// @return Array of current owner addresses.
    function owners() external view returns (address[] memory) {
        return _owners;
    }

    /// @notice Returns the number of current owners.
    /// @return Number of current owners.
    function ownerCount() external view returns (uint256) {
        return _owners.length;
    }

    /// @notice Deterministic id binding a call to (target, value, data, salt).
    /// @param target Call target address.
    /// @param value ETH value to forward.
    /// @param data Calldata to execute.
    /// @param salt Uniqueness salt.
    /// @return Deterministic operation id.
    function hashOperation(address target, uint256 value, bytes calldata data, bytes32 salt)
        public
        pure
        returns (bytes32)
    {
        return keccak256(abi.encode(target, value, data, salt));
    }

    /// @notice Timestamp after which a ready operation can no longer be
    ///         executed and must be re-proposed. Returns 0 if the operation
    ///         has not yet reached threshold confirmations.
    /// @param id Operation id.
    /// @return Unix timestamp after which the operation can no longer be executed (0 if not yet ready).
    function expiryOf(bytes32 id) external view returns (uint256) {
        uint64 readyAt = operations[id].readyAt;
        if (readyAt == 0) return 0;
        return readyAt + GRACE_PERIOD;
    }

    // --- Multisig lifecycle --------------------------------------------------

    /// @notice Propose an operation and confirm it as the proposer.
    /// @dev `value` is forwarded verbatim by `execute`. For admin operations
    ///      targeting the governed escrow, `value` should be `0`: none of the
    ///      escrow's owner-only setters are payable, so a non-zero value
    ///      there makes the call revert (`CallFailed`) only after the full
    ///      propose → confirm → delay cycle has elapsed. `value` is meant for
    ///      targets that are actually payable; verify the target accepts ETH
    ///      before proposing a non-zero value.
    /// @param target Call target address.
    /// @param value ETH value to forward.
    /// @param data Calldata to execute.
    /// @param salt Uniqueness salt.
    /// @return id The operation id.
    function propose(address target, uint256 value, bytes calldata data, bytes32 salt)
        external
        onlyOwner
        returns (bytes32 id)
    {
        id = hashOperation(target, value, data, salt);
        Operation storage op = operations[id];
        if (op.exists) revert AlreadyExists();
        op.exists = true;
        emit Proposed(id, msg.sender, target, value);
        _confirm(id);
    }

    /// @notice Add a confirmation to a pending operation.
    /// @param id Operation id to confirm.
    function confirm(bytes32 id) external onlyOwner {
        if (!operations[id].exists) revert UnknownOperation();
        _confirm(id);
    }

    function _confirm(bytes32 id) private {
        Operation storage op = operations[id];
        if (op.executed) revert AlreadyExecuted();
        if (confirmedBy[id][msg.sender]) revert AlreadyConfirmed();
        confirmedBy[id][msg.sender] = true;
        op.confirmations += 1;
        emit Confirmed(id, msg.sender, op.confirmations);
        // Start the timelock the moment the threshold is first reached.
        if (op.readyAt == 0 && op.confirmations >= threshold) {
            op.readyAt = uint64(block.timestamp + delay);
            emit Ready(id, op.readyAt);
        }
    }

    /// @notice Withdraw a confirmation before execution. If this drops the
    ///         operation back below threshold, its timelock is reset.
    /// @param id Operation id to un-confirm.
    function revokeConfirmation(bytes32 id) external onlyOwner {
        Operation storage op = operations[id];
        if (!op.exists) revert UnknownOperation();
        if (op.executed) revert AlreadyExecuted();
        if (!confirmedBy[id][msg.sender]) revert NotConfirmed();
        confirmedBy[id][msg.sender] = false;
        op.confirmations -= 1;
        if (op.confirmations < threshold) op.readyAt = 0;
        emit ConfirmationRevoked(id, msg.sender, op.confirmations);
    }

    /// @notice Execute a confirmed operation once its delay has elapsed.
    /// @param target Call target.
    /// @param value ETH value.
    /// @param data Calldata.
    /// @param salt Salt (must match what was proposed).
    function execute(address target, uint256 value, bytes calldata data, bytes32 salt)
        external
        payable
        onlyOwner
        nonReentrant
    {
        bytes32 id = hashOperation(target, value, data, salt);
        Operation storage op = operations[id];
        if (!op.exists) revert UnknownOperation();
        if (op.executed) revert AlreadyExecuted();
        if (op.confirmations < threshold) revert NotEnoughConfirmations();
        if (op.readyAt == 0 || block.timestamp < op.readyAt) revert NotReady();
        if (block.timestamp > op.readyAt + GRACE_PERIOD) revert Expired();

        op.executed = true; // effect before interaction
        emit Executed(id);
        (bool ok,) = target.call{ value: value }(data);
        if (!ok) revert CallFailed();
    }

    /// @notice Cancel a pending (un-executed) operation. Any owner may cancel.
    /// @param id Operation id to cancel.
    function cancel(bytes32 id) external onlyOwner {
        Operation storage op = operations[id];
        if (!op.exists) revert UnknownOperation();
        if (op.executed) revert AlreadyExecuted();
        delete operations[id];
        emit Cancelled(id);
    }

    // --- Self-administered configuration -------------------------------------

    /// @notice Add a new owner to the multisig. Callable only via a fully
    ///         confirmed, delayed timelock operation (i.e. through this contract itself).
    /// @param owner_ Address to add as an owner.
    function addOwner(address owner_) external onlySelf {
        if (owner_ == address(0)) revert InvalidConfig();
        if (isOwner[owner_]) revert AlreadyOwner();
        isOwner[owner_] = true;
        _owners.push(owner_);
        emit OwnerAdded(owner_);
    }

    /// @notice Remove an owner from the multisig. Reverts if removal would drop
    ///         the owner count below the current threshold. Callable only via a
    ///         fully confirmed, delayed timelock operation.
    /// @param owner_ Address to remove from the owner set.
    function removeOwner(address owner_) external onlySelf {
        if (!isOwner[owner_]) revert NotOwner();
        if (_owners.length - 1 < threshold) revert InvalidConfig();
        isOwner[owner_] = false;
        uint256 n = _owners.length;
        for (uint256 i = 0; i < n; i++) {
            if (_owners[i] == owner_) {
                _owners[i] = _owners[n - 1];
                // Runs at most once (we break right after), so not a costly loop;
                // owners is a small admin set in any case.
                // slither-disable-next-line costly-loop
                _owners.pop();
                break;
            }
        }
        emit OwnerRemoved(owner_);
    }

    /// @notice Update the confirmation threshold. Must remain between 1 and the
    ///         current owner count inclusive. Callable only via a fully confirmed,
    ///         delayed timelock operation.
    /// @param threshold_ New minimum number of confirmations required to execute.
    function setThreshold(uint256 threshold_) external onlySelf {
        if (threshold_ == 0 || threshold_ > _owners.length) revert InvalidConfig();
        threshold = threshold_;
        emit ThresholdSet(threshold_);
    }

    /// @notice Update the mandatory execution delay. Must be within
    ///         [MIN_DELAY, MAX_DELAY]. Callable only via a fully confirmed,
    ///         delayed timelock operation.
    /// @param delay_ New execution delay in seconds.
    function setDelay(uint256 delay_) external onlySelf {
        if (delay_ < MIN_DELAY || delay_ > MAX_DELAY) revert InvalidConfig();
        delay = delay_;
        emit DelaySet(delay_);
    }

    receive() external payable { }
}
