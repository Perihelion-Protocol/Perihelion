// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal EIP-20 token interface: the required methods the escrow calls.
interface IERC20 {
    // --- Events (required by EIP-20) ---
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    // --- Required functions ---
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function allowance(address owner, address spender) external view returns (uint256);

    // Optional EIP-20 metadata (name/symbol/decimals/totalSupply) is intentionally
    // omitted: the escrow never calls it, and it may revert on some tokens.
}
