// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {GavelGateSplitter} from "../src/GavelGateSplitter.sol";

interface BaseSepoliaSplitterScriptVm {
    function envAddress(string calldata name) external returns (address);
    function startBroadcast() external;
    function stopBroadcast() external;
}

interface TestUSDCMetadata {
    function name() external view returns (string memory);
    function version() external view returns (string memory);
    function decimals() external view returns (uint8);
    function DOMAIN_SEPARATOR() external view returns (bytes32);
}

/// @notice Deploys GavelGateSplitter against an explicitly configured Base Sepolia test token.
/// @dev TEST ONLY. This path never selects or validates production Base native USDC.
contract DeployBaseSepoliaGavelGateSplitter {
    BaseSepoliaSplitterScriptVm private constant vm =
        BaseSepoliaSplitterScriptVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 public constant BASE_SEPOLIA_CHAIN_ID = 84532;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    error InvalidDeploymentConfiguration();
    error InvalidTestUSDC();

    function run() external returns (GavelGateSplitter splitter) {
        splitter = deploy(
            vm.envAddress("BASE_SEPOLIA_TEST_TOKEN"), vm.envAddress("GAVEL_RECIPIENT"), vm.envAddress("QUOTE_SIGNER")
        );
    }

    function deploy(address testToken, address gavelRecipient, address quoteSigner)
        public
        returns (GavelGateSplitter splitter)
    {
        if (
            block.chainid != BASE_SEPOLIA_CHAIN_ID || testToken == address(0) || gavelRecipient == address(0)
                || quoteSigner == address(0)
        ) revert InvalidDeploymentConfiguration();
        _validateTestUsdc(testToken);

        vm.startBroadcast();
        splitter = new GavelGateSplitter(testToken, gavelRecipient, quoteSigner);
        vm.stopBroadcast();

        bytes32 expectedDomain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256("GavelGateSplitter"),
                keccak256("1"),
                BASE_SEPOLIA_CHAIN_ID,
                address(splitter)
            )
        );
        if (
            splitter.usdc() != testToken || splitter.gavelRecipient() != gavelRecipient
                || splitter.quoteSigner() != quoteSigner || splitter.GAVEL_FEE_AMOUNT() != 250_000
                || splitter.DOMAIN_SEPARATOR() != expectedDomain
        ) revert InvalidDeploymentConfiguration();
    }

    function _validateTestUsdc(address testToken) private view {
        if (testToken.code.length == 0) revert InvalidTestUSDC();
        TestUSDCMetadata token = TestUSDCMetadata(testToken);
        try token.name() returns (string memory name) {
            if (keccak256(bytes(name)) != keccak256("USD Coin")) revert InvalidTestUSDC();
        } catch {
            revert InvalidTestUSDC();
        }
        try token.version() returns (string memory version) {
            if (keccak256(bytes(version)) != keccak256("2")) revert InvalidTestUSDC();
        } catch {
            revert InvalidTestUSDC();
        }
        try token.decimals() returns (uint8 decimals) {
            if (decimals != 6) revert InvalidTestUSDC();
        } catch {
            revert InvalidTestUSDC();
        }
        bytes32 expectedDomain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("USD Coin"), keccak256("2"), BASE_SEPOLIA_CHAIN_ID, testToken)
        );
        try token.DOMAIN_SEPARATOR() returns (bytes32 domainSeparator) {
            if (domainSeparator != expectedDomain) revert InvalidTestUSDC();
        } catch {
            revert InvalidTestUSDC();
        }
    }
}
