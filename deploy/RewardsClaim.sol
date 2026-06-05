// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title RewardsClaim — multi-token, multi-project signed reward pool (rewardsbot.nad)
/// Holds native MON (token == address(0)) and any ERC-20 on Monad. An off-chain `signer`
/// authorizes CUMULATIVE per-(user,token) totals; each user claims the token of their choice.
/// Pays min(authorized - alreadyClaimed, poolBalance); unpaid remainder stays claimable.
contract RewardsClaim {
    address public constant NATIVE = address(0); // sentinel for native MON

    address public owner;
    address public pendingOwner;
    address public signer;
    bool public paused;
    bool private _locked;

    // cumulative base units already paid, per (user, token)
    mapping(address => mapping(address => uint256)) public claimed;

    event Claimed(address indexed user, address indexed token, uint256 amount, uint256 cumulative);
    event Funded(address indexed token, address indexed from, uint256 amount);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);
    event SignerSet(address indexed signer);
    event PausedSet(bool paused);
    event OwnershipTransferStarted(address indexed newOwner);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    error NotOwner();
    error NotPendingOwner();
    error IsPaused();
    error Reentrant();
    error ZeroSigner();
    error BadSig();
    error NothingToClaim();
    error LengthMismatch();
    error TransferFailed();
    error ZeroAddress();
    error EmptyBatch();

    modifier onlyOwner() { if (msg.sender != owner) revert NotOwner(); _; }
    modifier nonReentrant() { if (_locked) revert Reentrant(); _locked = true; _; _locked = false; }
    modifier whenNotPaused() { if (paused) revert IsPaused(); _; }

    constructor(address _signer) {
        if (_signer == address(0)) revert ZeroSigner();
        owner = msg.sender;
        signer = _signer;
        emit OwnershipTransferred(address(0), msg.sender);
        emit SignerSet(_signer);
    }

    // native MON deposits land here (project funding / top-ups)
    receive() external payable { emit Funded(NATIVE, msg.sender, msg.value); }

    // ---------------------------------------------------------------- claim

    /// @notice Claim one token. `token` == address(0) for native MON.
    /// `cumulative` = lifetime authorized base units signed by `signer`.
    function claim(address token, uint256 cumulative, bytes calldata signature)
        external nonReentrant whenNotPaused
    {
        // strict: a single claim reverts loudly on nothing-to-claim / empty pool / failed transfer
        _claim(token, cumulative, signature, true);
    }

    /// @notice Claim several tokens in one tx (parallel arrays). Best-effort: legs that
    /// are not currently claimable (already claimed, empty pool, or a recipient that
    /// rejects native MON) are SKIPPED so one bad leg can't block the rest. A forged
    /// signature still reverts the whole batch. Reverts only if NOTHING was paid.
    function claimBatch(
        address[] calldata tokens,
        uint256[] calldata cumulatives,
        bytes[] calldata sigs
    ) external nonReentrant whenNotPaused {
        uint256 n = tokens.length;
        if (n == 0) revert EmptyBatch();
        if (n != cumulatives.length || n != sigs.length) revert LengthMismatch();
        bool anyPaid;
        for (uint256 i; i < n; ++i) {
            if (_claim(tokens[i], cumulatives[i], sigs[i], false)) anyPaid = true;
        }
        if (!anyPaid) revert NothingToClaim();
    }

    function _claim(address token, uint256 cumulative, bytes calldata signature, bool strict) private returns (bool) {
        bytes32 h = keccak256(abi.encodePacked(address(this), block.chainid, msg.sender, token, cumulative));
        if (_recover(_eth(h), signature) != signer) revert BadSig(); // auth failure always reverts

        uint256 already = claimed[msg.sender][token];
        if (cumulative <= already) { if (strict) revert NothingToClaim(); return false; }
        uint256 owed = cumulative - already;

        uint256 bal = token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
        if (bal == 0) { if (strict) revert NothingToClaim(); return false; }
        uint256 pay = owed < bal ? owed : bal;

        // effects before interactions; advance by ACTUAL paid so the remainder stays claimable
        uint256 newCumulative = already + pay;
        claimed[msg.sender][token] = newCumulative;

        bool ok;
        if (token == NATIVE) {
            (ok, ) = payable(msg.sender).call{value: pay}("");
        } else {
            ok = _trySafeTransfer(token, msg.sender, pay);
        }
        if (!ok) {
            // unwind so this leg stays FULLY claimable; safe to write post-call (nonReentrant
            // blocks re-entry and this only restores prior state).
            claimed[msg.sender][token] = already;
            if (strict) revert TransferFailed();
            return false;
        }

        emit Claimed(msg.sender, token, pay, newCumulative);
        return true;
    }

    // ---------------------------------------------------------------- funding

    /// @notice Optional helper to fund an ERC-20 (needs prior approve). Direct ERC-20
    /// transfers and plain MON sends also work — the pool reads live balanceOf.
    function fund(address token, uint256 amount) external nonReentrant {
        if (token == NATIVE) revert TransferFailed(); // send MON via the receive() path
        // safe transferFrom: also supports non-standard ERC-20s (e.g. USDT) that return no data
        _safeTransferFrom(token, msg.sender, address(this), amount);
        emit Funded(token, msg.sender, amount);
    }

    // ---------------------------------------------------------------- admin

    function withdraw(address token, address to, uint256 amount) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        if (token == NATIVE) { (bool ok, ) = payable(to).call{value: amount}(""); if (!ok) revert TransferFailed(); }
        else _safeTransfer(token, to, amount);
        emit Withdrawn(token, to, amount);
    }

    function setSigner(address s) external onlyOwner { if (s == address(0)) revert ZeroSigner(); signer = s; emit SignerSet(s); }
    function setPaused(bool p) external onlyOwner { paused = p; emit PausedSet(p); }
    function transferOwnership(address n) external onlyOwner { pendingOwner = n; emit OwnershipTransferStarted(n); }
    function acceptOwnership() external {
        if (msg.sender != pendingOwner) revert NotPendingOwner();
        emit OwnershipTransferred(owner, pendingOwner);
        owner = pendingOwner;
        pendingOwner = address(0);
    }

    // ---------------------------------------------------------------- views

    function poolBalance(address token) external view returns (uint256) {
        return token == NATIVE ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    // ---------------------------------------------------------------- internal

    function _eth(bytes32 h) private pure returns (bytes32) {
        return keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", h));
    }

    function _recover(bytes32 h, bytes calldata sig) private pure returns (address) {
        if (sig.length != 65) revert BadSig();
        bytes32 r; bytes32 s; uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        // low-s only (EIP-2) and v in {27,28} — blocks signature malleability
        if (uint256(s) > 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0) revert BadSig();
        if (v != 27 && v != 28) revert BadSig();
        address a = ecrecover(h, v, r, s);
        if (a == address(0)) revert BadSig();
        return a;
    }

    function _trySafeTransfer(address token, address to, uint256 amount) private returns (bool) {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        return ok && (data.length == 0 || abi.decode(data, (bool)));
    }

    function _safeTransfer(address token, address to, uint256 amount) private {
        if (!_trySafeTransfer(token, to, amount)) revert TransferFailed();
    }

    function _safeTransferFrom(address token, address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
