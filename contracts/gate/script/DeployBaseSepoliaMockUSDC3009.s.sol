// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {MockUSDC3009} from "../test/mocks/MockUSDC3009.sol";

interface BaseSepoliaTokenScriptVm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploys the repository's unrestricted-mint EIP-3009 test token on Base Sepolia only.
/// @dev TEST ONLY. Unrestricted minting makes this token unsafe for production or real value.
contract DeployBaseSepoliaMockUSDC3009 {
    BaseSepoliaTokenScriptVm private constant vm =
        BaseSepoliaTokenScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;

    error InvalidDeploymentChain();

    function run() external returns (MockUSDC3009 token) {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert InvalidDeploymentChain();

        vm.startBroadcast();
        token = new MockUSDC3009();
        vm.stopBroadcast();
    }
}
