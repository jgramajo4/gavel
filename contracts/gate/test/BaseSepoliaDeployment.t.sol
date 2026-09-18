// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {DeployBaseSepoliaTestUSDC3009} from "../script/DeployBaseSepoliaTestUSDC3009.s.sol";
import {DeployBaseSepoliaGavelGateSplitter} from "../script/DeployBaseSepoliaGavelGateSplitter.s.sol";
import {DeployGavelGateSplitter} from "../script/DeployGavelGateSplitter.s.sol";
import {GavelGateSplitter} from "../src/GavelGateSplitter.sol";
import {BaseSepoliaTestUSDC3009} from "../src/test-only/BaseSepoliaTestUSDC3009.sol";

interface DeploymentVm {
    function addr(uint256 privateKey) external returns (address);
    function chainId(uint256 newChainId) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function prank(address sender) external;
    function setEnv(string calldata name, string calldata value) external;
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function toString(address value) external pure returns (string memory);
    function warp(uint256 timestamp) external;
}

contract InvalidTestToken {
    string public name;
    string public version;
    uint8 public decimals;
    bool private immutable validDomain;

    constructor(string memory name_, string memory version_, uint8 decimals_, bool validDomain_) {
        name = name_;
        version = version_;
        decimals = decimals_;
        validDomain = validDomain_;
    }

    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        if (!validDomain) return bytes32(0);
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                block.chainid,
                address(this)
            )
        );
    }
}

contract BaseSepoliaDeploymentTest {
    DeploymentVm private constant vm = DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function testTestTokenDeploymentRequiresBaseSepoliaAndExposesGateMetadata() public {
        DeployBaseSepoliaTestUSDC3009 script = new DeployBaseSepoliaTestUSDC3009();
        vm.chainId(8453);
        vm.expectRevert(DeployBaseSepoliaTestUSDC3009.InvalidDeploymentChain.selector);
        script.run();

        vm.chainId(84532);
        BaseSepoliaTestUSDC3009 token = script.run();
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
        _assertEq(token.DOMAIN_SEPARATOR(), _tokenDomain(address(token)));
    }

    function testTestTokenReceiveAuthorizationIsBoundToPayeeDomainTimeNonceSignatureAndBalances() public {
        vm.chainId(84532);
        vm.warp(1_000);
        BaseSepoliaTestUSDC3009 token = new BaseSepoliaTestUSDC3009();
        uint256 payerKey = 0xA11CE;
        address payer = vm.addr(payerKey);
        address payee = address(0xBEEF);
        bytes32 nonce = keccak256("base-sepolia-test-token");
        token.mint(payer, 1_250_000);
        bytes32 structHash = keccak256(abi.encode(token.RECEIVE_TYPEHASH(), payer, payee, 1_250_000, 0, 1_100, nonce));
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(payerKey, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash)));

        vm.prank(payee);
        token.receiveWithAuthorization(payer, payee, 1_250_000, 0, 1_100, nonce, v, r, s);
        _assertEq(token.balanceOf(payer), 0);
        _assertEq(token.balanceOf(payee), 1_250_000);
        require(token.authorizationState(payer, nonce), "authorization not consumed");

        vm.prank(payee);
        vm.expectRevert();
        token.receiveWithAuthorization(payer, payee, 1_250_000, 0, 1_100, nonce, v, r, s);
    }

    function testProductionAndTestScriptsRejectTheOtherBaseChain() public {
        vm.chainId(84532);
        BaseSepoliaTestUSDC3009 token = new BaseSepoliaTestUSDC3009();
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

    function testBaseSepoliaSplitterRejectsZeroRecipient() public {
        vm.chainId(84532);
        BaseSepoliaTestUSDC3009 token = new BaseSepoliaTestUSDC3009();
        DeployBaseSepoliaGavelGateSplitter script = new DeployBaseSepoliaGavelGateSplitter();
        vm.expectRevert(DeployBaseSepoliaGavelGateSplitter.InvalidDeploymentConfiguration.selector);
        script.deploy(address(token), address(0), address(0xCAFE));
    }

    function testBaseSepoliaSplitterRejectsZeroQuoteSigner() public {
        vm.chainId(84532);
        BaseSepoliaTestUSDC3009 token = new BaseSepoliaTestUSDC3009();
        DeployBaseSepoliaGavelGateSplitter script = new DeployBaseSepoliaGavelGateSplitter();
        vm.expectRevert(DeployBaseSepoliaGavelGateSplitter.InvalidDeploymentConfiguration.selector);
        script.deploy(address(token), address(0xBEEF), address(0));
    }

    function testBaseSepoliaSplitterRejectsNonContractToken() public {
        vm.chainId(84532);
        DeployBaseSepoliaGavelGateSplitter script = new DeployBaseSepoliaGavelGateSplitter();
        vm.expectRevert(DeployBaseSepoliaGavelGateSplitter.InvalidTestUSDC.selector);
        script.deploy(address(0x1234), address(0xBEEF), address(0xCAFE));
    }

    function testBaseSepoliaSplitterRejectsWrongTokenName() public {
        _expectInvalidToken(new InvalidTestToken("Not USD Coin", "2", 6, true));
    }

    function testBaseSepoliaSplitterRejectsWrongTokenVersion() public {
        _expectInvalidToken(new InvalidTestToken("USD Coin", "1", 6, true));
    }

    function testBaseSepoliaSplitterRejectsWrongTokenDecimals() public {
        _expectInvalidToken(new InvalidTestToken("USD Coin", "2", 18, true));
    }

    function testBaseSepoliaSplitterRejectsWrongTokenDomain() public {
        vm.chainId(84532);
        InvalidTestToken token = new InvalidTestToken("USD Coin", "2", 6, false);
        require(token.DOMAIN_SEPARATOR() != _tokenDomain(address(token)), "invalid domain fixture unexpectedly valid");
        _expectInvalidToken(token);
    }

    function testBaseSepoliaSplitterBindsSuppliedTokenAndFrozenValues() public {
        vm.chainId(84532);
        BaseSepoliaTestUSDC3009 token = new BaseSepoliaTestUSDC3009();
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

    function _expectInvalidToken(InvalidTestToken token) private {
        vm.chainId(84532);
        DeployBaseSepoliaGavelGateSplitter script = new DeployBaseSepoliaGavelGateSplitter();
        vm.expectRevert(DeployBaseSepoliaGavelGateSplitter.InvalidTestUSDC.selector);
        script.deploy(address(token), address(0xBEEF), address(0xCAFE));
    }

    function _tokenDomain(address token) private pure returns (bytes32) {
        return keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("USD Coin"),
                keccak256("2"),
                uint256(84532),
                token
            )
        );
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
