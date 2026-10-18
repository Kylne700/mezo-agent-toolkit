// Minimal hand-written ABIs (read from the verified contracts on the Mezo testnet explorer). No vendor packages.
import { parseAbi } from 'viem'

export const erc20Abi = parseAbi([
  'function name() view returns (string)',
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
  'function totalSupply() view returns (uint256)',
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
])

// Solidly/Velodrome-style router used by Mezo (poolRouter). A route is (from, to, stable, factory).
export const routerAbi = parseAbi([
  'function defaultFactory() view returns (address)',
  'function poolFor(address tokenA, address tokenB, bool stable, address factory) view returns (address)',
  'function getReserves(address tokenA, address tokenB, bool stable, address factory) view returns (uint256 reserveA, uint256 reserveB)',
  'function getAmountsOut(uint256 amountIn, (address from, address to, bool stable, address factory)[] routes) view returns (uint256[] amounts)',
  'function swapExactTokensForTokens(uint256 amountIn, uint256 amountOutMin, (address from, address to, bool stable, address factory)[] routes, address to, uint256 deadline) returns (uint256[] amounts)',
])

// Direct-read ABIs for the protocol contracts the lens wraps. The smoke and MCP session scripts read these without the lens and compare.
export const troveManagerAbi = parseAbi([
  'function MCR() view returns (uint256)',
  'function CCR() view returns (uint256)',
  'function MUSD_GAS_COMPENSATION() view returns (uint256)',
  'function getTroveStatus(address borrower) view returns (uint8)',
  'function getEntireDebtAndColl(address borrower) view returns (uint256 coll, uint256 principal, uint256 interest, uint256 pendingCollateral, uint256 pendingPrincipal, uint256 pendingInterest)',
  'function getTCR(uint256 price) view returns (uint256)',
  'function getEntireSystemColl() view returns (uint256)',
  'function getEntireSystemDebt() view returns (uint256)',
  'function checkRecoveryMode(uint256 price) view returns (bool)',
])

export const sortedTrovesAbi = parseAbi([
  'function getFirst() view returns (address)',
  'function getLast() view returns (address)',
  'function getPrev(address id) view returns (address)',
  'function getSize() view returns (uint256)',
  'function contains(address id) view returns (bool)',
])

export const priceFeedAbi = parseAbi(['function fetchPrice() view returns (uint256)'])

export const hintHelpersAbi = parseAbi([
  'function getRedemptionHints(uint256 _amount, uint256 _price, uint256 _maxIterations) view returns (address firstRedemptionHint, uint256 partialRedemptionHintNICR, uint256 truncatedAmount)',
])

// veBTC and veMEZO are Solidly-style vote escrows; veMEZO has one more field in its lock record and a different voting power getter.
export const veBtcAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerToNFTokenIdList(address owner, uint256 index) view returns (uint256)',
  'function locked(uint256 tokenId) view returns ((int128 amount, uint256 end, bool isPermanent))',
  'function balanceOfNFT(uint256 tokenId) view returns (uint256)',
  'function voted(uint256 tokenId) view returns (bool)',
])

export const veMezoAbi = parseAbi([
  'function balanceOf(address owner) view returns (uint256)',
  'function ownerToNFTokenIdList(address owner, uint256 index) view returns (uint256)',
  'function locked(uint256 tokenId) view returns ((int128 amount, uint256 end, bool isPermanent, uint256 boost))',
  'function votingPowerOfNFT(uint256 tokenId) view returns (uint256)',
  'function voted(uint256 tokenId) view returns (bool)',
])
