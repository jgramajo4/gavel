// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {GavelGateSplitter} from "../src/GavelGateSplitter.sol";
import {MockUSDC3009} from "./mocks/MockUSDC3009.sol";

interface Vm {
    function addr(uint256 privateKey) external returns (address);
    function sign(uint256 privateKey, bytes32 digest) external returns (uint8, bytes32, bytes32);
    function warp(uint256 timestamp) external;
    function chainId(uint256 newChainId) external;
    function expectRevert() external;
    function expectRevert(bytes4 selector) external;
    function expectEmit(bool, bool, bool, bool, address emitter) external;
    function prank(address sender) external;
    function readFile(string calldata path) external view returns (string memory);
}

contract GavelGateSplitterTest {
    Vm private constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));
    uint256 private constant PAYER_KEY = 0xA11CE;
    uint256 private constant OTHER_PAYER_KEY = 0xCAFE;
    uint256 private constant SIGNER_KEY = 0xB0B;
    uint256 private constant WRONG_SIGNER_KEY = 0xBAD;
    uint256 private constant SECP256K1N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141;
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 quoteId,address payer,address voter,uint256 attentionAmount,uint256 gavelFeeAmount,bytes32 submissionHash,address token,uint256 expiry,uint256 quoteVersion)"
    );

    MockUSDC3009 private token;
    GavelGateSplitter private splitter;
    address private payer;
    address private signer;
    address private constant VOTER = address(0x1234);
    address private constant OTHER_VOTER = address(0x2345);
    address private constant GAVEL = address(0x5678);

    event QuoteSettled(
        bytes32 indexed quoteId,
        address indexed payer,
        address indexed voter,
        uint256 attentionAmount,
        address gavelRecipient,
        uint256 gavelFeeAmount,
        address token,
        bytes32 submissionHash
    );

    function setUp() public {
        vm.chainId(8453);
        vm.warp(1_000_000);
        payer = vm.addr(PAYER_KEY);
        signer = vm.addr(SIGNER_KEY);
        token = new MockUSDC3009();
        splitter = new GavelGateSplitter(address(token), GAVEL, signer);
        token.mint(payer, type(uint128).max);
        token.mint(vm.addr(OTHER_PAYER_KEY), 10_000_000);
    }

    function testHappyPathRoutesExactBalancesMarksUsedAndEmitsFrozenEvent() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("quote-1"));
        bytes memory quoteSignature = _signQuote(quote, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory authorization = _authorization(quote, PAYER_KEY);
        vm.expectEmit(true, true, true, true, address(splitter));
        emit QuoteSettled(
            quote.quoteId,
            quote.payer,
            quote.voter,
            quote.attentionAmount,
            GAVEL,
            quote.gavelFeeAmount,
            address(token),
            quote.submissionHash
        );
        splitter.settle(quote, quoteSignature, authorization);
        _assertEq(token.balanceOf(VOTER), 1_000_000);
        _assertEq(token.balanceOf(GAVEL), 250_000);
        _assertEq(token.balanceOf(address(splitter)), 0);
        _assertEq(token.receiveCallCount(), 1);
        _assertEq(token.transferCallCount(), 2);
        _assertTrue(splitter.usedQuoteIds(quote.quoteId));
    }

    function testRelayerMaySettlePayerAuthorization() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("relayed"));
        vm.prank(address(0xBEEF));
        splitter.settle(quote, _signQuote(quote, SIGNER_KEY), _authorization(quote, PAYER_KEY));
        _assertEq(token.balanceOf(VOTER), quote.attentionAmount);
    }

    function testReplayQuoteIdFailsBeforeUsdc() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("replay"));
        bytes memory signature = _signQuote(quote, SIGNER_KEY);
        splitter.settle(quote, signature, _authorization(quote, PAYER_KEY));
        GavelGateSplitter.ReceiveAuthorization memory replayAuthorization = _authorization(quote, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.QuoteAlreadyUsed.selector);
        splitter.settle(quote, signature, replayAuthorization);
    }

    function testAttentionBoundary999999FailsAnd1000000Passes() public {
        GavelGateSplitter.Quote memory low = _quote(keccak256("low"));
        low.attentionAmount = 999_999;
        bytes memory lowSignature = _signQuote(low, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory lowAuthorization = _authorization(low, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.InvalidQuote.selector);
        splitter.settle(low, lowSignature, lowAuthorization);
        _assertEq(token.receiveCallCount(), 0);

        GavelGateSplitter.Quote memory exact = _quote(keccak256("exact"));
        splitter.settle(exact, _signQuote(exact, SIGNER_KEY), _authorization(exact, PAYER_KEY));
        _assertEq(token.balanceOf(VOTER), 1_000_000);
    }

    function testUnsupportedVersionFailsEvenWhenSignedByConfiguredSigner() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("version"));
        quote.quoteVersion = 2;
        bytes memory signature = _signQuote(quote, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory authorization = _authorization(quote, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.InvalidQuote.selector);
        splitter.settle(quote, signature, authorization);
    }

    function testEveryQuoteFieldMutationFailsClosed() public {
        GavelGateSplitter.Quote memory original = _quote(keccak256("mutations"));
        bytes memory signature = _signQuote(original, SIGNER_KEY);
        GavelGateSplitter.Quote memory changed = original;

        changed.quoteId = keccak256("other-id");
        _expectSignatureMismatch(changed, signature, PAYER_KEY);
        changed = original;
        changed.voter = OTHER_VOTER;
        _expectSignatureMismatch(changed, signature, PAYER_KEY);
        changed = original;
        changed.attentionAmount++;
        _expectSignatureMismatch(changed, signature, PAYER_KEY);
        changed = original;
        changed.submissionHash = keccak256("other-submission");
        _expectSignatureMismatch(changed, signature, PAYER_KEY);
        changed = original;
        changed.expiry++;
        _expectSignatureMismatch(changed, signature, PAYER_KEY);

        changed = original;
        changed.payer = vm.addr(OTHER_PAYER_KEY);
        _expectSignatureMismatch(changed, signature, OTHER_PAYER_KEY);
        changed = original;
        changed.gavelFeeAmount++;
        GavelGateSplitter.ReceiveAuthorization memory changedAuthorization = _authorization(changed, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.InvalidQuote.selector);
        splitter.settle(changed, signature, changedAuthorization);
        changed = original;
        changed.token = address(0xDEAD);
        changedAuthorization = _authorization(changed, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.InvalidQuote.selector);
        splitter.settle(changed, signature, changedAuthorization);
        changed = original;
        changed.quoteVersion = 2;
        changedAuthorization = _authorization(changed, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.InvalidQuote.selector);
        splitter.settle(changed, signature, changedAuthorization);
    }

    function testWrongSignerMalformedAndWrongDomainsFail() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("bad-signatures"));
        GavelGateSplitter.ReceiveAuthorization memory authorization = _authorization(quote, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.InvalidQuoteSignature.selector);
        splitter.settle(quote, _signQuote(quote, WRONG_SIGNER_KEY), authorization);
        vm.expectRevert(GavelGateSplitter.InvalidQuoteSignature.selector);
        splitter.settle(quote, hex"1234", authorization);
        vm.expectRevert(GavelGateSplitter.InvalidQuoteSignature.selector);
        splitter.settle(quote, _signQuoteDomain(quote, SIGNER_KEY, block.chainid + 1, address(splitter)), authorization);
        vm.expectRevert(GavelGateSplitter.InvalidQuoteSignature.selector);
        splitter.settle(quote, _signQuoteDomain(quote, SIGNER_KEY, block.chainid, address(0xDEAD)), authorization);
    }

    function testHighSMalleatedAndInvalidVQuoteSignaturesFailBeforeUsdc() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("malleability"));
        GavelGateSplitter.ReceiveAuthorization memory authorization = _authorization(quote, PAYER_KEY);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_KEY, _quoteDigest(quote, block.chainid, address(splitter)));

        bytes memory highSSignature =
            abi.encodePacked(r, bytes32(SECP256K1N - uint256(s)), v == 27 ? uint8(28) : uint8(27));
        vm.expectRevert(GavelGateSplitter.InvalidQuoteSignature.selector);
        splitter.settle(quote, highSSignature, authorization);

        vm.expectRevert(GavelGateSplitter.InvalidQuoteSignature.selector);
        splitter.settle(quote, abi.encodePacked(r, s, uint8(29)), authorization);

        vm.expectRevert(GavelGateSplitter.InvalidQuoteSignature.selector);
        splitter.settle(quote, new bytes(65), authorization);

        _assertEq(token.receiveCallCount(), 0);
        _assertFalse(splitter.usedQuoteIds(quote.quoteId));
    }

    function testAllAuthorizationBindingsFailBeforeUsdc() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("bindings"));
        bytes memory signature = _signQuote(quote, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory a = _authorization(quote, PAYER_KEY);
        a.from = address(1);
        _expectInvalidAuthorization(quote, signature, a);
        a = _authorization(quote, PAYER_KEY);
        a.to = address(2);
        _expectInvalidAuthorization(quote, signature, a);
        a = _authorization(quote, PAYER_KEY);
        a.value++;
        _expectInvalidAuthorization(quote, signature, a);
        a = _authorization(quote, PAYER_KEY);
        a.nonce = bytes32(uint256(3));
        _expectInvalidAuthorization(quote, signature, a);
        a = _authorization(quote, PAYER_KEY);
        a.validAfter = 1;
        _expectInvalidAuthorization(quote, signature, a);
        a = _authorization(quote, PAYER_KEY);
        a.validBefore++;
        _expectInvalidAuthorization(quote, signature, a);
        _assertEq(token.receiveCallCount(), 0);
    }

    function testEqualValueCrossQuoteAuthorizationSubstitutionFails() public {
        GavelGateSplitter.Quote memory quoteA = _quote(keccak256("A"));
        GavelGateSplitter.Quote memory quoteB = _quote(keccak256("B"));
        quoteB.voter = OTHER_VOTER;
        GavelGateSplitter.ReceiveAuthorization memory authA = _authorization(quoteA, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.InvalidAuthorization.selector);
        splitter.settle(quoteB, _signQuote(quoteB, SIGNER_KEY), authA);
    }

    function testExpiryEqualityAndLaterFailBeforeUsdc() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("expiry"));
        bytes memory signature = _signQuote(quote, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory a = _authorization(quote, PAYER_KEY);
        vm.warp(quote.expiry);
        vm.expectRevert(GavelGateSplitter.InvalidQuote.selector);
        splitter.settle(quote, signature, a);
        vm.warp(quote.expiry + 1);
        vm.expectRevert(GavelGateSplitter.InvalidQuote.selector);
        splitter.settle(quote, signature, a);
    }

    function testUsdcPullFailureRollsBackQuoteUseAndBalances() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("pull-fail"));
        token.setFailReceive(true);
        bytes memory signature = _signQuote(quote, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory authorization = _authorization(quote, PAYER_KEY);
        vm.expectRevert();
        splitter.settle(quote, signature, authorization);
        _assertFalse(splitter.usedQuoteIds(quote.quoteId));
        _assertEq(token.balanceOf(VOTER), 0);
        _assertFalse(token.authorizationState(payer, quote.quoteId));
    }

    function testAlreadyConsumedUsdcNonceRollsBackQuoteUse() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("used-usdc-nonce"));
        GavelGateSplitter.ReceiveAuthorization memory authorization = _authorization(quote, PAYER_KEY);
        vm.prank(address(splitter));
        token.receiveWithAuthorization(
            authorization.from,
            authorization.to,
            authorization.value,
            authorization.validAfter,
            authorization.validBefore,
            authorization.nonce,
            authorization.v,
            authorization.r,
            authorization.s
        );
        bytes memory signature = _signQuote(quote, SIGNER_KEY);
        vm.expectRevert();
        splitter.settle(quote, signature, authorization);
        _assertFalse(splitter.usedQuoteIds(quote.quoteId));
    }

    function testZeroPayerAndVoterFailBeforeUsdc() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("zero-payer"));
        quote.payer = address(0);
        bytes memory signature = _signQuote(quote, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory authorization = _authorization(quote, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.InvalidQuote.selector);
        splitter.settle(quote, signature, authorization);

        quote = _quote(keccak256("zero-voter"));
        quote.voter = address(0);
        signature = _signQuote(quote, SIGNER_KEY);
        authorization = _authorization(quote, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.InvalidQuote.selector);
        splitter.settle(quote, signature, authorization);
        _assertEq(token.receiveCallCount(), 0);
    }

    function testAmountSumOverflowFailsBeforeUsdc() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("overflow"));
        quote.attentionAmount = type(uint256).max;
        bytes memory signature = _signQuote(quote, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory authorization;
        vm.expectRevert();
        splitter.settle(quote, signature, authorization);
        _assertEq(token.receiveCallCount(), 0);
    }

    function testEitherSplitLegFailureRollsBackEverything() public {
        _assertTransferFailureAtomic(1, keccak256("first-leg"));
        _assertTransferFailureAtomic(2, keccak256("second-leg"));
    }

    function testDirectDustIsUnaffectedAndStranded() public {
        uint256 dust = 777;
        vm.prank(payer);
        token.transfer(address(splitter), dust);
        GavelGateSplitter.Quote memory quote = _quote(keccak256("dust"));
        splitter.settle(quote, _signQuote(quote, SIGNER_KEY), _authorization(quote, PAYER_KEY));
        _assertEq(token.balanceOf(address(splitter)), dust);
        _assertEq(token.balanceOf(VOTER), quote.attentionAmount);
        _assertEq(token.balanceOf(GAVEL), quote.gavelFeeAmount);
    }

    function testCopiedReceiveAuthorizationCannotBeFrontRunButSplitterSucceeds() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("front-run"));
        GavelGateSplitter.ReceiveAuthorization memory a = _authorization(quote, PAYER_KEY);
        vm.prank(address(0xBAD1));
        vm.expectRevert();
        token.receiveWithAuthorization(a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce, a.v, a.r, a.s);
        splitter.settle(quote, _signQuote(quote, SIGNER_KEY), a);
        _assertEq(token.balanceOf(VOTER), quote.attentionAmount);
    }

    function testTransferWithAuthorizationTypeSignatureFailsReceivePath() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("wrong-type"));
        GavelGateSplitter.ReceiveAuthorization memory a =
            _authorizationWithTypehash(quote, PAYER_KEY, token.TRANSFER_TYPEHASH());
        vm.expectRevert();
        splitter.settle(quote, _signQuote(quote, SIGNER_KEY), a);
        _assertFalse(splitter.usedQuoteIds(quote.quoteId));
    }

    function testSourceAndAbiExposeNoForbiddenAuthorizationOrAdminPath() public view {
        string memory source = vm.readFile("src/GavelGateSplitter.sol");
        _assertFalse(_contains(bytes(source), bytes("transferWithAuthorization")));
        _assertFalse(_contains(bytes(source), bytes("function owner")));
        _assertFalse(_contains(bytes(source), bytes("function pause")));
        _assertFalse(_contains(bytes(source), bytes("function rescue")));
        _assertFalse(_contains(bytes(source), bytes("function sweep")));
        _assertFalse(_contains(bytes(source), bytes("function quoteDigest")));
        _assertFalse(_contains(bytes(source), bytes("fallback(")));
        _assertFalse(_contains(bytes(source), bytes("receive()")));
    }

    function testAuthorizationWrongUsdcDomainsFail() public {
        GavelGateSplitter.Quote memory quote = _quote(keccak256("auth-domains"));
        bytes32 receiveHash = token.RECEIVE_TYPEHASH();
        _expectBadAuthDomain(quote, _usdcDomain("Wrong", "2", block.chainid, address(token)), receiveHash);
        _expectBadAuthDomain(quote, _usdcDomain("USD Coin", "1", block.chainid, address(token)), receiveHash);
        _expectBadAuthDomain(quote, _usdcDomain("USD Coin", "2", block.chainid + 1, address(token)), receiveHash);
        _expectBadAuthDomain(quote, _usdcDomain("USD Coin", "2", block.chainid, address(0xDEAD)), receiveHash);
    }

    function testFuzzCoreRoutingReplayAndNoResidue(uint96 rawAttention, bytes32 salt, address voter) public {
        uint256 attention = uint256(rawAttention) + 1_000_000;
        if (voter == address(0) || voter == address(splitter) || voter == GAVEL || voter == payer) voter = OTHER_VOTER;
        GavelGateSplitter.Quote memory quote = _quote(keccak256(abi.encode("fuzz", salt)));
        quote.attentionAmount = attention;
        quote.voter = voter;
        uint256 payerBefore = token.balanceOf(payer);
        splitter.settle(quote, _signQuote(quote, SIGNER_KEY), _authorization(quote, PAYER_KEY));
        _assertEq(token.balanceOf(voter), attention);
        _assertEq(token.balanceOf(GAVEL), 250_000);
        _assertEq(payerBefore - token.balanceOf(payer), attention + 250_000);
        _assertEq(token.balanceOf(address(splitter)), 0);
        bytes memory replaySignature = _signQuote(quote, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory replayAuthorization = _authorization(quote, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.QuoteAlreadyUsed.selector);
        splitter.settle(quote, replaySignature, replayAuthorization);
    }

    function testFuzzInvalidFeeNeverRoutes(uint248 rawFee, bytes32 salt) public {
        uint256 fee = uint256(rawFee);
        if (fee == 250_000) fee++;
        GavelGateSplitter.Quote memory quote = _quote(keccak256(abi.encode("fee", salt)));
        quote.gavelFeeAmount = fee;
        bytes memory signature = _signQuote(quote, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory authorization = _authorization(quote, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.InvalidQuote.selector);
        splitter.settle(quote, signature, authorization);
        _assertEq(token.balanceOf(VOTER), 0);
        _assertEq(token.balanceOf(GAVEL), 0);
    }

    function testConstructorRejectsZeroConfiguration() public {
        vm.expectRevert(GavelGateSplitter.InvalidConfiguration.selector);
        new GavelGateSplitter(address(0), GAVEL, signer);
        vm.expectRevert(GavelGateSplitter.InvalidConfiguration.selector);
        new GavelGateSplitter(address(token), address(0), signer);
        vm.expectRevert(GavelGateSplitter.InvalidConfiguration.selector);
        new GavelGateSplitter(address(token), GAVEL, address(0));
    }

    function _quote(bytes32 quoteId) private view returns (GavelGateSplitter.Quote memory) {
        return GavelGateSplitter.Quote({
            quoteId: quoteId,
            payer: payer,
            voter: VOTER,
            attentionAmount: 1_000_000,
            gavelFeeAmount: 250_000,
            submissionHash: keccak256("submission"),
            token: address(token),
            expiry: block.timestamp + 600,
            quoteVersion: 1
        });
    }

    function _quoteDigest(GavelGateSplitter.Quote memory quote, uint256 chainId, address verifyingContract)
        private
        pure
        returns (bytes32)
    {
        bytes32 domain = keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256("GavelGateSplitter"), keccak256("1"), chainId, verifyingContract)
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
        return keccak256(abi.encodePacked("\x19\x01", domain, structHash));
    }

    function _signQuote(GavelGateSplitter.Quote memory quote, uint256 key) private returns (bytes memory) {
        return _signQuoteDomain(quote, key, block.chainid, address(splitter));
    }

    function _signQuoteDomain(GavelGateSplitter.Quote memory quote, uint256 key, uint256 chainId, address deployment)
        private
        returns (bytes memory)
    {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _quoteDigest(quote, chainId, deployment));
        return abi.encodePacked(r, s, v);
    }

    function _authorization(GavelGateSplitter.Quote memory quote, uint256 key)
        private
        returns (GavelGateSplitter.ReceiveAuthorization memory)
    {
        return _authorizationWithTypehash(quote, key, token.RECEIVE_TYPEHASH());
    }

    function _authorizationWithTypehash(GavelGateSplitter.Quote memory quote, uint256 key, bytes32 typehash)
        private
        returns (GavelGateSplitter.ReceiveAuthorization memory a)
    {
        a = GavelGateSplitter.ReceiveAuthorization({
            from: quote.payer,
            to: address(splitter),
            value: quote.attentionAmount + quote.gavelFeeAmount,
            validAfter: 0,
            validBefore: quote.expiry,
            nonce: quote.quoteId,
            v: 0,
            r: 0,
            s: 0
        });
        bytes32 h = keccak256(abi.encode(typehash, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce));
        (a.v, a.r, a.s) = vm.sign(key, keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), h)));
    }

    function _expectSignatureMismatch(GavelGateSplitter.Quote memory quote, bytes memory signature, uint256 payerKey)
        private
    {
        GavelGateSplitter.ReceiveAuthorization memory authorization = _authorization(quote, payerKey);
        vm.expectRevert(GavelGateSplitter.InvalidQuoteSignature.selector);
        splitter.settle(quote, signature, authorization);
    }

    function _expectInvalidAuthorization(
        GavelGateSplitter.Quote memory quote,
        bytes memory signature,
        GavelGateSplitter.ReceiveAuthorization memory authorization
    ) private {
        vm.expectRevert(GavelGateSplitter.InvalidAuthorization.selector);
        splitter.settle(quote, signature, authorization);
    }

    function _assertTransferFailureAtomic(uint256 leg, bytes32 id) private {
        GavelGateSplitter.Quote memory quote = _quote(id);
        token.setFailTransferNumber(leg);
        bytes memory signature = _signQuote(quote, SIGNER_KEY);
        GavelGateSplitter.ReceiveAuthorization memory authorization = _authorization(quote, PAYER_KEY);
        vm.expectRevert(GavelGateSplitter.TransferFailed.selector);
        splitter.settle(quote, signature, authorization);
        _assertFalse(splitter.usedQuoteIds(id));
        _assertFalse(token.authorizationState(payer, id));
        _assertEq(token.balanceOf(VOTER), 0);
        _assertEq(token.balanceOf(GAVEL), 0);
        _assertEq(token.balanceOf(address(splitter)), 0);
        token.setFailTransferNumber(0);
    }

    function _usdcDomain(string memory n, string memory v, uint256 chainId, address verifyingContract)
        private
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(n)), keccak256(bytes(v)), chainId, verifyingContract)
        );
    }

    function _expectBadAuthDomain(GavelGateSplitter.Quote memory quote, bytes32 domain, bytes32 typehash) private {
        GavelGateSplitter.ReceiveAuthorization memory a = GavelGateSplitter.ReceiveAuthorization({
            from: quote.payer,
            to: address(splitter),
            value: quote.attentionAmount + quote.gavelFeeAmount,
            validAfter: 0,
            validBefore: quote.expiry,
            nonce: quote.quoteId,
            v: 0,
            r: 0,
            s: 0
        });
        bytes32 h = keccak256(abi.encode(typehash, a.from, a.to, a.value, a.validAfter, a.validBefore, a.nonce));
        (a.v, a.r, a.s) = vm.sign(PAYER_KEY, keccak256(abi.encodePacked("\x19\x01", domain, h)));
        vm.expectRevert();
        splitter.settle(quote, _signQuote(quote, SIGNER_KEY), a);
        _assertFalse(splitter.usedQuoteIds(quote.quoteId));
    }

    function _contains(bytes memory haystack, bytes memory needle) private pure returns (bool) {
        if (needle.length == 0 || needle.length > haystack.length) return false;
        for (uint256 i; i <= haystack.length - needle.length; i++) {
            bool found = true;
            for (uint256 j; j < needle.length; j++) {
                if (haystack[i + j] != needle[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return true;
        }
        return false;
    }

    function _assertEq(uint256 a, uint256 b) private pure {
        require(a == b, "not equal");
    }

    function _assertTrue(bool value) private pure {
        require(value, "not true");
    }

    function _assertFalse(bool value) private pure {
        require(!value, "not false");
    }
}
