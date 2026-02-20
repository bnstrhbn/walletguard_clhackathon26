pragma solidity ^0.8.20;

interface IERC20Like {
  function balanceOf(address account) external view returns (uint256);

  function allowance(address owner, address spender) external view returns (uint256);

  function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

contract TestERC20 {
  string public name;
  string public symbol;
  uint8 public decimals;
  uint256 public totalSupply;

  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);

  constructor() {
    name = 'WalletGuard Test Token';
    symbol = 'WGTT';
    decimals = 18;
    _mint(msg.sender, 1_000_000 ether);
  }

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    _transfer(msg.sender, to, amount);
    return true;
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 allowed = allowance[from][msg.sender];
    require(allowed >= amount, 'ALLOWANCE');
    allowance[from][msg.sender] = allowed - amount;
    emit Approval(from, msg.sender, allowance[from][msg.sender]);
    _transfer(from, to, amount);
    return true;
  }

  function _transfer(address from, address to, uint256 amount) internal {
    require(to != address(0), 'TO_ZERO');
    uint256 bal = balanceOf[from];
    require(bal >= amount, 'BALANCE');
    balanceOf[from] = bal - amount;
    balanceOf[to] += amount;
    emit Transfer(from, to, amount);
  }

  function _mint(address to, uint256 amount) internal {
    require(to != address(0), 'MINT_ZERO');
    totalSupply += amount;
    balanceOf[to] += amount;
    emit Transfer(address(0), to, amount);
  }
}

contract EvilSpender {
  function drain(address token, address from, address to) external returns (uint256) {
    uint256 allowed = IERC20Like(token).allowance(from, address(this));
    uint256 bal = IERC20Like(token).balanceOf(from);

    uint256 amount = allowed < bal ? allowed : bal;
    require(amount > 0, 'NOTHING');

    bool ok = IERC20Like(token).transferFrom(from, to, amount);
    require(ok, 'TRANSFER_FROM');

    return amount;
  }
}

contract EvilForwarder {
  function forwardEth(address payable recipient) external payable {
    (bool ok, ) = recipient.call{ value: msg.value }('');
    require(ok, 'SEND');
  }

  function drip(address payable recipient, uint256 amount) external {
    (bool ok, ) = recipient.call{ value: amount }('');
    require(ok, 'SEND');
  }

  function delegateTo(address target) external {
    (bool ok, ) = target.delegatecall('');
    require(ok, 'DELEGATECALL');
  }

  receive() external payable {}
}
