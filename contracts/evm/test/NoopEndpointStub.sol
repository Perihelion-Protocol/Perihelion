// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @dev Minimal endpoint for harnesses that only need the constructor to succeed.
///      The escrow constructor calls `endpoint.setDelegate`, and nothing else.
contract NoopEndpointStub {
    function setDelegate(address) external { }
}
