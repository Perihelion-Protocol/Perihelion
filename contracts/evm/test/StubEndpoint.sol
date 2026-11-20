// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal LayerZero endpoint for harnesses that only need the constructor
///      to succeed. The escrow constructor calls `setDelegate` on the endpoint, so
///      a bare address (no code) reverts.
contract StubEndpoint {
    function setDelegate(address) external { }
}
