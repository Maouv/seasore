// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface ISeasoreExecutor {
    function trustedCoordinator() external view returns (address);
}

/// @notice Owner-operated batch relay for wallets delegated (EIP-7702) to one
///         pinned SeasoreExecutor. The owner pays gas and the mint value; the
///         wallets need 0 ETH. Each call is isolated: one failure does not
///         revert the batch, and unspent ETH is refunded to the owner.
/// @dev SECURITY: whoever controls `owner` can execute arbitrary calls from
///      every wallet delegated to the pinned executor. Use a dedicated owner key.
contract SeasoreCoordinator {
    error Unauthorized();
    error ZeroAddress();
    error ReentrantCall();
    error ExecutorAlreadySet();
    error ExecutorNotSet();
    error InvalidExecutor();
    error IncorrectValue(uint256 expected, uint256 actual);
    error PaymentFailed(address to, uint256 value);

    struct Call {
        address account;
        uint256 suppliedValue; // ETH sent to the wallet; should equal the `value` inside `data`
        uint256 gasLimit; // 0 = forward all available gas (minus reserve)
        bytes data; // abi.encodeCall(SeasoreExecutor.execute, (target, value, calldata))
    }

    uint256 public constant MAX_RETURN_DATA = 256;
    uint256 private constant POST_CALL_GAS_RESERVE = 100_000;
    uint256 private constant REMAINING_CALL_GAS_RESERVE = 30_000;

    address public immutable owner;
    address public executor;
    uint256 private entered = 1;

    event ExecutorSet(address indexed executor);
    event CallResult(uint256 indexed index, address indexed account, bool success, bytes returnData);
    event Refunded(address indexed to, uint256 value);

    constructor(address owner_) {
        if (owner_ == address(0)) revert ZeroAddress();
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert Unauthorized();
        _;
    }

    modifier nonReentrant() {
        if (entered != 1) revert ReentrantCall();
        entered = 2;
        _;
        entered = 1;
    }

    /// @notice One-time: pins the only executor wallets may be delegated to.
    function setExecutor(address executor_) external onlyOwner {
        if (executor != address(0)) revert ExecutorAlreadySet();
        if (executor_ == address(0) || executor_.code.length == 0) revert InvalidExecutor();
        (bool ok, bytes memory result) = executor_.staticcall(abi.encodeCall(ISeasoreExecutor.trustedCoordinator, ()));
        if (!ok || result.length < 32 || abi.decode(result, (address)) != address(this)) revert InvalidExecutor();
        executor = executor_;
        emit ExecutorSet(executor_);
    }

    /// @notice Different calldata per wallet.
    function relay(Call[] calldata calls) external payable onlyOwner nonReentrant {
        if (executor == address(0)) revert ExecutorNotSet();

        uint256 total;
        for (uint256 i; i < calls.length; ++i) {
            total += calls[i].suppliedValue;
        }
        if (msg.value != total) revert IncorrectValue(total, msg.value);

        uint256 spent;
        for (uint256 i; i < calls.length; ++i) {
            Call calldata c = calls[i];
            if (!_delegated(c.account)) {
                emit CallResult(i, c.account, false, bytes("INVALID_DELEGATION"));
                continue;
            }
            (bool ok, bytes memory result) = _callAccount(c, calls.length - i - 1);
            if (ok) spent += c.suppliedValue;
            emit CallResult(i, c.account, ok, result);
        }
        _refund(msg.value - spent);
    }

    /// @notice Same calldata and value for every wallet (e.g. one mint, N wallets).
    function relayShared(address[] calldata accounts, uint256 suppliedValue, uint256 gasLimit, bytes calldata data)
        external
        payable
        onlyOwner
        nonReentrant
    {
        if (executor == address(0)) revert ExecutorNotSet();
        if (msg.value != suppliedValue * accounts.length) {
            revert IncorrectValue(suppliedValue * accounts.length, msg.value);
        }

        uint256 spent;
        for (uint256 i; i < accounts.length; ++i) {
            address a = accounts[i];
            if (!_delegated(a)) {
                emit CallResult(i, a, false, bytes("INVALID_DELEGATION"));
                continue;
            }
            (bool ok, bytes memory result) =
                _callAccount(Call(a, suppliedValue, gasLimit, data), accounts.length - i - 1);
            if (ok) spent += suppliedValue;
            emit CallResult(i, a, ok, result);
        }
        _refund(msg.value - spent);
    }

    /// @notice Recover ETH sent directly to this contract.
    function withdraw(address payable to, uint256 value) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        (bool ok,) = to.call{value: value}("");
        if (!ok) revert PaymentFailed(to, value);
    }

    /// @dev For a 7702 wallet, EXTCODE* sees the 23-byte designator 0xef0100 ++ address
    ///      (it does not follow the pointer). Accept only wallets pointing at `executor`.
    function _delegated(address account) private view returns (bool) {
        bytes memory code = account.code;
        if (code.length != 23) return false;
        return keccak256(code) == keccak256(abi.encodePacked(hex"ef0100", executor));
    }

    /// @dev Reserve grows with the number of calls still ahead, so the last wallet
    ///      in a big batch can never starve the relay of post-loop gas.
    function _callAccount(Call memory item, uint256 remainingCalls) private returns (bool ok, bytes memory result) {
        uint256 reserve = POST_CALL_GAS_RESERVE + remainingCalls * REMAINING_CALL_GAS_RESERVE;
        uint256 available = gasleft();
        if (available <= reserve) return (false, bytes("INSUFFICIENT_RELAY_GAS"));
        uint256 maxGas = available - reserve;
        uint256 g = (item.gasLimit == 0 || item.gasLimit > maxGas) ? maxGas : item.gasLimit;
        (ok, result) = item.account.call{value: item.suppliedValue, gas: g}(item.data);
        if (result.length > MAX_RETURN_DATA) {
            assembly ("memory-safe") {
                mstore(result, MAX_RETURN_DATA)
            }
        }
    }

    function _refund(uint256 amount) private {
        if (amount == 0) return;
        (bool ok,) = owner.call{value: amount}("");
        if (!ok) revert PaymentFailed(owner, amount);
        emit Refunded(owner, amount);
    }

    receive() external payable {}
}