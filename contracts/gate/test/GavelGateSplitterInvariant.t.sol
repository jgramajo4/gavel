// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {GavelGateSplitter} from "../src/GavelGateSplitter.sol";
import {MockUSDC3009} from "./mocks/MockUSDC3009.sol";

interface InvariantVm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);

    function chainId(uint256 newChainId) external;
    function warp(uint256 timestamp) external;
}

contract SettlementHandler {
    InvariantVm private constant vm = InvariantVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant PAYER_KEY = 0xA11CE;
    uint256 private constant SIGNER_KEY = 0xB0B;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 quoteId,address payer,address voter,uint256 attentionAmount,uint256 gavelFeeAmount,bytes32 submissionHash,address token,uint256 expiry,uint256 quoteVersion)"
    );

    MockUSDC3009 public immutable token;
    GavelGateSplitter public immutable splitter;
    address public immutable payer;
    address public immutable voter;
    uint256 public totalAttention;
    uint256 public totalFees;
    uint256 public totalAuthorized;
    uint256 public settlementCount;

    constructor(MockUSDC3009 token_, GavelGateSplitter splitter_, address voter_) {
        token = token_;
        splitter = splitter_;
        payer = vm.addr(PAYER_KEY);
        voter = voter_;
    }

    function settleRandom(uint96 rawAttention, bytes32 salt) external {
        uint256 attention = uint256(rawAttention) + 1_000_000;
        uint256 total = attention + 250_000;
        bytes32 quoteId = keccak256(abi.encode(salt, settlementCount));
        GavelGateSplitter.Quote memory quote = GavelGateSplitter.Quote({
            quoteId: quoteId,
            payer: payer,
            voter: voter,
            attentionAmount: attention,
            gavelFeeAmount: 250_000,
            submissionHash: keccak256(abi.encode("invariant", quoteId)),
            token: address(token),
            expiry: block.timestamp + 600,
            quoteVersion: 1
        });
        token.mint(payer, total);
        splitter.settle(quote, _quoteSignature(quote), _authorization(quote));
        totalAttention += attention;
        totalFees += 250_000;
        totalAuthorized += total;
        settlementCount++;
    }

    function _quoteSignature(GavelGateSplitter.Quote memory quote) private returns (bytes memory) {
        bytes32 domain = keccak256(
            abi.encode(
                DOMAIN_TYPEHASH, keccak256("GavelGateSplitter"), keccak256("1"), block.chainid, address(splitter)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                QUOTE_TYPEHASH,
                quote.quoteId,
                quote.payer,
                quote.voter,
                quote.attentionAmount,
                quote.gavelFeeAmount,
                quote.submissionHash,
                quote.token,
                quote.expiry,
                quote.quoteVersion
            )
        );
        (uint8 v, bytes32 r, bytes32 s) =
            vm.sign(SIGNER_KEY, keccak256(abi.encodePacked("\x19\x01", domain, structHash)));
        return abi.encodePacked(r, s, v);
    }

    function _authorization(GavelGateSplitter.Quote memory quote)
        private
        returns (GavelGateSplitter.ReceiveAuthorization memory a)
    {
        a = GavelGateSplitter.ReceiveAuthorization({
            from: payer,
            to: address(splitter),
            value: quote.attentionAmount + 250_000,
            validAfter: 0,
            validBefore: quote.expiry,
            nonce: quote.quoteId,
            v: 0,
            r: 0,
            s: 0
        });
        bytes32 h = keccak256(
            abi.encode(token.RECEIVE_TYPEHASH(), a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce)
        );
        (a.v, a.r, a.s) = vm.sign(PAYER_KEY, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), h)));
    }
}

contract GavelGateSplitterInvariantTest {
    InvariantVm private constant vm = InvariantVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant DUST = 777;
    address private constant VOTER = address(0x1234);
    address private constant GAVEL = address(0x5678);

    MockUSDC3009 private token;
    GavelGateSplitter private splitter;
    SettlementHandler private handler;
    address[] private targets;

    function targetContracts() external view returns (address[] memory) {
        return targets;
    }

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1_000_000);
        token = new MockUSDC3009();
        splitter = new GavelGateSplitter(address(token), GAVEL, vm.addr(0xB0B));
        token.mint(address(splitter), DUST);
        handler = new SettlementHandler(token, splitter, VOTER);
        targets.push(address(handler));
    }

    function invariantAggregateRoutesEqualAuthorizedValue() public view {
        require(handler.totalAttention() + handler.totalFees() == handler.totalAuthorized(), "route sum");
        require(token.totalReceived() == handler.totalAuthorized(), "pull sum");
        require(token.balanceOf(VOTER) == handler.totalAttention(), "voter sum");
        require(token.balanceOf(GAVEL) == handler.totalFees(), "fee sum");
    }

    function invariantStartingDustNeverAffectsSettlementAccounting() public view {
        require(token.balanceOf(address(splitter)) == DUST, "dust changed");
    }

    function invariantEverySuccessfulQuoteIsUsedAndLeavesNoSettlementResidue() public view {
        require(token.balanceOf(address(splitter)) == DUST, "settlement residue");
        require(token.transferCallCount() == handler.settlementCount() * 2, "transfer count");
        require(token.receiveCallCount() == handler.settlementCount(), "receive count");
    }
}
