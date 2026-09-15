// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {GavelGateSplitter} from "../src/GavelGateSplitter.sol";

interface ScriptVm {
    function envAddress(string calldata name) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

interface NativeUSDCMetadata {
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

contract DeployGavelGateSplitter {
    ScriptVm private constant vm = ScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    address public constant BASE_NATIVE_USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    uint256 public constant BASE_CHAIN_ID = 8453;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    error InvalidDeploymentConfiguration();
    error InvalidNativeUSDC();

    function run() external returns (GavelGateSplitter splitter) {
        address gavelRecipient = vm.envAddress("GAVEL_RECIPIENT");
        address quoteSigner = vm.envAddress("QUOTE_SIGNER");
        if (block.chainid != BASE_CHAIN_ID || gavelRecipient == address(0) || quoteSigner == address(0)) {
            revert InvalidDeploymentConfiguration();
        }
        _validateNativeUsdc();

        vm.startBroadcast();
        splitter = new GavelGateSplitter(BASE_NATIVE_USDC, gavelRecipient, quoteSigner);
        vm.stopBroadcast();

        if (
            splitter.usdc() != BASE_NATIVE_USDC || splitter.gavelRecipient() != gavelRecipient
                || splitter.quoteSigner() != quoteSigner
        ) revert InvalidDeploymentConfiguration();
    }

    function _validateNativeUsdc() private view {
        if (BASE_NATIVE_USDC.code.length == 0) revert InvalidNativeUSDC();
        NativeUSDCMetadata token = NativeUSDCMetadata(BASE_NATIVE_USDC);
        if (
            keccak256(bytes(token.name())) != keccak256("USD Coin")
                || keccak256(bytes(token.version())) != keccak256("2")
        ) revert InvalidNativeUSDC();
        bytes32 expectedDomain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("USD Coin"), keccak256("2"), BASE_CHAIN_ID, BASE_NATIVE_USDC)
        );
        if (token.DOMAIN_SEPARATOR() != expectedDomain) revert InvalidNativeUSDC();
    }
}
