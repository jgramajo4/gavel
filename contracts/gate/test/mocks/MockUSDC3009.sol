// SPDX-License-Identifier: GPL-3.0-only
pragma solidity ^0.8.30;

contract MockUSDC3009 {
    string public constant name = "USD Coin";
    string public constant version = "2";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;

    bytes32 public constant RECEIVE_TYPEHASH = keccak256(
        "ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 public constant TRANSFER_TYPEHASH = keccak256(
        "TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );
    bytes32 private constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(bytes32 => bool)) public authorizationState;
    uint256 public receiveCallCount;
    uint256 public transferCallCount;
    uint256 public totalReceived;
    bool public failReceive;
    uint256 public failTransferNumber;

    function DOMAIN_SEPARATOR() public view returns (bytes32) {
        return keccak256(
            abi.encode(DOMAIN_TYPEHASH, keccak256(bytes(name)), keccak256(bytes(version)), block.chainid, address(this))
        );
    }

    function mint(address to, uint256 value) external {
        balanceOf[to] += value;
    }

    function setFailReceive(bool value) external {
        failReceive = value;
    }

    function setFailTransferNumber(uint256 value) external {
        failTransferNumber = value;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        transferCallCount++;
        if (transferCallCount == failTransferNumber) return false;
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        return true;
    }

    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        receiveCallCount++;
        require(!failReceive, "receive failure");
        require(msg.sender == to, "caller must be payee");
        require(block.timestamp > validAfter, "not yet valid");
        require(block.timestamp < validBefore, "expired");
        require(!authorizationState[from][nonce], "authorization used");
        bytes32 structHash = keccak256(abi.encode(RECEIVE_TYPEHASH, from, to, value, validAfter, validBefore, nonce));
        address signer = ecrecover(keccak256(abi.encodePacked("\x19\x01", DOMAIN_SEPARATOR(), structHash)), v, r, s);
        require(signer != address(0) && signer == from, "invalid signature");
        require(balanceOf[from] >= value, "balance");
        authorizationState[from][nonce] = true;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        totalReceived += value;
    }
}
