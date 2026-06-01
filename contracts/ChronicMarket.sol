// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// $CHRONIC Marketplace — list any ERC721, buy with MON, cancel anytime.
// Trustless: the NFT stays in the seller's wallet (escrowless) and only
// moves on a successful buy. Seller must approve this contract first.
// Pays ERC-2981 creator royalty + a platform fee, remainder to the seller.
//
// Works for ChronicMint tokens, the Strain Vault, the Chronic art set, or
// any ERC721 on Monad. OpenZeppelin v5. Deploy on chainId 143 via Remix.

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/interfaces/IERC2981.sol";
import "@openzeppelin/contracts/utils/introspection/IERC165.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ChronicMarket is Ownable, ReentrancyGuard {
    struct Listing { address seller; uint256 price; }

    // nft => tokenId => listing
    mapping(address => mapping(uint256 => Listing)) public listings;

    uint96  public platformFeeBps; // e.g. 250 = 2.5%
    address public feeRecipient;   // buyback/treasury

    event Listed(address indexed nft, uint256 indexed id, address indexed seller, uint256 price);
    event Cancelled(address indexed nft, uint256 indexed id);
    event Sold(address indexed nft, uint256 indexed id, address seller, address buyer, uint256 price);

    constructor(address _feeRecipient) Ownable(msg.sender) {
        require(_feeRecipient != address(0), "recipient");
        feeRecipient = _feeRecipient;
        platformFeeBps = 250; // 2.5% default
    }

    function list(address nft, uint256 id, uint256 price) external {
        require(price > 0, "price");
        require(IERC721(nft).ownerOf(id) == msg.sender, "not owner");
        require(
            IERC721(nft).getApproved(id) == address(this) ||
            IERC721(nft).isApprovedForAll(msg.sender, address(this)),
            "approve market"
        );
        listings[nft][id] = Listing(msg.sender, price);
        emit Listed(nft, id, msg.sender, price);
    }

    function cancel(address nft, uint256 id) external {
        require(listings[nft][id].seller == msg.sender, "not seller");
        delete listings[nft][id];
        emit Cancelled(nft, id);
    }

    function buy(address nft, uint256 id) external payable nonReentrant {
        Listing memory l = listings[nft][id];
        require(l.seller != address(0), "not listed");
        require(msg.value == l.price, "bad price");
        require(IERC721(nft).ownerOf(id) == l.seller, "seller moved nft");

        // effects first
        delete listings[nft][id];

        // split: royalty -> creator, platform fee -> treasury, rest -> seller
        uint256 remaining = msg.value;

        (address royaltyTo, uint256 royaltyAmt) = _royalty(nft, id, msg.value);
        if (royaltyAmt > 0 && royaltyTo != address(0) && royaltyTo != l.seller) {
            remaining -= royaltyAmt;
            _pay(royaltyTo, royaltyAmt);
        }

        uint256 fee = (msg.value * platformFeeBps) / 10000;
        if (fee > 0) { remaining -= fee; _pay(feeRecipient, fee); }

        // interactions: move NFT, then pay seller
        IERC721(nft).safeTransferFrom(l.seller, msg.sender, id);
        _pay(l.seller, remaining);

        emit Sold(nft, id, l.seller, msg.sender, msg.value);
    }

    function _royalty(address nft, uint256 id, uint256 price)
        internal view returns (address, uint256)
    {
        try IERC165(nft).supportsInterface(type(IERC2981).interfaceId) returns (bool ok) {
            if (!ok) return (address(0), 0);
        } catch { return (address(0), 0); }
        try IERC2981(nft).royaltyInfo(id, price) returns (address r, uint256 a) {
            if (a >= price) return (address(0), 0); // sanity
            return (r, a);
        } catch { return (address(0), 0); }
    }

    function _pay(address to, uint256 amt) internal {
        (bool ok, ) = payable(to).call{value: amt}("");
        require(ok, "pay fail");
    }

    // --- admin ---
    function setPlatformFee(uint96 bps) external onlyOwner { require(bps <= 1000, "max 10%"); platformFeeBps = bps; }
    function setFeeRecipient(address r) external onlyOwner { require(r != address(0)); feeRecipient = r; }
}
