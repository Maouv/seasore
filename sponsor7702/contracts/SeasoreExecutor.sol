// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Delegate target for EIP-7702 wallets (the wallet "borrows" this code).
/// @dev SECURITY: a wallet delegated to this contract can be driven by
///      `trustedCoordinator` (whoever owns that coordinator). Only delegate
///      wallets to an executor whose coordinator YOU own. The wallet's own key
///      can always undo it by delegating to address(0).
contract SeasoreExecutor {
    error NotCoordinator();
    error CallFailed();

    /// @dev Immutable = inlined in bytecode, so it is the same value when this
    ///      code runs in a delegated wallet's context.
    address public immutable trustedCoordinator;

    constructor(address coordinator_) {
        require(coordinator_ != address(0), "zero coordinator");
        trustedCoordinator = coordinator_;
    }

    /// @notice Runs one call as the wallet (msg.sender at the target = the wallet).
    ///         `value` is paid from the wallet's balance, which the coordinator
    ///         tops up with the same call (this function is payable).
    function execute(address to, uint256 value, bytes calldata data) external payable {
        if (msg.sender != trustedCoordinator) revert NotCoordinator();
        (bool ok, bytes memory ret) = to.call{value: value}(data);
        if (!ok) {
            if (ret.length == 0) revert CallFailed();
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    // A delegated wallet has code, so contracts calling _safeMint / safeTransfer
    // on it will call these hooks. Without them such mints would revert.
    function onERC721Received(address, address, uint256, bytes calldata) external pure returns (bytes4) {
        return 0x150b7a02;
    }

    function onERC1155Received(address, address, uint256, uint256, bytes calldata) external pure returns (bytes4) {
        return 0xf23a6e61;
    }

    function onERC1155BatchReceived(address, address, uint256[] calldata, uint256[] calldata, bytes calldata)
        external
        pure
        returns (bytes4)
    {
        return 0xbc197c81;
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x01ffc9a7 || id == 0x4e2312e0;
    }

    receive() external payable {}
}

