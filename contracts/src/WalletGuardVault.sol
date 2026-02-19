pragma solidity ^0.8.20;

contract WalletGuardVault {
  event Executed(
    bytes32 indexed receiptHash,
    address indexed to,
    uint256 value,
    bytes32 dataHash,
    bytes4 selector
  );

  event PausedSet(bool paused);
  event CreExecutorSet(address indexed creExecutor);
  event OwnerSet(address indexed owner);
  event MaxValuePerTxSet(uint256 maxValuePerTx);
  event TargetAllowedSet(address indexed target, bool allowed);
  event SelectorAllowedSet(address indexed target, bytes4 indexed selector, bool allowed);

  address public owner;
  address public creExecutor;
  bool public paused;
  uint256 public maxValuePerTx;

  mapping(address => bool) public targetAllowed;
  mapping(address => mapping(bytes4 => bool)) public selectorAllowed;
  mapping(bytes32 => bool) public usedReceiptHash;

  modifier onlyOwner() {
    require(msg.sender == owner, 'ONLY_OWNER');
    _;
  }

  modifier onlyCreExecutor() {
    require(msg.sender == creExecutor, 'ONLY_CRE_EXECUTOR');
    _;
  }

  constructor(address owner_, address creExecutor_, uint256 maxValuePerTx_) {
    require(owner_ != address(0), 'OWNER_ZERO');
    require(creExecutor_ != address(0), 'CRE_EXECUTOR_ZERO');
    owner = owner_;
    creExecutor = creExecutor_;
    maxValuePerTx = maxValuePerTx_;
  }

  receive() external payable {}

  function setOwner(address owner_) external onlyOwner {
    require(owner_ != address(0), 'OWNER_ZERO');
    owner = owner_;
    emit OwnerSet(owner_);
  }

  function setCreExecutor(address creExecutor_) external onlyOwner {
    require(creExecutor_ != address(0), 'CRE_EXECUTOR_ZERO');
    creExecutor = creExecutor_;
    emit CreExecutorSet(creExecutor_);
  }

  function setPaused(bool paused_) external onlyOwner {
    paused = paused_;
    emit PausedSet(paused_);
  }

  function setMaxValuePerTx(uint256 maxValuePerTx_) external onlyOwner {
    maxValuePerTx = maxValuePerTx_;
    emit MaxValuePerTxSet(maxValuePerTx_);
  }

  function setTargetAllowed(address target, bool allowed) external onlyOwner {
    targetAllowed[target] = allowed;
    emit TargetAllowedSet(target, allowed);
  }

  function setSelectorAllowed(address target, bytes4 selector, bool allowed) external onlyOwner {
    selectorAllowed[target][selector] = allowed;
    emit SelectorAllowedSet(target, selector, allowed);
  }

  function execute(address to, uint256 value, bytes calldata data, bytes32 receiptHash) external onlyCreExecutor {
    require(!paused, 'PAUSED');
    require(!usedReceiptHash[receiptHash], 'RECEIPT_REPLAY');
    require(targetAllowed[to], 'TARGET_NOT_ALLOWED');
    require(value <= maxValuePerTx, 'VALUE_LIMIT');

    bytes4 selector;
    if (data.length >= 4) {
      assembly {
        selector := calldataload(data.offset)
      }
    } else {
      selector = bytes4(0);
    }
    require(selectorAllowed[to][selector], 'SELECTOR_NOT_ALLOWED');

    usedReceiptHash[receiptHash] = true;

    (bool ok, ) = to.call{ value: value }(data);
    require(ok, 'CALL_FAILED');

    emit Executed(receiptHash, to, value, keccak256(data), selector);
  }
}
