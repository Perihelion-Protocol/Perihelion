// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Official LayerZero V2 origin shape.
struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

/// @notice Official LayerZero V2 MessagingParams shape.
struct MessagingParams {
    uint32 dstEid;
    bytes32 receiver;
    bytes message;
    bytes options;
    bool payInLzToken;
}

/// @notice Official LayerZero V2 fee quote shape.
struct MessagingFee {
    uint256 nativeFee;
    uint256 lzTokenFee;
}

/// @notice Official LayerZero V2 send receipt shape.
struct MessagingReceipt {
    bytes32 guid;
    uint64 nonce;
    MessagingFee fee;
}

/// @notice Minimal official-equivalent LayerZero V2 endpoint surface used by Perihelion.
interface ILayerZeroEndpointV2 {
    function send(MessagingParams calldata _params, address _refundAddress)
        external
        payable
        returns (MessagingReceipt memory receipt);

    function quote(MessagingParams calldata _params, address _sender)
        external
        view
        returns (MessagingFee memory fee);

    function setDelegate(address _delegate) external;
}

/// @notice OApp receiver surface of LayerZero V2, matching the official `ILayerZeroReceiver`.
///         The endpoint calls `allowInitializePath` before it verifies the first packet on a
///         pathway, and `nextNonce` when a receiver uses ordered delivery.
interface ILayerZeroReceiver {
    function lzReceive(
        Origin calldata _origin,
        bytes32 _guid,
        bytes calldata _message,
        address _executor,
        bytes calldata _extraData
    ) external payable;

    /// @notice Whether the endpoint may initialise the pathway `_origin`.
    function allowInitializePath(Origin calldata _origin) external view returns (bool);

    /// @notice Next nonce the receiver expects from `_sender` on `_srcEid`. 0 means unordered.
    function nextNonce(uint32 _srcEid, bytes32 _sender) external view returns (uint64);
}
