// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice EIP-20 core token interface: the surface the escrow uses for transfers and balances.
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

/// @notice Optional EIP-20 metadata. Kept separate so token mocks and minimal tokens
///         only have to implement the core {IERC20} surface.
interface IERC20Metadata is IERC20 {
    /// @dev Returns the number of decimals the token uses. Optional in EIP-20.
    function decimals() external view returns (uint8);
    /// @dev Returns the name of the token. Optional in EIP-20.
    function name() external view returns (string memory);
    /// @dev Returns the symbol of the token. Optional in EIP-20.
    function symbol() external view returns (string memory);
    /// @dev Returns the total supply of the token. Not used by the escrow.
    function totalSupply() external view returns (uint256);
}
