// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {BaseSepoliaTestUSDC3009} from "../src/test-only/BaseSepoliaTestUSDC3009.sol";

interface BaseSepoliaTokenScriptVm {
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// @notice Deploys the unrestricted-mint Base Sepolia test token on chain 84532 only.
/// @dev TEST ONLY. Anyone can mint; this token is unsafe for production or real value.
contract DeployBaseSepoliaTestUSDC3009 {
    BaseSepoliaTokenScriptVm private constant vm =
        BaseSepoliaTokenScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;

    error InvalidDeploymentChain();

    function run() external returns (BaseSepoliaTestUSDC3009 token) {
        if (block.chainid != BASE_SEPOLIA_CHAIN_ID) revert InvalidDeploymentChain();

        vm.startBroadcast();
        token = new BaseSepoliaTestUSDC3009();
        vm.stopBroadcast();
    }
}
