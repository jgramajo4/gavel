// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {DeployBaseSepoliaMockUSDC3009} from "../script/DeployBaseSepoliaMockUSDC3009.s.sol";
import {DeployBaseSepoliaGavelGateSplitter} from "../script/DeployBaseSepoliaGavelGateSplitter.s.sol";
import {DeployGavelGateSplitter} from "../script/DeployGavelGateSplitter.s.sol";
import {GavelGateSplitter} from "../src/GavelGateSplitter.sol";
import {MockUSDC3009} from "./mocks/MockUSDC3009.sol";

interface DeploymentVm {
    function chainId(uint256 newChainId) external;
    function expectRevert(bytes4 selector) external;
    function setEnv(string calldata name, string calldata value) external;
    function toString(address value) external pure returns (string memory);
}

contract InvalidTestToken {
    string public constant name = "Not USD Coin";
    string public constant version = "2";
    uint8 public constant decimals = 6;

    function DOMAIN_SEPARATOR() external pure returns (bytes32) {
        return bytes32(0);
    }
}

contract BaseSepoliaDeploymentTest {
    DeploymentVm private constant vm = DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testTestTokenDeploymentRequiresBaseSepoliaAndExposesGateMetadata() public {
        DeployBaseSepoliaMockUSDC3009 script = new DeployBaseSepoliaMockUSDC3009();
        vm.chainId(8453);
        vm.expectRevert(DeployBaseSepoliaMockUSDC3009.InvalidDeploymentChain.selector);
        script.run();

        vm.chainId(84532);
        MockUSDC3009 token = script.run();
        _assertEq(keccak256(bytes(token.name())), keccak256("USD Coin"));
        _assertEq(keccak256(bytes(token.version())), keccak256("2"));
        _assertEq(keccak256(bytes(token.symbol())), keccak256("USDC"));
        _assertEq(token.decimals(), 6);
        _assertEq(
            token.RECEIVE_TYPEHASH(),
            keccak256(
                "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
            )
        );
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USD Coin"),
                keccak256("2"),
                uint256(84532),
                address(token)
            )
        );
        _assertEq(token.DOMAIN_SEPARATOR(), expectedDomain);
    }

    function testProductionAndTestScriptsRejectTheOtherBaseChain() public {
        vm.chainId(84532);
        MockUSDC3009 token = new MockUSDC3009();
        _setCommonConfiguration(address(token));
        DeployGavelGateSplitter productionScript = new DeployGavelGateSplitter();
        DeployBaseSepoliaGavelGateSplitter testScript = new DeployBaseSepoliaGavelGateSplitter();

        vm.expectRevert(DeployGavelGateSplitter.InvalidDeploymentConfiguration.selector);
        productionScript.run();
        _assertEq(testScript.run().usdc(), address(token));

        vm.chainId(8453);
        vm.expectRevert(DeployBaseSepoliaGavelGateSplitter.InvalidDeploymentConfiguration.selector);
        testScript.run();
    }

    function testBaseSepoliaSplitterRejectsZeroToken() public {
        vm.chainId(84532);
        DeployBaseSepoliaGavelGateSplitter script = new DeployBaseSepoliaGavelGateSplitter();
        vm.expectRevert(DeployBaseSepoliaGavelGateSplitter.InvalidDeploymentConfiguration.selector);
        script.deploy(address(0), address(0xBEEF), address(0xCAFE));
    }

    function testBaseSepoliaSplitterRejectsNonContractToken() public {
        vm.chainId(84532);
        DeployBaseSepoliaGavelGateSplitter script = new DeployBaseSepoliaGavelGateSplitter();
        vm.expectRevert(DeployBaseSepoliaGavelGateSplitter.InvalidTestUSDC.selector);
        script.deploy(address(0x1234), address(0xBEEF), address(0xCAFE));
    }

    function testBaseSepoliaSplitterRejectsInvalidTokenMetadata() public {
        vm.chainId(84532);
        DeployBaseSepoliaGavelGateSplitter script = new DeployBaseSepoliaGavelGateSplitter();
        InvalidTestToken token = new InvalidTestToken();
        vm.expectRevert(DeployBaseSepoliaGavelGateSplitter.InvalidTestUSDC.selector);
        script.deploy(address(token), address(0xBEEF), address(0xCAFE));
    }

    function testBaseSepoliaSplitterBindsSuppliedTokenAndFrozenValues() public {
        vm.chainId(84532);
        MockUSDC3009 token = new MockUSDC3009();

        GavelGateSplitter splitter =
            new DeployBaseSepoliaGavelGateSplitter().deploy(address(token), address(0xBEEF), address(0xCAFE));

        _assertEq(splitter.usdc(), address(token));
        _assertEq(splitter.gavelRecipient(), address(0xBEEF));
        _assertEq(splitter.quoteSigner(), address(0xCAFE));
        _assertEq(splitter.GAVEL_FEE_AMOUNT(), 250_000);
        bytes32 expectedDomain = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("GavelGateSplitter"),
                keccak256("1"),
                uint256(84532),
                address(splitter)
            )
        );
        _assertEq(splitter.DOMAIN_SEPARATOR(), expectedDomain);
    }

    function _setCommonConfiguration(address token) private {
        vm.setEnv("BASE_SEPOLIA_TEST_TOKEN", vm.toString(token));
        vm.setEnv("GAVEL_RECIPIENT", vm.toString(address(0xBEEF)));
        vm.setEnv("QUOTE_SIGNER", vm.toString(address(0xCAFE)));
    }

    function _assertEq(address actual, address expected) private pure {
        require(actual == expected, "address mismatch");
    }

    function _assertEq(bytes32 actual, bytes32 expected) private pure {
        require(actual == expected, "bytes32 mismatch");
    }

    function _assertEq(uint256 actual, uint256 expected) private pure {
        require(actual == expected, "uint mismatch");
    }
}
