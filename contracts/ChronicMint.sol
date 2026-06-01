// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// $CHRONIC Community Mint — anyone mints their own NFT.
// Each token carries its own tokenURI (the minter's art/metadata) and an
// ERC-2981 royalty that pays the original creator on every resale.
//
// OpenZeppelin v5. Deploy on Monad mainnet (chainId 143) via Remix.

import "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import "@openzeppelin/contracts/token/common/ERC2981.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract ChronicMint is ERC721URIStorage, ERC2981, Ownable, ReentrancyGuard {
    uint256 public nextId = 1;          // token ids start at 1
    uint256 public mintFee;             // in wei (MON). 0 = free (pay only gas)
    uint96  public creatorRoyaltyBps;   // resale royalty to the minter, e.g. 500 = 5%
    address public feeRecipient;        // where mint fees go (buyback/treasury)

    event Minted(uint256 indexed id, address indexed creator, string uri);

    constructor(address _feeRecipient)
        ERC721("Chronic Community", "CHRONICC")
        Ownable(msg.sender)
    {
        require(_feeRecipient != address(0), "recipient");
        feeRecipient = _feeRecipient;
        creatorRoyaltyBps = 500; // 5% default
    }

    /// Mint your own NFT. `uri` points to your metadata JSON.
    function mint(string calldata uri) external payable nonReentrant returns (uint256 id) {
        require(msg.value >= mintFee, "fee");
        id = nextId++;
        _safeMint(msg.sender, id);
        _setTokenURI(id, uri);
        _setTokenRoyalty(id, msg.sender, creatorRoyaltyBps); // creator earns on resales
        if (msg.value > 0) {
            (bool ok, ) = payable(feeRecipient).call{value: msg.value}("");
            require(ok, "fee xfer");
        }
        emit Minted(id, msg.sender, uri);
    }

    // --- admin ---
    function setMintFee(uint256 wei_) external onlyOwner { mintFee = wei_; }
    function setFeeRecipient(address r) external onlyOwner { require(r != address(0)); feeRecipient = r; }
    function setCreatorRoyalty(uint96 bps) external onlyOwner { require(bps <= 1000, "max 10%"); creatorRoyaltyBps = bps; }

    function totalMinted() external view returns (uint256) { return nextId - 1; }

    // --- required overrides ---
    function supportsInterface(bytes4 id)
        public view override(ERC721URIStorage, ERC2981) returns (bool)
    { return super.supportsInterface(id); }
}
