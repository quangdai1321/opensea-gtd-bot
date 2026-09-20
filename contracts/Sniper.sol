// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * Sniper: mint nhieu suat SeaDrop trong MOT giao dich.
 *
 * Contract "nha may" sinh ra cac vi con dung mot lan (Minion). Moi Minion la mot dia chi rieng
 * nen tinh la mot vi truoc gioi han "toi da N cai / vi" cua SeaDrop. Minion mint xong thi
 * CHUYEN NGAY NFT ve vi cua ban, van trong cung giao dich do.
 *
 * SeaDrop dung _safeMint -> ERC721A goi onERC721Received tren Minion (da co code) -> biet token id.
 *
 * CANH BAO: cach nay lach gioi han moi vi. Nhieu du an coi day la sybil va loai cac vi lien quan
 * khoi whitelist / airdrop, va dieu khoan OpenSea cam thao tung gioi han mint. Tu can nhac.
 */

interface ISeaDrop {
    function mintPublic(
        address nftContract,
        address feeRecipient,
        address minterIfNotPayer,
        uint256 quantity
    ) external payable;
}

interface IERC721 {
    function transferFrom(address from, address to, uint256 tokenId) external;
}

/** Vi con dung mot lan: mint roi chuyen het NFT ve `to`. */
contract Minion {
    address private nft;
    bool private used;
    uint256[] private ids;

    function run(
        address seaDrop,
        address nftContract,
        address feeRecipient,
        uint256 quantity,
        address to
    ) external payable {
        require(!used, "used");
        used = true;
        nft = nftContract;

        ISeaDrop(seaDrop).mintPublic{value: msg.value}(nftContract, feeRecipient, address(0), quantity);

        uint256 n = ids.length;
        require(n > 0, "no token");
        for (uint256 i; i < n; ++i) {
            IERC721(nftContract).transferFrom(address(this), to, ids[i]);
        }
    }

    /** ERC721A goi ham nay cho tung token vua mint -> ghi lai id */
    function onERC721Received(address, address, uint256 tokenId, bytes calldata) external returns (bytes4) {
        require(msg.sender == nft, "only nft");
        ids.push(tokenId);
        return this.onERC721Received.selector;
    }
}

contract Sniper {
    address public immutable owner;

    event Sniped(uint256 requested, uint256 minted);

    constructor() {
        owner = msg.sender;
    }

    /**
     * @param count So vi con (= so suat muon lay).
     * @param quantity So NFT moi vi con mint (thuong = gioi han moi vi cua drop).
     * @param to Vi nhan NFT.
     * msg.value = gia mint x quantity x count. Tien thua tra lai owner.
     */
    function snipe(
        address seaDrop,
        address nftContract,
        address feeRecipient,
        uint256 quantity,
        uint256 count,
        address to
    ) external payable returns (uint256 minted) {
        require(msg.sender == owner, "not owner");
        require(count > 0, "count 0");
        uint256 each = msg.value / count;

        for (uint256 i; i < count; ++i) {
            Minion m = new Minion();
            // Het hang / dong stage giua chung -> dung lai, khong dot gas cho cac vi con lai
            try m.run{value: each}(seaDrop, nftContract, feeRecipient, quantity, to) {
                unchecked { ++minted; }
            } catch {
                break;
            }
        }

        emit Sniped(count, minted);
        uint256 left = address(this).balance;
        if (left > 0) {
            (bool ok, ) = payable(owner).call{value: left}("");
            require(ok, "refund failed");
        }
    }

    /** Rut tien ke ca khi co ai do gui nham vao day */
    function withdraw() external {
        require(msg.sender == owner, "not owner");
        (bool ok, ) = payable(owner).call{value: address(this).balance}("");
        require(ok, "withdraw failed");
    }

    receive() external payable {}
}
