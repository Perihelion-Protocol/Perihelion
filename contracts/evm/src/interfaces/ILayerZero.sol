// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Origin of an inbound LayerZero message (the subset Perihelion authenticates).
struct Origin {
    uint32 srcEid;
    bytes32 sender;
    uint64 nonce;
}

/// @notice Parameters for an outbound LayerZero send. Minimal, swappable
///         abstraction over the LayerZero V2 endpoint; a thin adapter maps this
///         to the real `MessagingParams` once integrated.
struct MessagingParams {
    uint32 dstEid;
    bytes32 receiver;
    bytes message;
    uint256 nativeFee;
}

/// @notice Fee quote returned by the LayerZero endpoint.
struct MessagingFee {
    uint256 nativeFee;
    uint256 lzTokenFee;
}

/// @notice The endpoint surface the escrow depends on to dispatch messages.
interface ILayerZeroEndpoint {
    /// @dev `refundAddress` receives excess native fee. Returns the message GUID.
    function send(MessagingParams calldata params, address refundAddress)
        external
        payable
        returns (bytes32 guid);

    /// @dev Returns the native fee required for the given outbound message.
    ///      Callers should pass this value (or more) as msg.value to {send};
    ///      any excess is refunded to the `refundAddress` by the endpoint.
    function quote(MessagingParams calldata params, address sender)
        external
        view
        returns (MessagingFee memory fee);
}

/// @notice The receive surface the endpoint invokes on the escrow (OApp).
interface ILayerZeroReceiver {
    function lzReceive(
        Origin calldata origin,
        bytes32 guid,
        bytes calldata message,
        address executor,
        bytes calldata extraData
    ) external payable;
}
