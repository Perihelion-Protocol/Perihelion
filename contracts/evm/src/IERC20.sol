// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice EIP-20 token interface. Covers the full ERC-20 spec including optional methods.
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
}

/// @notice Optional EIP-20 metadata. Kept separate from {IERC20} so that minimal
///         tokens (and test mocks) only implement what the escrow actually calls.
interface IERC20Metadata is IERC20 {
    /// @dev Returns the number of decimals the token uses. Optional in EIP-20.
    function decimals() external view returns (uint8);
    /// @dev Returns the name of the token. Optional in EIP-20.
    function name() external view returns (string memory);
    /// @dev Returns the symbol of the token. Optional in EIP-20.
    function symbol() external view returns (string memory);
}
