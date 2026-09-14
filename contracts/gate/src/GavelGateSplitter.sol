// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

import {IUSDCReceiveWithAuthorization} from "./interfaces/IUSDCReceiveWithAuthorization.sol";

contract GavelGateSplitter {
    struct Quote {
        bytes32 quoteId;
        address payer;
        address voter;
        uint256 attentionAmount;
        uint256 gavelFeeAmount;
        bytes32 submissionHash;
        address token;
        uint256 expiry;
        uint256 quoteVersion;
    }

    struct ReceiveAuthorization {
        address from;
        address to;
        uint256 value;
        uint256 validAfter;
        uint256 validBefore;
        bytes32 nonce;
        uint8 v;
        bytes32 r;
        bytes32 s;
    }

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

    error InvalidConfiguration();
    error InvalidQuote();
    error InvalidQuoteSignature();
    error InvalidAuthorization();
    error QuoteAlreadyUsed();
    error TransferFailed();

    uint256 public constant MINIMUM_ATTENTION_AMOUNT = 1_000_000;
    uint256 public constant GAVEL_FEE_AMOUNT = 250_000;
    bytes32 public constant QUOTE_TYPEHASH = keccak256(
        "Quote(bytes32 quoteId,address payer,address voter,uint256 attentionAmount,uint256 gavelFeeAmount,bytes32 submissionHash,address token,uint256 expiry,uint256 quoteVersion)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 private constant NAME_HASH = keccak256("GavelGateSplitter");
    bytes32 private constant VERSION_HASH = keccak256("1");
    uint256 private constant SECP256K1N_DIV_2 = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0;

    address public immutable usdc;
    address public immutable gavelRecipient;
    address public immutable quoteSigner;
    bytes32 public immutable DOMAIN_SEPARATOR;
    mapping(bytes32 => bool) public usedQuoteIds;

    constructor(address usdc_, address gavelRecipient_, address quoteSigner_) {
        if (usdc_ == address(0) || gavelRecipient_ == address(0) || quoteSigner_ == address(0)) {
            revert InvalidConfiguration();
        }
        usdc = usdc_;
        gavelRecipient = gavelRecipient_;
        quoteSigner = quoteSigner_;
        DOMAIN_SEPARATOR = keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function settle(Quote calldata quote, bytes calldata quoteSignature, ReceiveAuthorization calldata authorization)
        external
    {
        if (
            quote.quoteVersion != 1 || quote.token != usdc || quote.attentionAmount < MINIMUM_ATTENTION_AMOUNT
                || quote.gavelFeeAmount != GAVEL_FEE_AMOUNT || block.timestamp >= quote.expiry
                || quote.payer == address(0) || quote.voter == address(0)
        ) revert InvalidQuote();

        uint256 total = quote.attentionAmount + quote.gavelFeeAmount;
        if (
            authorization.from != quote.payer || authorization.to != address(this) || authorization.value != total
                || authorization.nonce != quote.quoteId || authorization.validAfter != 0
                || authorization.validBefore != quote.expiry
        ) revert InvalidAuthorization();

        if (_recover(_quoteDigest(quote), quoteSignature) != quoteSigner) revert InvalidQuoteSignature();
        if (usedQuoteIds[quote.quoteId]) revert QuoteAlreadyUsed();
        usedQuoteIds[quote.quoteId] = true;

        IUSDCReceiveWithAuthorization(usdc)
            .receiveWithAuthorization(
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
        if (!IUSDCReceiveWithAuthorization(usdc).transfer(quote.voter, quote.attentionAmount)) {
            revert TransferFailed();
        }
        if (!IUSDCReceiveWithAuthorization(usdc).transfer(gavelRecipient, quote.gavelFeeAmount)) {
            revert TransferFailed();
        }

        emit QuoteSettled(
            quote.quoteId,
            quote.payer,
            quote.voter,
            quote.attentionAmount,
            gavelRecipient,
            quote.gavelFeeAmount,
            quote.token,
            quote.submissionHash
        );
    }

    function _quoteDigest(Quote calldata quote) private view returns (bytes32) {
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
        return keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR, structHash));
    }

    function _recover(bytes32 digest, bytes calldata signature) private pure returns (address) {
        if (signature.length != 65) return address(0);
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly ("memory-safe") {
            r := calldataload(signature.offset)
            s := calldataload(add(signature.offset, 32))
            v := byte(0, calldataload(add(signature.offset, 64)))
        }
        if (uint256(s) > SECP256K1N_DIV_2 || (v != 27 && v != 28)) return address(0);
        return ecrecover(digest, v, r, s);
    }
}
